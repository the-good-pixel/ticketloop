// Catalog storage + resolution.
//
// Resolution order (later wins for the SAME id@version, which only happens for
// an imported bundle shadowing a built-in — a case we reject rather than allow):
//   1. built-in     — shipped in code, immutable, always present
//   2. imported     — ~/.ticketloop/catalog/imports/<bundle>/…
//   3. user         — ~/.ticketloop/catalog/{steps,workflows}/<id>/<version>.yml
//
// A published version is IMMUTABLE. Saving over an existing file is refused;
// editing means saving a new version. That is what lets a run's snapshot stay
// meaningful for as long as the run lives.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { CATALOG_IMPORTS_DIR, CATALOG_STEPS_DIR, CATALOG_WORKFLOWS_DIR } from '../paths.js'
import { BUILTIN_STEPS } from './builtin-steps.js'
import { BUILTIN_WORKFLOWS } from './builtin-workflows.js'
import type { CatalogStep, Workflow } from './types.js'

export type CatalogScope = 'builtin' | 'imported' | 'user'

export interface Ref {
  id: string
  version: number
}

/** Parse "triage@2". A missing version means "the highest available". */
export function parseRef(ref: string): { id: string; version?: number } {
  const at = ref.lastIndexOf('@')
  if (at < 0) return { id: ref.trim() }
  const version = Number(ref.slice(at + 1))
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`invalid step/workflow reference "${ref}" — expected "<id>@<version>"`)
  return { id: ref.slice(0, at).trim(), version }
}

export const formatRef = (r: { id: string; version: number }) => `${r.id}@${r.version}`

function readYamlDir<T>(root: string, scope: CatalogScope): { item: T; scope: CatalogScope }[] {
  if (!existsSync(root)) return []
  const out: { item: T; scope: CatalogScope }[] = []
  for (const id of readdirSync(root, { withFileTypes: true })) {
    if (!id.isDirectory()) continue
    for (const f of readdirSync(join(root, id.name))) {
      if (!/\.ya?ml$/.test(f)) continue
      try {
        const item = parse(readFileSync(join(root, id.name, f), 'utf8')) as T
        if (item) out.push({ item, scope })
      } catch (e) {
        throw new Error(`catalog: cannot read ${join(root, id.name, f)} — ${e}`)
      }
    }
  }
  return out
}

// Imported bundles keep the same layout one level down, per bundle id.
function readImports<T>(kind: 'steps' | 'workflows'): { item: T; scope: CatalogScope }[] {
  if (!existsSync(CATALOG_IMPORTS_DIR)) return []
  const out: { item: T; scope: CatalogScope }[] = []
  for (const bundle of readdirSync(CATALOG_IMPORTS_DIR, { withFileTypes: true })) {
    if (!bundle.isDirectory()) continue
    out.push(...readYamlDir<T>(join(CATALOG_IMPORTS_DIR, bundle.name, kind), 'imported'))
  }
  return out
}

export interface CatalogEntry<T> {
  item: T
  scope: CatalogScope
}

function index<T extends { id: string; version: number }>(
  entries: CatalogEntry<T>[],
  label: string,
): Map<string, CatalogEntry<T>> {
  const map = new Map<string, CatalogEntry<T>>()
  for (const e of entries) {
    if (!e.item?.id || !Number.isInteger(e.item?.version))
      throw new Error(`catalog: a ${label} is missing "id" or an integer "version"`)
    const key = formatRef(e.item)
    const prior = map.get(key)
    // A built-in version is authoritative — shadowing one would silently change
    // what every existing run's snapshot means.
    if (prior?.scope === 'builtin')
      throw new Error(`catalog: ${label} "${key}" is built-in and cannot be overridden by a ${e.scope} definition`)
    if (prior)
      throw new Error(`catalog: ${label} "${key}" is defined twice (${prior.scope} and ${e.scope})`)
    map.set(key, e)
  }
  return map
}

export interface Catalog {
  steps: Map<string, CatalogEntry<CatalogStep>>
  workflows: Map<string, CatalogEntry<Workflow>>
}

/** Load the whole catalog: built-ins plus anything the user created or imported. */
export function loadCatalog(): Catalog {
  const steps = index<CatalogStep>(
    [
      ...BUILTIN_STEPS.map((item) => ({ item, scope: 'builtin' as const })),
      ...readImports<CatalogStep>('steps'),
      ...readYamlDir<CatalogStep>(CATALOG_STEPS_DIR, 'user'),
    ],
    'step',
  )
  const workflows = index<Workflow>(
    [
      ...BUILTIN_WORKFLOWS.map((item) => ({ item, scope: 'builtin' as const })),
      ...readImports<Workflow>('workflows'),
      ...readYamlDir<Workflow>(CATALOG_WORKFLOWS_DIR, 'user'),
    ],
    'workflow',
  )
  return { steps, workflows }
}

function highest<T extends { version: number }>(
  map: Map<string, CatalogEntry<T>>,
  id: string,
): CatalogEntry<T> | undefined {
  let best: CatalogEntry<T> | undefined
  for (const [key, e] of map) {
    if (key.slice(0, key.lastIndexOf('@')) !== id) continue
    if (!best || e.item.version > best.item.version) best = e
  }
  return best
}

export function getStep(cat: Catalog, ref: string): CatalogStep {
  const { id, version } = parseRef(ref)
  const e = version ? cat.steps.get(`${id}@${version}`) : highest(cat.steps, id)
  if (!e) throw new Error(`unknown step "${ref}"`)
  return e.item
}

export function getWorkflow(cat: Catalog, ref: string): Workflow {
  const { id, version } = parseRef(ref)
  const e = version ? cat.workflows.get(`${id}@${version}`) : highest(cat.workflows, id)
  if (!e) throw new Error(`unknown workflow "${ref}"`)
  return e.item
}

export function scopeOf(cat: Catalog, kind: 'steps' | 'workflows', ref: string): CatalogScope | undefined {
  const { id, version } = parseRef(ref)
  const map = kind === 'steps' ? cat.steps : cat.workflows
  const e = version ? map.get(`${id}@${version}`) : highest(map as any, id)
  return e?.scope
}

/** The next free version for an id, so "clone and edit" never collides. */
export function nextVersion(cat: Catalog, kind: 'steps' | 'workflows', id: string): number {
  const map = kind === 'steps' ? cat.steps : cat.workflows
  const best = highest(map as any, id)
  return best ? best.item.version + 1 : 1
}

function writeImmutable(dir: string, id: string, version: number, body: unknown, label: string): string {
  const file = join(dir, id, `${version}.yml`)
  if (existsSync(file))
    throw new Error(`${label} "${id}@${version}" already exists — published versions are immutable, save a new version`)
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(file, stringify(body))
  return file
}

export function saveStep(step: CatalogStep): string {
  if (step.builtin) throw new Error(`step "${step.id}" is built-in and cannot be saved over — clone it instead`)
  return writeImmutable(CATALOG_STEPS_DIR, step.id, step.version, step, 'step')
}

export function saveWorkflow(wf: Workflow): string {
  if (wf.builtin) throw new Error(`workflow "${wf.id}" is built-in and cannot be saved over — clone it instead`)
  return writeImmutable(CATALOG_WORKFLOWS_DIR, wf.id, wf.version, wf, 'workflow')
}

/**
 * Copy a built-in (or any) step/workflow into the user catalog at the next free
 * version, ready to edit. This is how a user customizes without starting blank.
 */
export function cloneStep(cat: Catalog, ref: string, newId?: string): CatalogStep {
  const src = getStep(cat, ref)
  const id = newId || src.id
  return { ...structuredClone(src), id, version: nextVersion(cat, 'steps', id), builtin: false }
}

export function cloneWorkflow(cat: Catalog, ref: string, newId?: string): Workflow {
  const src = getWorkflow(cat, ref)
  const id = newId || src.id
  return { ...structuredClone(src), id, version: nextVersion(cat, 'workflows', id), builtin: false }
}
