// Workflow compiler: workflow + catalog + project policy → immutable execution plan.
//
// Compilation is where a workflow stops being editable YAML and becomes the
// thing a run is pinned to. It resolves every step reference to a concrete
// version, folds in project execution profiles / legacy `stages` overrides,
// assigns stable checkpoint keys, and produces a digest so a resumed run can
// tell whether the live catalog has moved underneath it.
//
// The compiler NEVER executes anything and never grants authority: it only
// resolves and reports. Validation lives in validate.ts and runs from here.

import type { Config, ProjectConfig, StageName, StagesConfig } from '../types.js'
import { resolveInstruction } from '../config.js'
import { validatePlan, type Diagnostic } from './validate.js'
import { getStep, type Catalog } from './store.js'
import type {
  CatalogStep,
  ExecutionProfile,
  ExecutionProfileName,
  NodeOverrides,
  Permission,
  Phase,
  StepResult,
  TerminalClass,
  Transition,
  Transitions,
  Workflow,
} from './types.js'
import { isBranchNode, isLoopNode, isStepNode, isStopNode } from './types.js'

/**
 * What each speed/quality tier means when a project does not say. Deliberately
 * conservative: these reproduce the effort levels today's engine uses, so a
 * compiled `standard` workflow is a faithful trace of current behavior. Raise
 * `quality` per project once you want the new tiers to actually mean something.
 */
export const DEFAULT_PROFILES: Record<ExecutionProfileName, ExecutionProfile> = {
  fast: { effort: 'low' },
  balanced: { effort: 'medium' },
  quality: { effort: 'medium' },
}

/** Everything needed to actually invoke one node, fully resolved. */
export interface ExecutionSettings {
  enabled: boolean
  profile: ExecutionProfileName
  provider?: Config['runner']['defaultProvider']
  model?: string
  effort?: string
  skill?: string | null
  allowedTools?: string | null
  permissionMode?: string
  instruction: string
}

export interface CompiledStepNode {
  kind: 'step'
  id: string
  ref: string
  step: CatalogStep
  settings: ExecutionSettings
  transitions: Partial<Record<StepResult, Transition>>
  /** Enclosing loop id, if any — `repair` transitions resolve against it. */
  loopId?: string
  role?: 'repair' | 'gate' | 'finally'
  /** Checkpoint keys for a node inside a loop carry the iteration number. */
  iterationScoped: boolean
  /** Permissions this node needs that the project has NOT granted. */
  missingPermissions: Permission[]
  path: string[]
}

export interface CompiledStopNode {
  kind: 'stop'
  id: string
  terminal: TerminalClass
  outcome?: string
  note?: string
  reported: boolean
  path: string[]
}

export interface CompiledBranchNode {
  kind: 'branch'
  id: string
  on: { nodeId: string; field: string }
  cases: Record<string, CompiledPhase[]>
  default: Transition | CompiledPhase[]
  path: string[]
}

export interface CompiledLoopNode {
  kind: 'loop'
  id: string
  repair: CompiledStepNode
  gates: CompiledStepNode[]
  maxIterations: number
  noProgress: 'stop' | 'exit-loop'
  path: string[]
}

export type CompiledPhase =
  | CompiledStepNode
  | CompiledStopNode
  | CompiledBranchNode
  | CompiledLoopNode

export interface CompiledFinallyNode extends CompiledStepNode {
  runOn: TerminalClass[]
}

export interface ExecutionPlan {
  workflow: { id: string; version: number; name: string }
  digest: string
  phases: CompiledPhase[]
  finallyNodes: CompiledFinallyNode[]
  outcomes: Workflow['outcomes']
  /** node id → node, for checkpoint replay and dashboard lookups. */
  nodes: Map<string, CompiledStepNode>
  /** Every produce-key reachable in the plan, for `consumes` validation. */
  produced: Set<string>
  diagnostics: Diagnostic[]
  /** The project policy this plan was compiled against, for the run snapshot. */
  permissions: Partial<Record<Permission, boolean>>
  profiles: Record<ExecutionProfileName, ExecutionProfile>
}

/**
 * Context supplied by the harness rather than by any step: the loop's repair
 * findings, the iteration counter, the ticket itself. These always resolve, so
 * `consumes` validation must not demand a producing step for them.
 */
export const HARNESS_KEYS = new Set(['openFindings', 'iteration', 'ticket', 'workspace'])

/** Stable checkpoint key for one node invocation. */
export function checkpointKey(
  plan: ExecutionPlan,
  nodeId: string,
  iteration?: number,
  repo?: string,
): string {
  const parts = [`${plan.workflow.id}@${plan.workflow.version}`, nodeId]
  if (iteration !== undefined) parts.push(String(iteration))
  if (repo) parts.push(repo)
  return parts.join('/')
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function resolveProfiles(
  cfg: Config | undefined,
  project: ProjectConfig | undefined,
): Record<ExecutionProfileName, ExecutionProfile> {
  const out = structuredClone(DEFAULT_PROFILES)
  for (const src of [cfg?.executionProfiles, project?.executionProfiles]) {
    for (const [name, prof] of Object.entries(src || {}))
      out[name as ExecutionProfileName] = { ...out[name as ExecutionProfileName], ...prof }
  }
  return out
}

function resolvePermissions(
  cfg: Config | undefined,
  project: ProjectConfig | undefined,
): Partial<Record<Permission, boolean>> {
  // Unset means DENIED — authority is opt-in, never inherited from a step.
  return { ...(cfg?.permissions || {}), ...(project?.permissions || {}) }
}

export interface CompileOpts {
  config?: Config
  project?: ProjectConfig
  /**
   * Legacy per-stage overrides (global `stages` + `project.stages`). Each one
   * applies to EVERY node whose catalog step shares the stage's name, which is
   * exactly what those blocks meant when the pipeline was hard-coded.
   */
  legacyStages?: StagesConfig[]
}

function legacyOverride(
  stepId: string,
  legacy: StagesConfig[] | undefined,
): NodeOverrides | undefined {
  if (!legacy?.length) return undefined
  let merged: NodeOverrides | undefined
  for (const block of legacy) {
    const sc = block?.[stepId as StageName]
    if (!sc) continue
    merged = { ...(merged || {}), ...sc }
  }
  return merged
}

function resolveSettings(
  step: CatalogStep,
  overrides: NodeOverrides | undefined,
  profiles: Record<ExecutionProfileName, ExecutionProfile>,
  opts: CompileOpts,
): ExecutionSettings {
  const legacy = legacyOverride(step.id, opts.legacyStages)
  // Precedence: step defaults < profile < legacy `stages` block < node override.
  const o: NodeOverrides = { ...(legacy || {}), ...(overrides || {}) }
  const profileName = o.executionProfile || step.defaults.executionProfile || 'balanced'
  const profile = profiles[profileName] || {}
  const provider = o.provider ?? profile.provider
  const providerSkill = provider ? step.skills?.[provider] : undefined
  return {
    enabled: o.enabled ?? step.defaults.enabled ?? true,
    profile: profileName,
    provider,
    model: o.model ?? profile.model,
    effort: o.effort ?? profile.effort ?? step.defaults.effort,
    skill: o.skill !== undefined ? o.skill : (providerSkill ?? step.defaults.skill ?? null),
    allowedTools: o.allowedTools !== undefined ? o.allowedTools : (step.defaults.allowedTools ?? null),
    permissionMode: o.permissionMode ?? step.defaults.permissionMode,
    // The step's instruction IS the built-in default; a node override replaces
    // or appends exactly as a stage instruction does today.
    instruction: o.instruction
      ? resolveInstructionText(step.instruction, o.instruction, o.instructionMode)
      : step.instruction,
  }
}

function resolveInstructionText(base: string, user: string, mode?: 'replace' | 'append'): string {
  const u = user.trim()
  if (!u) return base
  return mode === 'append' ? `${base}\n\nAdditional instructions:\n${u}` : u
}

// Defaults applied when a node does not spell out a transition. `pass` moves on;
// an unhandled `wait` always suspends (never silently continues); an unhandled
// `skip` moves on. `fail` has NO default — an unhandled failure is a validation
// error, because guessing between "repair" and "stop" is exactly the mistake
// this whole design exists to prevent.
const DEFAULT_TRANSITIONS: Transitions = { pass: 'next', wait: 'suspend', skip: 'next' }

export function compileWorkflow(cat: Catalog, wf: Workflow, opts: CompileOpts = {}): ExecutionPlan {
  const profiles = resolveProfiles(opts.config, opts.project)
  const permissions = resolvePermissions(opts.config, opts.project)
  const nodes = new Map<string, CompiledStepNode>()
  const produced = new Set<string>(HARNESS_KEYS)
  const diagnostics: Diagnostic[] = []
  const seenIds = new Set<string>()

  function claimId(id: string, path: string[]) {
    if (!id) diagnostics.push({ level: 'error', code: 'missing-node-id', message: `a node under ${path.join(' › ') || 'root'} has no id` })
    else if (seenIds.has(id))
      diagnostics.push({ level: 'error', code: 'duplicate-node-id', message: `duplicate node id "${id}"`, nodeId: id })
    seenIds.add(id)
  }

  function compileStep(
    node: { id: string; step: string; on?: Transitions; overrides?: NodeOverrides },
    path: string[],
    loopId: string | undefined,
    role: CompiledStepNode['role'],
  ): CompiledStepNode {
    claimId(node.id, path)
    let step: CatalogStep
    try {
      step = getStep(cat, node.step)
    } catch (e) {
      diagnostics.push({ level: 'error', code: 'unknown-step', message: String(e), nodeId: node.id })
      // A placeholder keeps compilation going so the user sees ALL problems at
      // once instead of fixing them one error per run.
      step = {
        id: node.step, version: 0, name: node.step, description: '', instruction: '',
        defaults: {}, contract: 'text', capabilities: { workspace: 'none', mutatesRepo: false, perRepo: 'once', devOnly: false, externalEffects: [] },
        resumePolicy: 'rerun', produces: { key: node.id, type: 'text' },
      }
    }
    const settings = resolveSettings(step, node.overrides, profiles, opts)
    const missingPermissions = (step.requiresPermissions || []).filter((p) => permissions[p] !== true)
    const compiled: CompiledStepNode = {
      kind: 'step',
      id: node.id,
      ref: node.step,
      step,
      settings,
      transitions: { ...DEFAULT_TRANSITIONS, ...(node.on || {}) },
      loopId,
      role,
      iterationScoped: !!loopId,
      missingPermissions,
      path,
    }
    nodes.set(node.id, compiled)
    if (settings.enabled) produced.add(step.produces.key)
    return compiled
  }

  function compilePhases(phases: Phase[], path: string[], loopId?: string): CompiledPhase[] {
    return phases.map((p) => {
      if (isStepNode(p)) return compileStep(p, path, loopId, loopId ? 'gate' : undefined)
      if (isStopNode(p)) {
        claimId(p.id, path)
        return {
          kind: 'stop', id: p.id, terminal: p.stop, outcome: p.outcome,
          note: p.note, reported: !!p.reported, path,
        } as CompiledStopNode
      }
      if (isBranchNode(p)) {
        claimId(p.id, path)
        const [nodeId, field] = String(p.branch.on).split('.')
        const cases: Record<string, CompiledPhase[]> = {}
        for (const [name, list] of Object.entries(p.branch.cases))
          cases[name] = compilePhases(list, [...path, `${p.id}:${name}`], loopId)
        const def = Array.isArray(p.branch.default)
          ? compilePhases(p.branch.default, [...path, `${p.id}:default`], loopId)
          : p.branch.default
        return { kind: 'branch', id: p.id, on: { nodeId, field }, cases, default: def, path } as CompiledBranchNode
      }
      if (isLoopNode(p)) {
        const l = p.loop
        claimId(l.id, path)
        const inner = [...path, l.id]
        return {
          kind: 'loop',
          id: l.id,
          repair: compileStep(l.repair, inner, l.id, 'repair'),
          gates: l.gates.map((g) => compileStep(g, inner, l.id, 'gate')),
          maxIterations: l.maxIterations,
          noProgress: l.noProgress,
          path,
        } as CompiledLoopNode
      }
      diagnostics.push({ level: 'error', code: 'unknown-phase', message: `unrecognized phase: ${JSON.stringify(p).slice(0, 120)}` })
      return { kind: 'stop', id: `invalid-${seenIds.size}`, terminal: 'failed', reported: false, path } as CompiledStopNode
    })
  }

  const compiledPhases = compilePhases(wf.phases, [])
  const finallyNodes: CompiledFinallyNode[] = (wf.finally || []).map((f) => ({
    ...compileStep(f, ['finally'], undefined, 'finally'),
    runOn: f.runOn,
  }))

  const plan: ExecutionPlan = {
    workflow: { id: wf.id, version: wf.version, name: wf.name },
    digest: djb2(JSON.stringify({ wf, profiles, permissions, legacy: opts.legacyStages || [] })),
    phases: compiledPhases,
    finallyNodes,
    outcomes: wf.outcomes || {},
    nodes,
    produced,
    diagnostics,
    permissions,
    profiles,
  }
  plan.diagnostics.push(...validatePlan(plan))
  return plan
}

export const hasErrors = (plan: ExecutionPlan) => plan.diagnostics.some((d) => d.level === 'error')
