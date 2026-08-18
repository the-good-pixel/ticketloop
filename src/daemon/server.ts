import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, extname } from 'node:path'
import type { Config, ProjectConfig, WaitBlocker } from '../types.js'
import { STAGE_ORDER } from '../types.js'
import { Governor } from '../governor/governor.js'
import { readRuns, getRun } from '../store.js'
import { assertAuthSafe } from '../runner/index.js'
import { resolveTracker, DEFAULT_INSTRUCTIONS } from '../config.js'
import { hasCredential, resolveTrackerKey } from '../credentials.js'
import { isPaused, setPaused, setTicketPaused, setTicketIgnored, pausedTickets } from './control.js'
import { WORKTREE_SYSTEM_STEPS } from '../loop/workspace.js'
import {
  cloneStep,
  cloneWorkflow,
  formatRef,
  getStep,
  getWorkflow,
  loadCatalog,
  nextVersion,
  saveStep,
  saveWorkflow,
} from '../catalog/store.js'
import { compileWorkflow } from '../catalog/compile.js'
import { planForProject, DEFAULT_WORKFLOW_REF } from '../commands/catalog.js'
import type { CatalogStep, Workflow } from '../catalog/types.js'
import { ALL_PERMISSIONS } from '../catalog/types.js'
import { log } from '../logger.js'
import { legacyWaitKind } from '../waiting.js'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/**
 * Seed a project workflow with the project-specific settings that previously
 * lived in `projects[].stages`. The visual draft then owns the same custom
 * instructions people were already running; saving it does not reset them to
 * the template defaults.
 */
function applyProjectStageOverrides(workflow: Workflow, project: ProjectConfig): Workflow {
  const copy = structuredClone(workflow)
  const applyStep = (node: any) => {
    if (!node?.step) return
    const stepId = String(node.step).split('@')[0] as keyof NonNullable<ProjectConfig['stages']>
    const stage = project.stages?.[stepId]
    node.overrides = { ...(stage || {}), ...(node.overrides || {}), enabled: true }
  }
  const visit = (phases: any[]) => {
    for (const phase of phases || []) {
      if (phase.step) applyStep(phase)
      if (phase.loop) {
        applyStep(phase.loop.repair)
        for (const gate of phase.loop.gates || []) applyStep(gate)
      }
      if (phase.branch) {
        for (const route of Object.values(phase.branch.cases || {})) visit(route as any[])
        if (Array.isArray(phase.branch.default)) visit(phase.branch.default)
      }
    }
  }
  visit(copy.phases)
  for (const node of copy.finally || []) applyStep(node)
  return copy
}

export interface ServerHooks {
  scanNow: () => Promise<{ processed: number }>
  status: () => {
    running: boolean
    lastScan?: number
    nextScan?: number
    scanning?: boolean
    scanDone?: number
    scanTotal?: number
    activeTicket?: string
    activeProject?: string
    activeRuns?: { project: string; ticket: string }[]
    pausedTickets?: string[]
    ignoredTickets?: { ticketKey: string; at: number; reason?: string }[]
    stoppingTickets?: string[]
    resumableTickets?: { key: string; outcome: string; attempts: number; canResume: boolean; blocker?: WaitBlocker }[]
  }
  // project setup (UI-driven); these persist config / credentials on disk
  saveProject: (p: ProjectConfig) => { ok: true } | { error: string }
  removeProject: (name: string) => { ok: true } | { error: string }
  setKey: (project: string, key: string) => { ok: true } | { error: string }
  // Edit the global (non-project) settings from the dashboard.
  saveSettings: (patch: Record<string, unknown>) => { ok: true } | { error: string }
  // Continue a resumable ticket now; `fresh` discards its resume checkpoint.
  retryTicket: (ticketKey: string, fresh: boolean) => { ok: true } | { error: string }
  // Stop a ticket's run immediately (kills its agent), and/or mark it
  // never-process. Both are independent — either, or both together.
  stopTicket: (ticketKey: string, opts: { ignore?: boolean; reason?: string }) => {
    stopped: boolean
    killed: number
    ignored: boolean
  }
}

// Selectable models for the per-step dropdown. Aliases (opus/sonnet/haiku)
// always resolve to the latest of that tier; the dated/specific IDs pin a version.
const MODELS: Record<string, { label: string; value: string }[]> = {
  claude: [
    { label: 'Opus 4.8', value: 'claude-opus-4-8' },
    { label: 'Opus (latest)', value: 'opus' },
    { label: 'Sonnet (latest)', value: 'sonnet' },
    { label: 'Haiku (latest)', value: 'haiku' },
  ],
  codex: [
    { label: 'GPT-5.6 Sol', value: 'gpt-5.6-sol' },
    { label: 'GPT-5.6 Terra', value: 'gpt-5.6-terra' },
    { label: 'GPT-5.6 Luna', value: 'gpt-5.6-luna' },
  ],
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function toolExists(bin: string, args: string[]): boolean {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  return (r.status ?? 1) === 0
}

let toolingCache: { claude: boolean; codex: boolean; gh: boolean; git: boolean } | null = null
function tooling(cfg: Config) {
  if (!toolingCache) {
    toolingCache = {
      claude: toolExists(cfg.runner.providers.claude.bin, ['--version']),
      codex: toolExists(cfg.runner.providers.codex.bin, ['--version']),
      gh: toolExists('gh', ['--version']),
      git: toolExists('git', ['--version']),
    }
  }
  return toolingCache
}

const OUTCOMES = ['answered', 'exported', 'pr-opened', 'pr-opened-with-findings', 'deployed', 'partial', 'merged', 'skipped', 'cancelled', 'blocked', 'waiting', 'paused', 'failed', 'running']

function parseDate(v: string | null, endOfDay = false): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v) // epoch ms
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (endOfDay) d.setHours(23, 59, 59, 999)
    return d.getTime()
  }
  return null
}

/** Filter/sort/paginate the run index for the History view. */
function queryHistory(p: URLSearchParams) {
  const projects = p.getAll('project')
  const outcomes = p.getAll('outcome')
  const ticket = (p.get('ticket') || '').toLowerCase()
  const q = (p.get('q') || '').toLowerCase().slice(0, 200)
  const from = parseDate(p.get('from'))
  const to = parseDate(p.get('to'), true)
  const sort = p.get('sort') || 'started_desc'
  const limit = Math.min(200, Math.max(1, Number(p.get('limit') || 25)))
  const offset = Math.max(0, Number(p.get('offset') || 0))

  let runs = readRuns() // lite summaries from the in-memory index
  if (projects.length) runs = runs.filter((r) => projects.includes(r.project))
  if (outcomes.length) {
    runs = runs.filter((r) =>
      outcomes.includes(r.outcome) ||
      outcomes.some((outcome) => r.outcome === 'waiting' && r.blocker?.kind === legacyWaitKind(outcome)),
    )
  }
  if (ticket) runs = runs.filter((r) => r.ticket.toLowerCase().startsWith(ticket))
  if (q) runs = runs.filter((r) => (r.ticketTitle || '').toLowerCase().includes(q) || r.ticket.toLowerCase().includes(q))
  if (from != null) runs = runs.filter((r) => r.startedAt >= from)
  if (to != null) runs = runs.filter((r) => r.startedAt <= to)

  const dur = (r: (typeof runs)[number]) => (r.endedAt || Date.now()) - r.startedAt
  const sorters: Record<string, (a: any, b: any) => number> = {
    started_desc: (a, b) => b.startedAt - a.startedAt,
    started_asc: (a, b) => a.startedAt - b.startedAt,
    cost_desc: (a, b) => (b.costUsd || 0) - (a.costUsd || 0),
    tokens_desc: (a, b) => (b.totalTokens || 0) - (a.totalTokens || 0),
    duration_desc: (a, b) => dur(b) - dur(a),
  }
  runs.sort(sorters[sort] || sorters.started_desc)
  const total = runs.length
  return { total, limit, offset, sort, runs: runs.slice(offset, offset + limit) }
}

function historyFacets() {
  const runs = readRuns()
  const projects = [...new Set(runs.map((r) => r.project))].sort()
  let earliest = Infinity
  let latest = 0
  for (const r of runs) {
    if (r.startedAt < earliest) earliest = r.startedAt
    if (r.startedAt > latest) latest = r.startedAt
  }
  return {
    projects,
    outcomes: OUTCOMES,
    earliest: runs.length ? earliest : null,
    latest: runs.length ? latest : null,
  }
}


// ---- Catalog view builders --------------------------------------------------

/**
 * Everything the Workflows view needs in one payload: the catalog, which
 * projects use what, and each project's effective policy — so the UI can show
 * "this step needs deployDev, which this project has not granted" before the
 * user assigns anything.
 */
function buildCatalogView(cfg: Config) {
  const cat = loadCatalog()
  const steps = [...cat.steps.entries()].map(([ref, e]) => ({
    ref,
    scope: e.scope,
    id: e.item.id,
    version: e.item.version,
    name: e.item.name,
    description: e.item.description,
    contract: e.item.contract,
    routeFields: e.item.routeFields || [],
    capabilities: e.item.capabilities,
    requiresPermissions: e.item.requiresPermissions || [],
    resumePolicy: e.item.resumePolicy,
    produces: e.item.produces,
    consumes: e.item.consumes || [],
    requires: e.item.requires || [],
    defaults: e.item.defaults,
    editable: e.scope !== 'builtin',
  }))
  const workflows = [...cat.workflows.entries()].map(([ref, e]) => ({
    ref,
    scope: e.scope,
    id: e.item.id,
    version: e.item.version,
    name: e.item.name,
    description: e.item.description || '',
    usedBy: cfg.projects.filter((p) => (p.workflow || DEFAULT_WORKFLOW_REF) === ref).map((p) => p.name),
    editable: e.scope !== 'builtin',
  }))
  const projects = cfg.projects.map((p) => ({
    name: p.name,
    engine: p.engine || 'legacy',
    workflow: p.workflow || DEFAULT_WORKFLOW_REF,
    permissions: { ...(cfg.permissions || {}), ...(p.permissions || {}) },
  }))
  return {
    steps: steps.sort((a, b) => a.ref.localeCompare(b.ref)),
    workflows: workflows.sort((a, b) => a.ref.localeCompare(b.ref)),
    projects,
    permissions: ALL_PERMISSIONS,
    defaultWorkflow: DEFAULT_WORKFLOW_REF,
    defaultProvider: cfg.runner.defaultProvider,
    models: MODELS,
    efforts: EFFORTS,
  }
}

/** Compile a saved ref or an unsaved draft, optionally against a project. */
function previewPlan(cfg: Config, b: { workflow?: Workflow; ref?: string; project?: string }) {
  const cat = loadCatalog()
  const project = b.project ? cfg.projects.find((p) => p.name === b.project) : undefined
  try {
    const plan =
      b.workflow
        ? compileWorkflow(cat, b.workflow, {
            config: cfg,
            project,
            legacyStages: project ? [cfg.stages, project.stages || {}] : [cfg.stages],
          })
        : project && !b.ref
          ? planForProject(cfg, project, cat)
          : compileWorkflow(cat, getWorkflow(cat, b.ref || DEFAULT_WORKFLOW_REF), {
              config: cfg,
              project,
              legacyStages: project ? [cfg.stages, project.stages || {}] : [cfg.stages],
            })
    return {
      workflow: plan.workflow,
      digest: plan.digest,
      diagnostics: plan.diagnostics,
      permissions: plan.permissions,
      profiles: plan.profiles,
      outcomes: plan.outcomes,
      // A flat, display-ready trace. The tree lives in the UI's own copy of the
      // draft; this is the compiled truth to show beside it.
      tree: planTree(plan),
      finallyNodes: plan.finallyNodes.map((f) => ({
        id: f.id,
        ref: f.ref,
        runOn: f.runOn,
        enabled: f.settings.enabled,
      })),
      // Harness actions are not editable workflow data, but they are still part
      // of what every compiled workflow does. Expose them so templates and
      // project workflows never hide the deterministic worktree lifecycle.
      systemSteps: WORKTREE_SYSTEM_STEPS,
    }
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) }
  }
}

/**
 * The compiled plan as a TREE, not a flat list. The dashboard draws a diagram
 * from it, so the nesting (branch cases, loop bodies) has to survive the trip —
 * a depth-indented list is exactly what people could not read.
 */
type PlanNode = StepNodeView | StopNodeView | BranchNodeView | LoopNodeView

interface StepNodeView {
  kind: 'step'
  id: string
  ref: string
  name: string
  contract: string
  effects: string[]
  devOnly: boolean
  mutates: boolean
  perRepo: string
  enabled: boolean
  detail: string
  transitions: Record<string, string>
  badges: string[]
  problems: string[]
}

interface StopNodeView {
  kind: 'stop'
  id: string
  terminal: string
  outcome?: string
  reported: boolean
  note?: string
  problems: string[]
}

interface BranchNodeView {
  kind: 'branch'
  id: string
  on: { nodeId: string; field: string }
  cases: { name: string; phases: PlanNode[] }[]
  /** A branch whose default is a transition rather than its own phase list. */
  defaultTransition?: string
  problems: string[]
}

interface LoopNodeView {
  kind: 'loop'
  id: string
  maxIterations: number
  noProgress: string
  repair: PlanNode
  gates: PlanNode[]
  problems: string[]
}

function badgesFor(node: any): string[] {
  const out: string[] = []
  const s = node.settings
  const d = node.step.defaults || {}
  if (s.instruction !== node.step.instruction) out.push('custom instruction')
  if (s.skill !== (d.skill ?? null)) out.push(s.skill ? `skill: ${s.skill}` : 'no skill')
  if (s.model) out.push(`model: ${s.model}`)
  if (s.allowedTools !== (d.allowedTools ?? null)) out.push('custom tools')
  // Only when the node will actually run — a disabled node needs nothing.
  if (s.enabled && node.missingPermissions?.length) out.push(`needs ${node.missingPermissions.join(', ')}`)
  return out
}

function planTree(plan: ReturnType<typeof compileWorkflow>): PlanNode[] {
  const problemsFor = (id: string) =>
    plan.diagnostics.filter((d) => d.nodeId === id).map((d) => `${d.level}: ${d.message}`)

  const one = (p: any): PlanNode => {
    if (p.kind === 'step') {
      const s = p.settings
      return {
        kind: 'step',
        id: p.id,
        ref: p.ref,
        name: p.step.name,
        contract: p.step.contract,
        effects: p.step.capabilities.externalEffects,
        devOnly: p.step.capabilities.devOnly,
        mutates: p.step.capabilities.mutatesRepo,
        perRepo: p.step.capabilities.perRepo,
        enabled: s.enabled,
        detail: [s.profile, s.effort, s.model, s.skill ? '+skill:' + s.skill : ''].filter(Boolean).join(' · '),
        transitions: p.transitions,
        badges: badgesFor(p),
        problems: problemsFor(p.id),
      }
    }
    if (p.kind === 'stop') {
      return {
        kind: 'stop',
        id: p.id,
        terminal: p.terminal,
        outcome: p.outcome,
        reported: p.reported,
        note: p.note,
        problems: problemsFor(p.id),
      }
    }
    if (p.kind === 'branch') {
      const cases = Object.entries(p.cases).map(([name, list]) => ({ name, phases: (list as any[]).map(one) }))
      if (Array.isArray(p.default)) cases.push({ name: 'default', phases: p.default.map(one) })
      return {
        kind: 'branch',
        id: p.id,
        on: p.on,
        cases,
        defaultTransition: Array.isArray(p.default) ? undefined : p.default,
        problems: problemsFor(p.id),
      }
    }
    return {
      kind: 'loop',
      id: p.id,
      maxIterations: p.maxIterations,
      noProgress: p.noProgress,
      repair: one(p.repair),
      gates: p.gates.map(one),
      problems: problemsFor(p.id),
    }
  }
  return plan.phases.map(one)
}

export function startServer(cfg: Config, hooks: ServerHooks): { close: () => void } {
  const gov = new Governor(cfg)

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname

    try {
      if (path === '/api/status') return json(res, buildStatus(cfg, hooks))
      if (path === '/api/usage') {
        return json(res, { providers: gov.summary() })
      }
      if (path === '/api/activity') {
        const limit = Number(url.searchParams.get('limit') || 50)
        return json(res, readRuns(limit))
      }
      if (path.startsWith('/api/activity/')) {
        const id = decodeURIComponent(path.slice('/api/activity/'.length))
        const run = getRun(id)
        return run ? json(res, run) : notFound(res)
      }
      // ---- History (searchable archive) ----
      if (path === '/api/history' && req.method === 'GET') {
        return json(res, queryHistory(url.searchParams))
      }
      if (path === '/api/history/facets' && req.method === 'GET') {
        return json(res, historyFacets())
      }
      if (path === '/api/scan' && req.method === 'POST') {
        hooks.scanNow().then((r) => json(res, r)).catch((e) => serverError(res, e))
        return
      }
      // ---- Resume / restart a failed or paused ticket now ----
      if (path === '/api/retry' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { ticketKey?: string; fresh?: boolean }
          if (!b.ticketKey) return json(res, { error: 'ticketKey required' })
          json(res, hooks.retryTicket(b.ticketKey, !!b.fresh))
        }).catch((e) => serverError(res, e))
        return
      }
      // ---- Pause / resume — system-level (no ticketKey) or per-ticket ----
      // Stop a run now and/or never process the ticket again. Separate from
      // /api/pause: a pause is "finish this step, then wait", this is "kill it".
      if (path === '/api/stop' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { ticketKey?: string; ignore?: boolean; reason?: string }
          if (!b.ticketKey) return json(res, { error: 'ticketKey required' })
          json(res, hooks.stopTicket(b.ticketKey, { ignore: !!b.ignore, reason: b.reason }))
        }).catch((e) => serverError(res, e))
        return
      }
      // Clear a never-process mark, making the ticket a normal candidate again.
      if (path === '/api/unignore' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { ticketKey?: string }
          if (!b.ticketKey) return json(res, { error: 'ticketKey required' })
          setTicketIgnored(b.ticketKey, false)
          log.info(`▶ ${b.ticketKey} un-ignored via dashboard`)
          json(res, { ok: true, ticketKey: b.ticketKey })
        }).catch((e) => serverError(res, e))
        return
      }
      if (path === '/api/pause' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { paused?: boolean; ticketKey?: string }
          const paused = !!b.paused
          if (b.ticketKey) {
            setTicketPaused(b.ticketKey, paused)
            log.info(`${paused ? '⏸ paused' : '▶ resumed'} ticket ${b.ticketKey} via dashboard`)
            // On resume, warn if the project is busy with a DIFFERENT ticket —
            // one-per-project means this one waits until that finishes.
            let warning: string | undefined
            if (!paused) {
              const proj = b.ticketKey.split(':')[0]
              const busy = (hooks.status().activeRuns || []).find((a) => a.project === proj && `${a.project}:${a.ticket}` !== b.ticketKey)
              if (busy) warning = `Project "${proj}" is busy with ${busy.ticket} — this ticket will resume once that finishes (one run per project).`
            }
            json(res, { paused, ticketKey: b.ticketKey, warning })
          } else {
            setPaused(paused)
            log.info(paused ? '⏸ paused via dashboard' : '▶ resumed via dashboard')
            json(res, { paused })
          }
        }).catch((e) => serverError(res, e))
        return
      }
      // ---- Step catalog & workflow manager -------------------------------
      if (path === '/api/catalog' && req.method === 'GET') {
        return json(res, buildCatalogView(cfg))
      }
      if (path.startsWith('/api/catalog/step/') && req.method === 'GET') {
        const ref = decodeURIComponent(path.slice('/api/catalog/step/'.length))
        const cat = loadCatalog()
        return json(res, { step: getStep(cat, ref), scope: cat.steps.get(ref)?.scope })
      }
      if (path.startsWith('/api/catalog/workflow/') && req.method === 'GET') {
        const ref = decodeURIComponent(path.slice('/api/catalog/workflow/'.length))
        const cat = loadCatalog()
        return json(res, { workflow: getWorkflow(cat, ref), scope: cat.workflows.get(ref)?.scope })
      }
      // Compile-and-validate WITHOUT saving — this is what makes the builder
      // safe to edit in: every keystroke can be checked before it is written.
      if (path === '/api/catalog/preview' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { workflow?: Workflow; ref?: string; project?: string }
          json(res, previewPlan(cfg, b))
        }).catch((e) => serverError(res, e))
        return
      }
      // Clone a built-in (or any version) into the user catalog, ready to edit.
      if (path === '/api/catalog/clone' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { kind: 'step' | 'workflow'; ref: string; newId?: string; project?: string }
          const cat = loadCatalog()
          let copy: CatalogStep | Workflow = b.kind === 'step'
            ? cloneStep(cat, b.ref, b.newId)
            : cloneWorkflow(cat, b.ref, b.newId)
          if (b.kind === 'workflow' && b.project) {
            const project = cfg.projects.find((item) => item.name === b.project)
            if (!project) return json(res, { error: `unknown project "${b.project}"` })
            copy = applyProjectStageOverrides(copy as Workflow, project)
          }
          json(res, { draft: copy, ref: formatRef(copy) })
        }).catch((e) => json(res, { error: String(e instanceof Error ? e.message : e) }))
        return
      }
      // Save a NEW version. Published versions are immutable, so the server
      // assigns the next free version rather than trusting the client's.
      if (path === '/api/catalog/save' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { kind: 'step' | 'workflow'; draft: CatalogStep | Workflow; project?: string }
          try {
            const cat = loadCatalog()
            const kind = b.kind === 'step' ? 'steps' : 'workflows'
            const draft: any = { ...b.draft, builtin: false }
            draft.version = nextVersion(cat, kind as 'steps' | 'workflows', draft.id)
            if (b.kind === 'step') {
              if (!String(draft.id || '').trim()) return json(res, { error: 'The step is missing an id.' })
              if (!String(draft.name || '').trim()) return json(res, { error: 'The step is missing a name.' })
              if (!String(draft.instruction || '').trim()) return json(res, { error: 'The default instruction cannot be empty.' })
              draft.instruction = String(draft.instruction).trim()
            } else {
              // Never save a workflow that could not run.
              const project = b.project ? cfg.projects.find((item) => item.name === b.project) : undefined
              if (b.project && !project) return json(res, { error: `unknown project "${b.project}"` })
              const plan = compileWorkflow(loadCatalog(), draft as Workflow, { config: cfg, project })
              const errors = plan.diagnostics.filter((d) => d.level === 'error')
              if (errors.length) return json(res, { error: errors.map((e) => e.message).join('; ') })
            }
            const file = b.kind === 'step' ? saveStep(draft) : saveWorkflow(draft)
            json(res, { ok: true, ref: formatRef(draft), file })
          } catch (e) {
            json(res, { error: String(e instanceof Error ? e.message : e) })
          }
        }).catch((e) => serverError(res, e))
        return
      }
      // Assign a workflow version to a project. Validated against THAT
      // project's policy first — assigning a plan that cannot run is the same
      // mistake as running it.
      if (path === '/api/catalog/assign' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { project: string; ref: string; engine?: 'legacy' | 'workflow' }
          const project = cfg.projects.find((p) => p.name === b.project)
          if (!project) return json(res, { error: `unknown project "${b.project}"` })
          const candidate: ProjectConfig = { ...project, workflow: b.ref, engine: b.engine || project.engine }
          let plan
          try {
            plan = planForProject({ ...cfg, projects: [candidate] }, candidate, loadCatalog())
          } catch (e) {
            return json(res, { error: e instanceof Error ? e.message : String(e) })
          }
          const errors = plan.diagnostics.filter((d) => d.level === 'error')
          if (errors.length)
            return json(res, { error: `${b.ref} cannot run on "${b.project}": ${errors.map((e) => e.message).join('; ')}` })
          const saved = hooks.saveProject(candidate)
          if ('error' in saved) return json(res, saved)
          json(res, {
            ok: true,
            engine: candidate.engine || 'legacy',
            // Assigning a workflow to a legacy-engine project changes nothing at
            // runtime; say so rather than letting it look done.
            warning:
              (candidate.engine || 'legacy') === 'legacy'
                ? `Project "${b.project}" still runs engine: legacy, so this workflow is not what executes. Switch it to the workflow engine under Projects.`
                : undefined,
          })
        }).catch((e) => serverError(res, e))
        return
      }
      // ---- Filesystem browser for the repo-path picker ----
      if (path === '/api/fs' && req.method === 'GET') {
        return json(res, listDir(url.searchParams.get('path')))
      }
      // ---- Project setup (UI) ----
      if (path === '/api/config' && req.method === 'GET') {
        return json(res, buildConfigView(cfg))
      }
      if (path === '/api/projects' && req.method === 'POST') {
        readBody(req).then((body) => {
          const p = body as ProjectConfig
          json(res, hooks.saveProject(p))
        }).catch((e) => serverError(res, e))
        return
      }
      if (path.startsWith('/api/projects/') && req.method === 'DELETE') {
        const name = decodeURIComponent(path.slice('/api/projects/'.length))
        return json(res, hooks.removeProject(name))
      }
      if (path === '/api/settings' && req.method === 'POST') {
        readBody(req).then((body) => {
          json(res, hooks.saveSettings(body as Record<string, unknown>))
        }).catch((e) => serverError(res, e))
        return
      }
      if (path === '/api/keys' && req.method === 'POST') {
        readBody(req).then((body) => {
          const { project, key } = body as { project: string; key: string }
          json(res, hooks.setKey(project, key))
        }).catch((e) => serverError(res, e))
        return
      }
      return serveStatic(path, res)
    } catch (e) {
      serverError(res, e)
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `dashboard port ${cfg.server.port} is already in use — another ticketloop is ` +
          `likely running. Stop it, or set server.port to a free port.`,
      )
    } else {
      log.error(`dashboard server error: ${err.message}`)
    }
    process.exit(1)
  })
  server.listen(cfg.server.port, cfg.server.host, () => {
    log.info(
      `dashboard: http://${cfg.server.host}:${cfg.server.port}  (usage + history)`,
    )
  })
  return { close: () => server.close() }
}

function buildStatus(cfg: Config, hooks: ServerHooks) {
  const auth = assertAuthSafe(cfg)
  const s = hooks.status()
  return {
    running: s.running,
    paused: isPaused(),
    lastScan: s.lastScan,
    nextScan: s.nextScan,
    scanning: !!s.scanning,
    scanDone: s.scanDone ?? 0,
    scanTotal: s.scanTotal ?? 0,
    activeTicket: s.activeTicket,
    activeProject: s.activeProject,
    activeRuns: s.activeRuns ?? [],
    pausedTickets: s.pausedTickets ?? [],
    ignoredTickets: s.ignoredTickets ?? [],
    stoppingTickets: s.stoppingTickets ?? [],
    resumableTickets: s.resumableTickets ?? [],
    authMode: cfg.runner.providers[cfg.runner.defaultProvider].authMode,
    provider: cfg.runner.defaultProvider,
    tracker: cfg.tracker.type,
    warnings: auth.warnings,
    projects: cfg.projects.map((p) => ({
      name: p.name,
      autonomy: p.autonomy,
      repoPath: p.repoPath,
    })),
  }
}

/** Sanitized config for the UI: globals read-only, projects editable, NO keys. */
function buildConfigView(cfg: Config) {
  const catalog = loadCatalog()
  const latestWorkflows = new Map<string, { ref: string; id: string; version: number; name: string; builtin: boolean }>()
  for (const [ref, entry] of catalog.workflows) {
    const workflow = entry.item
    const current = latestWorkflows.get(workflow.id)
    if (!current || workflow.version > current.version) {
      latestWorkflows.set(workflow.id, {
        ref,
        id: workflow.id,
        version: workflow.version,
        name: workflow.name,
        builtin: entry.scope === 'builtin',
      })
    }
  }
  return {
    // globals — editable from the dashboard's Settings card except provider
    // auth and server settings, which are config-file-only.
    globals: {
      loop: cfg.loop,
      runner: cfg.runner,
      server: cfg.server,
      trackerDefaults: {
        type: cfg.tracker.type,
        simpleLabel: cfg.tracker.simpleLabel,
        states: cfg.tracker.states,
        pollIntervalSec: cfg.tracker.pollIntervalSec,
      },
      stages: cfg.stages,
    },
    stageOrder: STAGE_ORDER,
    defaultInstructions: DEFAULT_INSTRUCTIONS,
    models: MODELS,
    efforts: EFFORTS,
    workflows: [...latestWorkflows.values()].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? 1 : -1
      return a.name.localeCompare(b.name)
    }),
    tooling: tooling(cfg),
    projects: cfg.projects.map((p) => {
      const tc = resolveTracker(cfg, p)
      return {
        ...p,
        // never expose the key; report whether one is resolvable and its source
        hasKey: !!resolveTrackerKey(p, tc),
        keySource: hasCredential(p.name)
          ? 'daemon'
          : process.env[tc.apiKeyEnv]
            ? 'env'
            : null,
        resolvedTracker: { type: tc.type, simpleLabel: tc.simpleLabel, states: tc.states, team: tc.team },
        repoExists: existsSync(p.repoPath),
      }
    }),
  }
}

/** List sub-directories of a local path for the repo-path picker (localhost only). */
function listDir(p: string | null): {
  path: string
  parent: string | null
  isGitRepo: boolean
  dirs: { name: string; path: string }[]
} {
  const base = p && p.trim() ? resolve(p) : homedir()
  const parent = dirname(base)
  const dirs: { name: string; path: string }[] = []
  try {
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (ent.name.startsWith('.') && ent.name !== '.') continue // skip dotdirs (except allow navigating)
      dirs.push({ name: ent.name, path: join(base, ent.name) })
    }
  } catch {
    /* unreadable dir → empty list */
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return {
    path: base,
    parent: parent === base ? null : parent,
    isGitRepo: existsSync(join(base, '.git')),
    dirs,
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(body)
}
function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"error":"not found"}')
}
function serverError(res: ServerResponse, e: unknown) {
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: String(e) }))
}

// The dashboard is served fresh from disk and changes whenever the daemon is
// updated, so tell browsers never to cache it — otherwise a stale app.js/style
// keeps rendering an old UI even after a hard refresh (the source of every
// "hard-refresh needed / button missing" surprise).
const NO_CACHE = 'no-cache, no-store, must-revalidate'

function serveStatic(path: string, res: ServerResponse) {
  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '')
  const file = resolve(WEB_DIR, rel)
  if (!file.startsWith(resolve(WEB_DIR)) || !existsSync(file)) {
    // SPA-ish fallback to index
    const index = join(WEB_DIR, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': NO_CACHE })
      res.end(readFileSync(index))
      return
    }
    return notFound(res)
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': NO_CACHE,
  })
  res.end(readFileSync(file))
}
