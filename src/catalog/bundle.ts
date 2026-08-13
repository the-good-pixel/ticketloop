// Bundle export / import — sharing steps and workflows between people.
//
// A bundle is plain YAML with a checksum. It is NOT trusted content: an imported
// step carries an instruction that will be handed to a coding agent running with
// permissions skipped, and may name a skill, request tools, or declare external
// effects. So import is a two-step act — INSPECT, then accept — and the trust
// summary is built from the bundle's own declarations so a reviewer sees what
// they are agreeing to before anything touches disk.
//
// Importing never grants authority. A step may REQUEST `deployDev`; only the
// project's own permissions block can grant it, and validation still refuses to
// run a plan whose steps ask for more than the project allows.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { CATALOG_IMPORTS_DIR } from '../paths.js'
import { formatRef, getStep, getWorkflow, type Catalog } from './store.js'
import type { CatalogStep, ExternalEffect, Permission, Workflow } from './types.js'

export interface BundleManifest {
  id: string
  name: string
  description?: string
  createdAt: string
  /** sha256 over the canonical JSON of `steps` + `workflows`. */
  checksum: string
  steps: string[] // refs
  workflows: string[] // refs
}

export interface Bundle {
  manifest: BundleManifest
  steps: CatalogStep[]
  workflows: Workflow[]
}

function checksum(steps: CatalogStep[], workflows: Workflow[]): string {
  // Sort by ref so the same content always hashes the same, whatever order the
  // caller listed things in.
  const canon = JSON.stringify({
    steps: [...steps].sort((a, b) => formatRef(a).localeCompare(formatRef(b))),
    workflows: [...workflows].sort((a, b) => formatRef(a).localeCompare(formatRef(b))),
  })
  return createHash('sha256').update(canon).digest('hex')
}

export interface ExportOpts {
  id: string
  name?: string
  description?: string
  stepRefs?: string[]
  workflowRefs?: string[]
  /** Pull in every step a listed workflow references, so the bundle is complete. */
  includeDependencies?: boolean
  /** Timestamp to stamp; injected so callers can keep output reproducible. */
  now?: string
}

/** Collect the step refs a workflow's phases mention, at any depth. */
export function stepRefsOf(wf: Workflow): string[] {
  const refs = new Set<string>()
  const walk = (phases: unknown[]): void => {
    for (const p of phases as Record<string, any>[]) {
      if (!p) continue
      if (p.step) refs.add(p.step)
      if (p.branch) {
        for (const list of Object.values(p.branch.cases || {})) walk(list as unknown[])
        if (Array.isArray(p.branch.default)) walk(p.branch.default)
      }
      if (p.loop) walk([p.loop.repair, ...(p.loop.gates || [])])
    }
  }
  walk(wf.phases || [])
  walk(wf.finally || [])
  return [...refs]
}

export function exportBundle(cat: Catalog, o: ExportOpts): Bundle {
  const workflows = (o.workflowRefs || []).map((r) => getWorkflow(cat, r))
  const stepRefs = new Set(o.stepRefs || [])
  if (o.includeDependencies !== false) {
    for (const wf of workflows) for (const ref of stepRefsOf(wf)) stepRefs.add(ref)
  }
  const steps = [...stepRefs].map((r) => getStep(cat, r))
  if (!steps.length && !workflows.length)
    throw new Error('nothing to export — name at least one step or workflow')
  // Built-ins ship with ticketloop, so including them would only create import
  // conflicts on the other side.
  const shipped = [...steps, ...workflows].filter((x) => x.builtin).map((x) => formatRef(x))
  const ownSteps = steps.filter((s) => !s.builtin)
  const ownWorkflows = workflows.filter((w) => !w.builtin)
  if (!ownSteps.length && !ownWorkflows.length)
    throw new Error(`only built-ins selected (${shipped.join(', ')}) — those ship with ticketloop already`)

  return {
    manifest: {
      id: o.id,
      name: o.name || o.id,
      description: o.description,
      createdAt: o.now || new Date().toISOString(),
      checksum: checksum(ownSteps, ownWorkflows),
      steps: ownSteps.map(formatRef),
      workflows: ownWorkflows.map(formatRef),
    },
    steps: ownSteps,
    workflows: ownWorkflows,
  }
}

export const serializeBundle = (b: Bundle) => stringify(b)

// ---- import ----------------------------------------------------------------

export interface TrustReport {
  /** Everything in the bundle that reaches outside the local worktree. */
  externalEffects: { ref: string; effects: ExternalEffect[] }[]
  /** Authority the bundle asks for. Import does not grant any of it. */
  requestedPermissions: { ref: string; permissions: Permission[] }[]
  /** Skills and tool grants the steps name — these run with permissions skipped. */
  skills: { ref: string; skills: string[] }[]
  tools: { ref: string; allowedTools: string }[]
  /** Steps that may modify a repo. */
  mutating: string[]
  checksumOk: boolean
  /** Refs that already exist locally and would collide. */
  conflicts: string[]
  errors: string[]
}

export function parseBundle(raw: string): Bundle {
  const b = parse(raw) as Bundle
  if (!b?.manifest?.id) throw new Error('not a ticketloop bundle (no manifest.id)')
  b.steps = b.steps || []
  b.workflows = b.workflows || []
  return b
}

/** Everything a human should see BEFORE agreeing to an import. */
export function inspectBundle(cat: Catalog, b: Bundle): TrustReport {
  const report: TrustReport = {
    externalEffects: [],
    requestedPermissions: [],
    skills: [],
    tools: [],
    mutating: [],
    checksumOk: checksum(b.steps, b.workflows) === b.manifest.checksum,
    conflicts: [],
    errors: [],
  }
  for (const s of b.steps) {
    const ref = formatRef(s)
    if (s.capabilities?.externalEffects?.length)
      report.externalEffects.push({ ref, effects: s.capabilities.externalEffects })
    if (s.requiresPermissions?.length)
      report.requestedPermissions.push({ ref, permissions: s.requiresPermissions })
    const skills = [s.defaults?.skill, ...Object.values(s.skills || {})].filter(Boolean) as string[]
    if (skills.length) report.skills.push({ ref, skills: [...new Set(skills)] })
    if (s.defaults?.allowedTools) report.tools.push({ ref, allowedTools: s.defaults.allowedTools })
    if (s.capabilities?.mutatesRepo) report.mutating.push(ref)
    if (cat.steps.has(ref)) report.conflicts.push(ref)
    if (cat.steps.get(ref)?.scope === 'builtin')
      report.errors.push(`step "${ref}" collides with a built-in version — built-ins are immutable`)
  }
  for (const w of b.workflows) {
    const ref = formatRef(w)
    if (cat.workflows.has(ref)) report.conflicts.push(ref)
    if (cat.workflows.get(ref)?.scope === 'builtin')
      report.errors.push(`workflow "${ref}" collides with a built-in version — built-ins are immutable`)
    // Every step a workflow needs must be in the bundle or already installed.
    for (const need of stepRefsOf(w)) {
      const bundled = b.steps.find((s) => formatRef(s) === need)
      if (!bundled && !cat.steps.has(need)) {
        report.errors.push(`workflow "${ref}" needs step "${need}", which is neither in the bundle nor installed`)
        continue
      }
      // A workflow made only of LOCAL steps still does everything those steps
      // do. Reporting "nothing beyond reading" because the bundle happened to
      // carry no step definitions would be exactly the wrong answer.
      if (bundled) continue
      const local = cat.steps.get(need)!.item
      if (local.capabilities?.externalEffects?.length)
        report.externalEffects.push({ ref: `${need} (via ${ref})`, effects: local.capabilities.externalEffects })
      if (local.requiresPermissions?.length)
        report.requestedPermissions.push({ ref: `${need} (via ${ref})`, permissions: local.requiresPermissions })
      if (local.capabilities?.mutatesRepo) report.mutating.push(`${need} (via ${ref})`)
    }
  }
  if (!report.checksumOk)
    report.errors.push('checksum does not match the contents — the bundle was modified after it was exported')
  return report
}

export interface ImportResult {
  written: string[]
  skipped: string[]
}

/**
 * Write a bundle into `~/.ticketloop/catalog/imports/<bundle-id>/`. Kept in its
 * own directory so an import is always reversible by deleting one folder, and so
 * the catalog listing can show where a definition came from.
 */
export function importBundle(cat: Catalog, b: Bundle, o: { acceptChecksumMismatch?: boolean } = {}): ImportResult {
  const report = inspectBundle(cat, b)
  const fatal = report.errors.filter(
    (e) => o.acceptChecksumMismatch ? !e.startsWith('checksum') : true,
  )
  if (fatal.length) throw new Error(`refusing to import: ${fatal.join('; ')}`)

  const root = join(CATALOG_IMPORTS_DIR, b.manifest.id)
  const written: string[] = []
  const skipped: string[] = []
  const write = (kind: 'steps' | 'workflows', item: CatalogStep | Workflow) => {
    const ref = formatRef(item)
    // An identical ref already installed is left alone: published versions are
    // immutable, so re-importing the same version is a no-op, not an overwrite.
    if ((kind === 'steps' ? cat.steps : cat.workflows).has(ref)) {
      skipped.push(ref)
      return
    }
    const dir = join(root, kind, item.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${item.version}.yml`), stringify({ ...item, builtin: false }))
    written.push(ref)
  }
  for (const s of b.steps) write('steps', s)
  for (const w of b.workflows) write('workflows', w)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'manifest.yml'), stringify(b.manifest))
  return { written, skipped }
}
