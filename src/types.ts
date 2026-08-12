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
  | 'locate' // change path: find an existing open PR to refresh (read-only)
  | 'reproduce' // bug path: reproduce the bug + find root cause before planning
  | 'plan'
  | 'prepare' // pre-fix setup: branch, context, deps — model's call
  | 'fix'
  | 'verify'
  | 'review'
  | 'ship' // commit / push / open PR (model runs git+gh per instruction)
  | 'deploy-dev' // deploy the shipped change to DEV (gated; opt-in per project)
  | 'verify-dev' // verify the change works in DEV after deploy (gated; opt-in)
  | 'comment' // deliver the outcome back to the ticket

export const STAGE_ORDER: StageName[] = [
  'triage',
  'clarify',
  'export',
  'locate',
  'reproduce',
  'plan',
  'prepare',
  'fix',
  'verify',
  'review',
  'ship',
  'deploy-dev',
  'verify-dev',
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
  // How many of THIS project's tickets may run at once (default 1). Projects
  // always run in parallel with each other; this opts a single project into
  // working several of its own tickets concurrently. Each ticket still gets its
  // own worktree, but they share one repo — so only raise this if the project's
  // steps don't contend (e.g. a `verify` that binds a fixed dev-server port, or
  // heavy concurrent git on the same repo, will collide).
  maxParallel?: number
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
  | 'deployed' // shipped AND deployed to dev (deploy-dev, and verify-dev if on, passed)
  | 'partial' // multi-repo: ≥1 PR opened AND ≥1 repo failed to ship
  | 'merged'
  | 'skipped' // did not qualify
  | 'blocked' // hit quota or guardrail
  | 'paused' // pause requested mid-run; checkpointed, resume to continue
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

// One RUN = one continuous piece of work on one "ask" (a ticket at a given
// latest-human-activity marker). Being interrupted (rate limit, pause, crash)
// and RESUMED does NOT fork a new run — the same record is continued in place,
// so its tokens/cost reflect the true total spent getting that work done.
// A new record is only minted for a genuinely new attempt: "restart fresh"
// (checkpoint discarded) or a new ask (the client posted new activity).
export interface RunRecord {
  id: string
  ticket: string // identifier
  ticketTitle: string
  ticketUrl: string
  project: string
  marker?: string // latest-human-activity this run is servicing (the "ask")
  resumes?: number // times this run was continued after an interruption
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
