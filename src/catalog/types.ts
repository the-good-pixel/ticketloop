// Step catalog & workflow manager — the data model.
//
// The pipeline stops being code and becomes DATA: a workflow is a validated
// tree of phases whose leaves are catalog steps. This file is the source of
// truth for both, mirroring docs/design-step-catalog-workflow-manager.md.
//
// Nothing here executes anything. Compilation (compile.ts) resolves a workflow
// into an immutable ExecutionPlan; the interpreter lands in a later phase.

import type { Effort, PermissionMode, RunOutcome, AgentProvider } from '../types.js'

// ---- Steps -----------------------------------------------------------------

/** What machine-readable result the harness expects back from a step. */
export type StepContract =
  | 'text' // plain output, stored as context for later steps
  | 'route' // named routing fields (e.g. DECISION / KIND) drive a branch
  | 'verdict' // VERDICT: pass|fail|wait|skip — gates the workflow
  | 'post' // posts to the tracker itself; harness parses COMMENT_URL
  | 'artifact' // produces a typed external artifact (PR, deployment)

/** Where and how a step runs. */
export type WorkspaceKind =
  | 'none' // no repo needed
  | 'checkout' // the project's real checkout, read-only (triage, locate)
  | 'change' // an isolated worktree the step may modify
  | 'read-only' // a throwaway worktree that must not be modified (data path)

/** How often a step runs across a multi-repo project. */
export type PerRepo =
  | 'once' // one invocation for the whole workspace
  | 'each' // once per repo in the workspace
  | 'changed' // once per repo that actually has changes (ship)

/** Side effects a step may have outside the local worktree. */
export type ExternalEffect =
  | 'tracker-comment'
  | 'create-pr'
  | 'merge-pr'
  | 'create-release-pr'
  | 'merge-release-pr'
  | 'deploy-dev'

/** What resuming an already-started node should do. */
export type ResumePolicy =
  | 'replay' // reuse the cached output (planning / classification)
  | 'rerun' // invoke again (local verification)
  | 'revalidate' // refresh external artifacts first, then decide
  | 'idempotent' // rerun under a stable operation key (tracker comments)

/**
 * Named speed/quality tiers. A step names a tier; the PROJECT decides which
 * provider/model/effort that tier means, so steps stay portable between users
 * who run different providers.
 */
export type ExecutionProfileName = 'fast' | 'balanced' | 'quality'

export interface ExecutionProfile {
  provider?: AgentProvider
  model?: string
  effort?: Effort
}

/** Authority a project grants; a step declares what it needs. */
export type Permission =
  | 'createFeaturePr'
  | 'mergeFeaturePr'
  | 'createDevReleasePr'
  | 'mergeDevReleasePr'
  | 'deployDev'
  | 'deployProduction'

export const ALL_PERMISSIONS: Permission[] = [
  'createFeaturePr',
  'mergeFeaturePr',
  'createDevReleasePr',
  'mergeDevReleasePr',
  'deployDev',
  'deployProduction',
]

/** Typed things a step can produce for later steps and final reporting. */
export type ArtifactType = 'github-pr' | 'deployment' | 'file' | 'branch'

export interface StepDefaults {
  executionProfile?: ExecutionProfileName
  effort?: Effort
  allowedTools?: string | null
  skill?: string | null
  permissionMode?: PermissionMode
  enabled?: boolean // false = opt-in step, off until a project turns it on
}

export interface StepCapabilities {
  workspace: WorkspaceKind
  mutatesRepo: boolean
  perRepo: PerRepo
  devOnly: boolean // hard-pinned to DEV/preview regardless of the instruction
  externalEffects: ExternalEffect[]
}

export interface StepProduces {
  key: string // the name later steps `consumes` and branches read
  type: 'text' | ArtifactType
}

/**
 * One unit of agent work. Immutable once published: editing a published version
 * creates a new version, so a run's snapshot can never shift under it.
 */
export interface CatalogStep {
  id: string
  version: number
  name: string
  description: string
  instruction: string
  defaults: StepDefaults
  /** Optional per-provider skill, so one step works on every provider. */
  skills?: Partial<Record<AgentProvider, string>>
  contract: StepContract
  /** For `route` steps: the fields a branch may read (e.g. ['DECISION','KIND']). */
  routeFields?: string[]
  capabilities: StepCapabilities
  requiresPermissions?: Permission[]
  resumePolicy: ResumePolicy
  /** Produce-keys this step uses as context when present. Absent = less context, still runs. */
  consumes?: string[]
  /** Produce-keys this step CANNOT work without. A missing one is a validation error. */
  requires?: string[]
  produces: StepProduces
  /** Set on the steps ticketloop ships; built-ins can't be edited in place. */
  builtin?: boolean
}

// ---- Results & transitions -------------------------------------------------

/** What a step can report. Provider quota is a HARNESS event, never a result. */
export type StepResult = 'pass' | 'fail' | 'wait' | 'skip'

export const STEP_RESULTS: StepResult[] = ['pass', 'fail', 'wait', 'skip']

/**
 * Where a result sends execution:
 *   next            — the following node in this phase list
 *   repair          — the enclosing loop's repair node
 *   <loop>.repair   — a named loop's repair node (used from outside the loop)
 *   exit-loop       — leave the enclosing loop as satisfied
 *   suspend         — stop and wait for an external condition; keep the checkpoint
 *   stop            — end the run on this path
 *   continue        — ignore the result and carry on
 */
export type Transition = string

export const SIMPLE_TRANSITIONS = ['next', 'repair', 'exit-loop', 'suspend', 'stop', 'continue']

export type Transitions = Partial<Record<StepResult, Transition>>

// ---- Workflow phases -------------------------------------------------------

/** Per-node execution overrides. Never changes graph semantics. */
export interface NodeOverrides {
  enabled?: boolean
  executionProfile?: ExecutionProfileName
  provider?: AgentProvider
  model?: string
  effort?: Effort
  skill?: string | null
  allowedTools?: string | null
  permissionMode?: PermissionMode
  instruction?: string | null
  instructionMode?: 'replace' | 'append'
}

/** A leaf: run one catalog step. */
export interface StepNode {
  id: string // workflow-unique; the checkpoint key is built from it
  step: string // "<step-id>@<version>"
  on?: Transitions
  overrides?: NodeOverrides
}

/** A terminal: end this path with a classified outcome. */
export interface StopNode {
  id: string
  stop: TerminalClass
  /** Override the workflow's outcome mapping for this specific terminal. */
  outcome?: RunOutcome
  note?: string
  /** true = the ticket was already replied to here, so `finally` must not post again. */
  reported?: boolean
}

export type TerminalClass = 'success' | 'partial' | 'waiting' | 'failed' | 'skipped' | 'blocked'

export const TERMINAL_CLASSES: TerminalClass[] = [
  'success',
  'partial',
  'waiting',
  'failed',
  'skipped',
  'blocked',
]

/** A fork on a `route` step's typed output. */
export interface BranchNode {
  id: string
  branch: {
    on: string // "<node-id>.<FIELD>"
    cases: Record<string, Phase[]>
    default: Transition | Phase[] // 'continue' | 'stop' | a phase list
  }
}

/** A bounded repair loop: repair → gates → repeat while a gate fails. */
export interface LoopNode {
  loop: {
    id: string
    /** Runs first, and again after any gate routes back here. */
    repair: StepNode
    /** Run in order after repair; the first failing gate short-circuits. */
    gates: StepNode[]
    maxIterations: number
    /** What to do when two iterations produce identical findings. */
    noProgress: 'stop' | 'exit-loop'
  }
}

export type Phase = StepNode | StopNode | BranchNode | LoopNode

export const isStepNode = (p: Phase): p is StepNode => 'step' in p
export const isStopNode = (p: Phase): p is StopNode => 'stop' in p
export const isBranchNode = (p: Phase): p is BranchNode => 'branch' in p
export const isLoopNode = (p: Phase): p is LoopNode => 'loop' in p

// ---- Workflow --------------------------------------------------------------

/** A `finally` node — the dependable final report. */
export interface FinallyNode extends StepNode {
  runOn: TerminalClass[]
}

/** How a terminal class maps to a durable ticketloop outcome. */
export interface OutcomeMapping {
  default: RunOutcome
  /** Upgrade the outcome when a named artifact exists and succeeded. */
  whenArtifact?: Record<string, RunOutcome>
}

export interface Workflow {
  id: string
  version: number
  name: string
  description?: string
  phases: Phase[]
  finally?: FinallyNode[]
  outcomes: Partial<Record<TerminalClass, OutcomeMapping>>
  builtin?: boolean
}

// ---- Artifacts (runtime) ---------------------------------------------------

export interface PrArtifact {
  type: 'github-pr'
  repo: string
  number?: number
  url?: string
  state?: 'open' | 'merged' | 'closed'
}

export interface DeploymentArtifact {
  type: 'deployment'
  environment: 'dev'
  status: 'pending' | 'waiting-approval' | 'live' | 'failed'
  url?: string
}

export interface FileArtifact {
  type: 'file'
  path: string
  summary?: string
}

export type Artifact = PrArtifact | DeploymentArtifact | FileArtifact

// ---- Waiting ---------------------------------------------------------------

export type WaitingReason =
  | 'waiting-provider'
  | 'waiting-approval'
  | 'waiting-deployment'
  | 'waiting-external'

export interface Suspension {
  reason: WaitingReason
  nodeId: string
  detail: string
  resumeAt?: number
  provider?: AgentProvider
  artifactKey?: string
}
