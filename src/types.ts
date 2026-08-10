// Shared types — the contract between the engine, the store, and the dashboard.

export type AuthMode = 'subscription' | 'api'
export type Autonomy = 'clarify' | 'propose' | 'gated-merge'

// The generic framework. Every stage is a MODEL invocation driven by an
// instruction (a built-in default, overridable per project/stage). The harness
// only sequences these, enforces guardrails, and records history — it does not
// dictate HOW a step is done, so each project's own skills/tools/env/CLI apply.
export type StageName =
  | 'triage' // model decides eligibility + kind (question|data|change)
  | 'clarify' // question path: read code, answer the client
  | 'export' // data path: read-only data pull → export file
  | 'plan'
  | 'prepare' // pre-fix setup: branch, context, deps — model's call
  | 'fix'
  | 'verify'
  | 'review'
  | 'ship' // commit / push / open PR (model runs git+gh per instruction)
  | 'comment' // deliver the outcome back to the ticket

export const STAGE_ORDER: StageName[] = [
  'triage',
  'clarify',
  'plan',
  'prepare',
  'export',
  'fix',
  'verify',
  'review',
  'ship',
  'comment',
]

// How a user-supplied instruction combines with the built-in default.
export type InstructionMode = 'replace' | 'append'

// ---- Config ----------------------------------------------------------------

// How the headless claude run handles tool permissions:
//  - bypass:      --dangerously-skip-permissions (model may use ANY tool/bash/MCP).
//                 Required for the loop to actually act autonomously. Safety comes
//                 from worktree isolation + exclude guardrail + PR review, NOT prompts.
//  - acceptEdits: auto-approve file edits + safe fs cmds; other bash/network blocked.
//  - default:     only tools in allowedTools are permitted (most locked-down).
export type PermissionMode = 'bypass' | 'acceptEdits' | 'default'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface StageConfig {
  enabled?: boolean
  model?: string // e.g. "sonnet" | "opus" | "claude-opus-4-8"
  effort?: Effort
  permissionMode?: PermissionMode // inherits runner.permissionMode if unset
  skill?: string | null // a Claude Code skill to invoke, e.g. "code-review"
  // The user's instruction for this step. This is the primary knob: tell the
  // model exactly how YOU want the step done (use a skill, an MCP, a CLI, a
  // test flow…). Combined with the built-in default per `instructionMode`.
  instruction?: string | null
  instructionMode?: InstructionMode // default: 'replace'
  allowedTools?: string | null // e.g. "Read,Edit,Bash"
}

export type StagesConfig = Partial<Record<StageName, StageConfig>>

export interface QuotaConfig {
  plan?: string // informational label, e.g. "max20x"
  windowHours: number // rolling window length (Anthropic: 5)
  // Anthropic does not publish token quotas, so these are user-tunable
  // estimates the governor uses to compute a % of the window.
  sessionTokenBudget: number
  weeklyTokenBudget: number
}

export interface AuthConfig {
  mode: AuthMode
}

export interface RunnerConfig {
  claudeBin: string
  defaultModel: string
  defaultEffort: Effort
  // default permission mode for stages (overridable per stage)
  permissionMode: PermissionMode
  // hard ceiling per stage invocation (safety); null = no cap
  maxTurns?: number | null
  // kill a stage's claude subprocess after this many seconds (prevents hangs
  // from freezing the loop). Default 900 (15 min).
  stageTimeoutSec?: number
}

export interface ServerConfig {
  port: number
  host: string
}

export interface TrackerConfig {
  type: 'linear' | 'mock'
  apiKeyEnv: string // env var holding the token (fallback if not stored in daemon)
  keyRef?: string // name under which the key is saved via `ticketloop set-key`
  simpleLabel: string // label that marks a ticket eligible
  states: string[] // workflow states to pull from
  team?: string | null
  pollIntervalSec: number
}

export interface RepoConfig {
  type: 'github'
  tokenEnv?: string // optional; gh CLI usually already authed
}

export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
}

// One git repo inside a multi-repo project. When a project sets `repos`,
// `repoPath` becomes the WORKSPACE ROOT (a container folder, not itself a repo)
// and each entry is mirrored into a per-ticket worktree under it.
export interface RepoEntry {
  name: string // dir name in the workspace + label in prompts/PRs
  path: string // relative to repoPath (absolute allowed)
  base?: string | null // PR base branch; default = detected default branch
  exclude?: string[] // repo-relative globs, added on top of project.exclude
  shipDisabled?: boolean // greppable context only; any change here BLOCKS the run
}

export interface ProjectConfig {
  name: string
  repoPath: string
  // Multiple git repos under repoPath (case: sibling repos in one folder).
  // Omit for the single-repo default (zero behaviour change).
  repos?: RepoEntry[]
  devUrl?: string | null
  autonomy: Autonomy
  // Per-project tracker: overrides the top-level `tracker` block. Point each
  // project at its own workspace/account with its own API key env var, team,
  // label, and states. Anything omitted inherits from the top-level default.
  tracker?: Partial<TrackerConfig>
  // which tracker tickets belong to this project (used only when one workspace
  // serves several projects; with per-project trackers this is optional)
  match: { linearTeam?: string; label?: string; projectName?: string }
  exclude: string[] // glob patterns that must never be auto-edited
  // Isolate each change in a git worktree off this repo (default true) so the
  // loop never disturbs your working tree. Set false to work in-place on a
  // branch in repoPath instead.
  useWorktree?: boolean
  worktreeBase?: string | null // where to put worktrees (default ~/.ticketloop/worktrees)
  // per-stage overrides for this project
  stages?: StagesConfig
  // MCP servers to expose to Claude during runs on this project
  mcp?: Record<string, McpServerConfig>
}

// Bounded fix-loop: after fix, run the deterministic check + verify + review;
// if not clean, feed the findings back into another fix, up to maxFixIterations.
export interface LoopConfig {
  enabled: boolean
  maxFixIterations: number // total fix attempts (1 = today's single-pass behavior)
}

export interface Config {
  version: number
  loop: LoopConfig
  quota: QuotaConfig
  auth: AuthConfig
  runner: RunnerConfig
  server: ServerConfig
  tracker: TrackerConfig
  repo: RepoConfig
  // global default stage config, overridden by project.stages
  stages: StagesConfig
  mcp?: Record<string, McpServerConfig>
  projects: ProjectConfig[]
}

// ---- Tracker domain --------------------------------------------------------

export interface TicketComment {
  id: string
  body: string
  authorName: string
  createdAt: string
  isBot: boolean // posted by ticketloop (tagged) — ignored for re-trigger
}

export interface Ticket {
  id: string // internal id
  identifier: string // human ref e.g. "MIL-123"
  title: string
  description: string
  url: string
  state: string
  labels: string[]
  team?: string
  projectName?: string
  updatedAt?: string
  comments?: TicketComment[]
}

// ---- Usage / governor ------------------------------------------------------

export interface UsageEvent {
  ts: number // epoch ms
  runId: string
  ticket: string // identifier
  stage: StageName
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number
  authMode: AuthMode
}

export interface WindowUsage {
  used: number
  budget: number
  pct: number
  resetAt: number // epoch ms when the rolling window frees the oldest tokens
  costUsd: number
}

export interface UsageSummary {
  window: WindowUsage // rolling 5h
  weekly: WindowUsage
  authMode: AuthMode
  plan?: string
}

// ---- Activity / run history ------------------------------------------------

export type RunOutcome =
  | 'answered' // clarification comment posted
  | 'exported' // data-export request fulfilled (file posted to the ticket)
  | 'pr-opened'
  | 'pr-opened-with-findings' // shipped but the fix-loop didn't fully clear checks
  | 'partial' // multi-repo: ≥1 PR opened AND ≥1 repo failed to ship
  | 'merged'
  | 'skipped' // did not qualify
  | 'blocked' // hit quota or guardrail
  | 'failed'
  | 'running'

export interface StageRecord {
  stage: StageName
  status: 'ok' | 'skipped' | 'failed' | 'running'
  startedAt: number
  endedAt?: number
  model?: string
  totalTokens?: number
  costUsd?: number
  summary?: string // short human-readable result
  detail?: string // longer text (claude result / error)
}

// One repo's ship result in a multi-repo run.
export interface PrRecord {
  repo: string
  branch: string
  url?: string
  status: 'opened' | 'failed' | 'skipped' // skipped = repo had no changes
  error?: string
}

export interface RunRecord {
  id: string
  ticket: string // identifier
  ticketTitle: string
  ticketUrl: string
  project: string
  autonomy: Autonomy
  startedAt: number
  endedAt?: number
  outcome: RunOutcome
  stages: StageRecord[]
  prUrl?: string // first/primary PR — existing UI + history keep working
  prs?: PrRecord[] // populated on multi-repo runs
  commentUrl?: string
  error?: string
  totalTokens: number
  costUsd: number
}
