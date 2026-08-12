import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import type {
  Config,
  ProjectConfig,
  StageConfig,
  StagesConfig,
  StageName,
  TrackerConfig,
} from './types.js'
import { STAGE_ORDER } from './types.js'
import { findConfigPath, DATA_DIR } from './paths.js'

const DEFAULTS: Config = {
  version: 1,
  loop: { enabled: true, maxFixIterations: 3 },
  quota: {
    plan: 'max20x',
    windowHours: 5,
    // Rough display gauge only — Anthropic doesn't publish real quotas, and the
    // token→quota mapping is unreliable. The real backstop is Claude's actual
    // rate-limit signal (the loop pauses when Claude says stop). Tune to taste.
    sessionTokenBudget: 6_000_000,
    weeklyTokenBudget: 30_000_000,
  },
  auth: { mode: 'subscription' },
  runner: {
    claudeBin: 'claude',
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    // The loop can't answer permission prompts headlessly, so it runs with
    // permissions skipped. Safety = worktree isolation + exclude guardrail +
    // PR review (never auto-merge), NOT prompts. See README "Safety model".
    permissionMode: 'bypass',
    maxTurns: 40,
    stageTimeoutSec: 900,
  },
  server: { port: 4317, host: '127.0.0.1' },
  tracker: {
    type: 'mock',
    apiKeyEnv: 'LINEAR_API_KEY',
    simpleLabel: 'simple',
    states: ['Todo', 'Backlog'],
    team: null,
    pollIntervalSec: 300,
  },
  repo: { type: 'github', tokenEnv: 'GITHUB_TOKEN' },
  stages: {
    triage: { enabled: true, model: 'sonnet', effort: 'low', allowedTools: 'Read,Bash' },
    clarify: { enabled: true, model: 'sonnet', effort: 'medium', allowedTools: 'Read,Bash' },
    export: { enabled: true, model: 'sonnet', effort: 'medium', allowedTools: 'Read,Bash' },
    locate: { enabled: true, model: 'sonnet', effort: 'low', allowedTools: 'Read,Bash' },
    reproduce: { enabled: true, model: 'sonnet', effort: 'medium', allowedTools: 'Read,Edit,Bash' },
    plan: { enabled: true, model: 'sonnet', effort: 'medium', allowedTools: 'Read,Bash' },
    prepare: { enabled: true, model: 'sonnet', effort: 'low', allowedTools: 'Read,Bash' },
    fix: { enabled: true, model: 'sonnet', allowedTools: 'Read,Edit,Bash' },
    verify: { enabled: true, model: 'sonnet', allowedTools: 'Read,Edit,Bash' },
    review: { enabled: true, model: 'sonnet', skill: 'code-review', allowedTools: 'Read,Bash' },
    ship: { enabled: true, model: 'sonnet', allowedTools: 'Read,Bash' },
    // Opt-in dev steps: deploying/verifying in dev needs a real per-project
    // mechanism, so both are OFF by default. Turn them on (enabled: true) + give
    // an instruction to auto-deploy each shipped change to DEV and verify it there.
    'deploy-dev': { enabled: false, model: 'sonnet', allowedTools: 'Read,Bash' },
    'verify-dev': { enabled: false, model: 'sonnet', allowedTools: 'Read,Bash' },
    comment: { enabled: true, model: 'sonnet', allowedTools: 'Read,Bash' },
  },
  projects: [],
}

// Built-in default instruction per stage. These are the "how I usually work"
// defaults; a user's `stages.<name>.instruction` replaces (or appends to) them.
// Keep them tool/skill-agnostic so they fit any project — project-specific
// wishes (use skill X, run CLI Y, hit MCP Z) belong in the user's override.
export const DEFAULT_INSTRUCTIONS: Record<StageName, string> = {
  triage:
    'You are ONLY classifying this ticket. Do NOT answer, explain, or make changes. Output ' +
    'EXACTLY these two lines and nothing else:\n' +
    'DECISION: eligible        (or: DECISION: ineligible, or: DECISION: no-action)\n' +
    'KIND: question            (or: KIND: data, or: KIND: change, or: KIND: bug)\n\n' +
    'FIRST decide whether ANY action is needed at all:\n' +
    '- DECISION=no-action — nothing to do right now. Use this when the LATEST activity is a ' +
    'sign-off / approval / acknowledgement / status update rather than a request: e.g. "UAT ' +
    'passed", "can deploy to PROD", "looks good", "all good, thanks", "verified", "closing this", ' +
    'a thumbs-up, or a comment that only confirms success or says thanks with NO new ask. Also ' +
    'use no-action when the ONLY ask is something this automated loop cannot do (deploy to ' +
    'production, a manual/ops task). Guard: only pick no-action if the newest comment clearly ' +
    'requests NOTHING — if it reports a problem, a defect, or asks for any change/fix/revision, ' +
    'it is NOT no-action.\n\n' +
    'If action IS needed, decide KIND from what the client most recently wants — READ THE LATEST COMMENTS, not ' +
    'just the original description (a ticket is often re-opened because of a new comment):\n' +
    '- KIND=bug — they report something BROKEN / not working as expected: an error, a crash, ' +
    'wrong output, a regression, "X is broken", "this stopped working", a reproducible defect. ' +
    'This is a change that first needs the bug reproduced and root-caused. Prefer bug over ' +
    'change whenever the ask is "fix this broken behavior" rather than "build/adjust this".\n' +
    '- KIND=change — they want a code/content change that is NOT a bug fix: a new feature, an ' +
    'enhancement, a copy/label tweak. This INCLUDES follow-up feedback and revisions on work ' +
    'already done: e.g. "this isn\'t right, please fix", "can you also change X", review ' +
    'comments on an existing PR, or any request to adjust/redo/continue prior changes. If the ' +
    'newest activity asks for a modification, it is a CHANGE (or a BUG) even when phrased as a ' +
    'question or politely. A ticket that already has a PR and just got feedback is a change ' +
    '(to refresh that PR), not a question.\n' +
    '- KIND=data — they want a read-only data pull / export, with no code change.\n' +
    '- KIND=question — they ONLY want information or an explanation and are NOT asking for ' +
    'any change, fix, or revision.\n\n' +
    'Eligibility: mark INELIGIBLE only if handling it would touch an off-limits path, a DB ' +
    'migration, auth/payments/money logic, or date/timezone logic, or is clearly too ' +
    'large/risky for a small automated change — otherwise mark it eligible. Questions and ' +
    'data pulls are always eligible.',
  clarify:
    'A client asked a question. Read the codebase to answer it accurately and concisely, ' +
    'in plain language a non-engineer can follow. Reply in English. Cite the file(s)/mechanism ' +
    'you based the answer on. Do not change any files.',
  export:
    'The client asked for a read-only data pull / export. Use ONLY the data source and ' +
    'credentials the ticket provides (attachments / links / env) — never guess or use other ' +
    'sources. This is READ-ONLY: never write, update, or delete any data. Produce the requested ' +
    'export as a file in the current directory (CSV unless the ticket says otherwise) and report ' +
    'the file path and a short summary (row count, columns, any filters applied).',
  locate:
    'Find whether an OPEN pull request already exists for THIS ticket (it may have been opened by ' +
    'a human or another agent, on any branch name). Look via `gh pr list` / `gh search prs` by the ' +
    'ticket id and title, any PR linked on the ticket, and existing branch names. Do NOT make any ' +
    'changes. Output EXACTLY one final line:\n' +
    '  REUSE: <branch>   (an OPEN PR for this ticket exists — give its head branch, so we refresh it)\n' +
    '  REUSE: none       (no open PR — start fresh; ignore merged/closed PRs).',
  reproduce:
    'This ticket reports a bug. BEFORE planning any fix, reproduce it and find the root cause. ' +
    'Confirm the buggy behavior actually happens (run the app / write a failing test / follow the ' +
    'repro steps), pin down exactly what triggers it and why (the root cause in the code), and ' +
    'capture a concrete reproduction (steps, a failing test, logs/errors). If you CANNOT reproduce ' +
    'it, say so clearly with what you tried and your best hypothesis. Do NOT fix it yet — only ' +
    'establish the reproduction + root cause so the plan step can act on it.',
  plan:
    'Plan the smallest correct change. State which file(s) you will edit, the exact change, ' +
    'and how you will verify it. Do not edit anything yet.',
  prepare:
    'You are already on a fresh branch in an isolated worktree for this ticket — do NOT ' +
    'create a branch. Read the relevant code so you have the context you need, and make sure ' +
    'the working tree is ready to build/test (install or fetch dependencies if the project ' +
    'needs it). Do not edit product code yet.',
  fix:
    'Implement the plan with the smallest possible diff — touch as few files and lines as possible. ' +
    'Match the surrounding code style and conventions. Never edit off-limits paths. Do not commit yet. ' +
    'When done, summarize exactly which files you changed and why.',
  verify:
    'Check that the change actually works: run the project’s checks/tests/formatters (e.g. its ' +
    'lint/typecheck/test command) and, for a UI change, confirm it renders/behaves correctly ' +
    '(use a browser tool/skill if one is available). Do NOT fix anything here — only judge. If ' +
    'something is broken, fail so the fix step can address it; report exactly what you ran.',
  review:
    'Critically review the uncommitted diff for correctness and scope creep. Be strict about ' +
    'edits outside the ticket’s intent and anything touching off-limits paths. Judge only — do ' +
    'not edit; if there are problems, fail with specifics so the fix step can address them.',
  ship:
    'Commit the change with a short, clear message (no AI attribution line). Push the branch and ' +
    'open a pull request against the default branch — or, if a PR for this branch already exists, ' +
    'push your commits to it. NEVER merge — stop at ready-to-merge. Report the PR URL. ' +
    '(If you want the loop to keep working until CI is green, say so in THIS instruction — the ' +
    'harness will not watch CI for you.)',
  'deploy-dev':
    'Deploy the change you just shipped to the DEV environment only (never staging or production). ' +
    'Use this project\'s own deploy mechanism — describe it here per project (e.g. push the branch ' +
    'to a deploy branch, trigger the dev pipeline, run a deploy CLI). Wait until the deploy actually ' +
    'lands (pipeline success or a health check), then report what you did and where it went live. If ' +
    'there is no dev-deploy step for this project, say so and pass.',
  'verify-dev':
    'The change is now live on DEV. Verify it actually works there: exercise the affected flow ' +
    'against the dev URL / dev API (browser-test it or hit the endpoint) and confirm it behaves as ' +
    'the ticket asked — this is the real-environment check, not the local build. Describe how to ' +
    'reach dev per project. If it works, pass; if not, fail with concrete details for the fix step.',
  comment:
    'Write a concise comment for the ticket, in English, summarizing the outcome: for a question, ' +
    'the answer; for a change, what changed and the PR link. Return only the comment text.',
}

/** Resolve the effective tracker for a project: top-level default < project override. */
export function resolveTracker(cfg: Config, project: ProjectConfig): TrackerConfig {
  return { ...cfg.tracker, ...(project.tracker || {}) }
}

/** Combine the built-in default with the user's instruction per mode. */
export function resolveInstruction(stage: StageName, sc: StageConfig): string {
  const def = DEFAULT_INSTRUCTIONS[stage] || ''
  const user = (sc.instruction || '').trim()
  if (!user) return def
  if (sc.instructionMode === 'append') return `${def}\n\nAdditional instructions:\n${user}`
  return user // 'replace' (default)
}

function mergeStage(base?: StageConfig, over?: StageConfig): StageConfig {
  return { ...(base || {}), ...(over || {}) }
}

/** Resolve the effective stage config for a project: defaults < global < project. */
export function resolveStage(
  cfg: Config,
  stage: StageName,
  projectStages?: StagesConfig,
): StageConfig {
  const merged = mergeStage(
    mergeStage(DEFAULTS.stages[stage], cfg.stages[stage]),
    projectStages?.[stage],
  )
  if (merged.model === undefined) merged.model = cfg.runner.defaultModel
  if (merged.effort === undefined) merged.effort = cfg.runner.defaultEffort
  if (merged.permissionMode === undefined) merged.permissionMode = cfg.runner.permissionMode
  if (merged.enabled === undefined) merged.enabled = true
  return merged
}

function deepMerge<T>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base }
  for (const k of Object.keys(over as object)) {
    const bv = (base as any)[k]
    const ov = (over as any)[k]
    if (
      ov &&
      typeof ov === 'object' &&
      !Array.isArray(ov) &&
      bv &&
      typeof bv === 'object'
    ) {
      out[k] = deepMerge(bv, ov)
    } else if (ov !== undefined) {
      out[k] = ov
    }
  }
  return out
}

export function loadConfig(explicitPath?: string): {
  config: Config
  path: string | null
} {
  const path = findConfigPath(explicitPath)
  if (!path) return { config: structuredClone(DEFAULTS), path: null }
  const raw = parse(readFileSync(path, 'utf8')) || {}
  const config = deepMerge(structuredClone(DEFAULTS), raw)
  validate(config)
  return { config, path }
}

/** Persist config back to YAML (used by the UI when editing projects). */
export function saveConfig(cfg: Config, path: string | null): string {
  // Never write to a non-file sink like /dev/null (used by demo mode).
  const usable = path && !path.startsWith('/dev/') ? path : join(DATA_DIR, 'config.yml')
  mkdirSync(dirname(usable), { recursive: true })
  writeFileSync(usable, stringify(cfg))
  return usable
}

/** Validate a single project (used by the UI upsert endpoint). Throws on error. */
export function validateProject(p: ProjectConfig): void {
  if (!p.name || !/^[\w.-]+$/.test(p.name))
    throw new Error('project name is required (letters, numbers, . _ -)')
  if (!p.repoPath) throw new Error('repoPath is required')
  if (!['clarify', 'propose', 'gated-merge'].includes(p.autonomy))
    throw new Error('autonomy must be clarify, propose, or gated-merge')
  if (p.maxParallel !== undefined && (!Number.isInteger(p.maxParallel) || p.maxParallel < 1))
    throw new Error('maxParallel must be a whole number ≥ 1')
  validateRepos(p)
}

/** Multi-repo `repos` list: non-empty, unique valid names, each with a path. */
export function validateRepos(p: ProjectConfig): void {
  if (p.repos === undefined) return // single-repo — nothing to check
  if (!Array.isArray(p.repos) || p.repos.length === 0)
    throw new Error(`project "${p.name}": repos, when present, must be a non-empty list`)
  const seen = new Set<string>()
  for (const r of p.repos) {
    if (!r.name || !/^[\w.-]+$/.test(r.name))
      throw new Error(`project "${p.name}": each repo needs a name (letters, numbers, . _ -)`)
    if (seen.has(r.name)) throw new Error(`project "${p.name}": duplicate repo name "${r.name}"`)
    seen.add(r.name)
    if (!r.path) throw new Error(`project "${p.name}": repo "${r.name}" needs a path`)
  }
}

function validate(cfg: Config): void {
  if (cfg.auth.mode !== 'subscription' && cfg.auth.mode !== 'api') {
    throw new Error(`auth.mode must be "subscription" or "api"`)
  }
  for (const p of cfg.projects) {
    if (!p.name) throw new Error('every project needs a name')
    if (!p.repoPath) throw new Error(`project "${p.name}" needs repoPath`)
    const validAutonomy = ['clarify', 'propose', 'gated-merge']
    if (!validAutonomy.includes(p.autonomy)) {
      throw new Error(
        `project "${p.name}" autonomy must be one of ${validAutonomy.join(', ')}`,
      )
    }
    validateRepos(p)
  }
}

export { STAGE_ORDER, DEFAULTS }
