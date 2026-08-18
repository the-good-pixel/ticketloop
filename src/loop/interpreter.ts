// The workflow interpreter: executes a compiled ExecutionPlan against a ticket.
//
// This is the replacement for the hard-coded pipeline in engine.ts. The plan
// decides the SHAPE (what runs, in what order, what a result means); this file
// only knows how to execute one node, honor a transition, and keep the run
// resumable. Git isolation, the off-limits guardrail, quota waits, pause, usage
// accounting and run history all reuse the same code the legacy engine uses.
//
// It is off by default. A project opts in with `engine: workflow`.

import type {
  AgentProvider,
  Config,
  ProjectConfig,
  PrRecord,
  RunOutcome,
  RunRecord,
  StageName,
  StageRecord,
  Ticket,
  WaitBlocker,
  WaitKind,
} from '../types.js'
import type { Artifact, StepResult, TerminalClass } from '../catalog/types.js'
import type {
  CompiledLoopNode,
  CompiledPhase,
  CompiledStepNode,
  ExecutionPlan,
} from '../catalog/compile.js'
import { checkpointKey } from '../catalog/compile.js'
import { runAgent, type AgentResult } from '../runner/index.js'
import { Governor } from '../governor/governor.js'
import { setRateLimited, clearRateLimited } from '../governor/cooldown.js'
import type { Repo } from '../adapters/repo/github.js'
import { appendRun, appendUsage } from '../store.js'
import { log } from '../logger.js'
import { buildNodePrompt, type PriorOutput } from './nodePrompt.js'
import { parseResult, parseRouteField, parseRouteReason } from './verdict.js'
import { artifactSucceeded, extractArtifact, parseCommentUrl } from './artifacts.js'
import {
  reattachWorkspace,
  scanRepos,
  setupWorkspace,
  toWorkspaceCk,
  type WorkRepo,
  type Workspace,
} from './workspace.js'
import { type Checkpoint, saveCheckpoint } from './checkpoint.js'
import { legacyWaitKind } from '../waiting.js'

export interface InterpCtx {
  cfg: Config
  repo: Repo
  governor: Governor
  mock: boolean
}

/** How a node's execution continues. Signals bubble up until something owns them. */
type Signal =
  | { type: 'continue' }
  | { type: 'stop'; terminal: TerminalClass; outcome?: RunOutcome; note?: string; reported?: boolean }
  | { type: 'suspend'; blocker: WaitBlocker; nodeId: string }
  | { type: 'repair'; loopId: string; detail: string }
  | { type: 'exit-loop'; loopId?: string }

const CONTINUE: Signal = { type: 'continue' }

/** Live state for one interpreted run. */
interface State {
  rec: RunRecord
  ck: Checkpoint
  plan: ExecutionPlan
  ticket: Ticket
  project: ProjectConfig
  paused: () => boolean
  trackerKey?: string
  isReprocess: boolean
  imagePaths: string[]
  /** produce-key → the text a completed node emitted. */
  outputs: Map<string, { label: string; text: string }>
  artifacts: Record<string, Artifact>
  /** Created lazily, the first time a node actually needs a repo to work in. */
  ws?: Workspace
  /** Repos with changes as of the last guardrail scan. */
  dirty: WorkRepo[]
  prs: PrRecord[]
  /** Set when the workflow finished, but not cleanly (loop exhausted, ship gaps). */
  degraded?: string
  /** The REASON the route step gave for the branch it just sent us down. A stop
   *  node's own note describes the terminal generically ("ineligible"); this is
   *  the model's specific account of why THIS ticket went there.
   *
   *  Cleared as soon as any step runs: once real work starts, how the run ends
   *  is no longer explained by the routing call. Without that, a triage reason
   *  would still be glued onto an unrelated terminal ten steps later, such as a
   *  repair loop exhausting. */
  routeReason?: string
  iteration: number
  openFindings?: string
  /** Per-loop counters. Shared so a repair sent back from a LATER node (a failed
   *  ship) continues the same bounded budget instead of restarting it. */
  loops: Map<string, { iteration: number; lastSig: string }>
}

export class WorkflowPaused extends Error {
  constructor(public nodeId: string) {
    super(`paused before "${nodeId}"`)
  }
}

export interface RunWorkflowOpts {
  trackerKey?: string
  isReprocess?: boolean
  isPaused?: () => boolean
  imagePaths?: string[]
}

// ---- entry point -----------------------------------------------------------

export async function runWorkflow(
  ctx: InterpCtx,
  plan: ExecutionPlan,
  ticket: Ticket,
  project: ProjectConfig,
  rec: RunRecord,
  ck: Checkpoint,
  opts: RunWorkflowOpts = {},
): Promise<RunRecord> {
  const s: State = {
    rec,
    ck,
    plan,
    ticket,
    project,
    paused: opts.isPaused || (() => false),
    trackerKey: opts.trackerKey,
    isReprocess: !!opts.isReprocess,
    imagePaths: opts.imagePaths || [],
    outputs: new Map(),
    artifacts: (ck.artifacts as Record<string, Artifact>) || {},
    dirty: [],
    prs: [],
    iteration: 1,
    loops: new Map(),
  }
  // Pin the run to this plan so a later Resume can tell whether the live catalog
  // moved underneath it.
  s.ck.plan = { workflowId: plan.workflow.id, version: plan.workflow.version, digest: plan.digest }
  s.ck.nodeOutputs = s.ck.nodeOutputs || {}
  const cachedCount = Object.keys(s.ck.nodeOutputs).length
  if (cachedCount)
    log.info(`  ⤿ resuming ${ticket.identifier} on ${plan.workflow.id}@${plan.workflow.version} — ${cachedCount} node(s) cached`)
  if (s.ck.workspace && reattachWorkspace(s.ck.workspace, ctx.mock)) {
    s.ws = reattachWorkspace(s.ck.workspace, ctx.mock)!
  } else if (s.ck.workspace) {
    // The worktree is gone (a human cleaned up). Cached edits are unusable —
    // replaying them into an empty tree would look like "no changes".
    log.warn('  checkpoint worktree gone — discarding cached work, starting fresh')
    s.ck.nodeOutputs = {}
    s.ck.workspace = undefined
  }

  let signal: Signal
  try {
    signal = await runPhases(ctx, s, plan.phases)
  } catch (e) {
    if (e instanceof WorkflowPaused) {
      finish(s, 'paused', `Paused before "${e.nodeId}". Resume to continue.`)
      return rec
    }
    const msg = String(e)
    // An unexpected throw still deserves a report — a silent ticket is the
    // failure mode this design exists to prevent.
    await runFinally(ctx, s, 'failed')
    finish(s, 'failed', msg)
    rec.error = msg
    return rec
  }

  // --- Resolve the terminal --------------------------------------------------
  if (signal.type === 'suspend') {
    await runFinally(ctx, s, 'waiting')
    rec.blocker = signal.blocker
    finish(s, 'waiting', signal.blocker.reason || `Waiting at "${signal.nodeId}".`)
    return rec
  }
  const terminal: TerminalClass =
    signal.type === 'stop' ? signal.terminal : s.degraded ? 'partial' : 'success'
  const explicit = signal.type === 'stop' ? signal : undefined
  // A clean finish that had to degrade (loop exhausted, a repo failed to ship)
  // is reported as partial, never as a clean success.
  const cls: TerminalClass = terminal === 'success' && s.degraded ? 'partial' : terminal
  if (!explicit?.reported) await runFinally(ctx, s, cls)
  const note = withRouteReason(s, explicit?.note || describeOutcome(s, cls))
  if (cls === 'waiting' && !rec.blocker) {
    rec.blocker = { kind: 'external', reason: note, resume: 'manual' }
  }
  finish(s, resolveOutcome(s, cls, explicit?.outcome), note)
  return rec
}

// A stop node's note names the terminal in general terms ("Triage: ineligible
// for the automated loop"), which is the part a user can already infer from the
// outcome badge. The routing REASON is the part they cannot: what about THIS
// ticket led there. Append it rather than replace, so the note keeps saying
// which gate stopped the run.
function withRouteReason(s: State, note: string): string {
  if (!s.routeReason) return note
  if (note.toLowerCase().includes(s.routeReason.toLowerCase())) return note
  return `${note.replace(/\s*[.]?\s*$/, '')} — ${s.routeReason}`
}

// ---- phase walking ---------------------------------------------------------

async function runPhases(ctx: InterpCtx, s: State, phases: CompiledPhase[]): Promise<Signal> {
  let i = 0
  while (i < phases.length) {
    const sig = await runPhase(ctx, s, phases[i])
    if (sig.type === 'continue') {
      i++
      continue
    }
    // A `<loop>.repair` transition from a node AFTER the loop — a failed ship
    // sending work back to the implement step. Re-enter that loop rather than
    // unwinding: this is the whole point of keeping ship outside the loop but
    // still able to reach it.
    if (sig.type === 'repair') {
      const back = phases.findIndex((p) => p.kind === 'loop' && p.id === sig.loopId)
      if (back >= 0 && back < i) {
        const loop = phases[back] as CompiledLoopNode
        const room = bumpLoop(s, loop, sig.detail)
        if (!room) return exhausted(s, loop)
        log.info(`  ↩ ${sig.loopId}: repairing after "${phases[i].kind === 'step' ? (phases[i] as CompiledStepNode).id : ''}" failed`)
        i = back
        continue
      }
    }
    return sig // bubble to whoever owns it
  }
  return CONTINUE
}

/** Advance a loop's shared counter. False when its iteration budget is spent. */
function bumpLoop(s: State, loop: CompiledLoopNode, detail: string): boolean {
  const st = loopState(s, loop.id)
  if (st.iteration >= loop.maxIterations) return false
  st.iteration++
  s.openFindings = `A later step reported problems:\n${detail.slice(0, 1500)}`
  return true
}

function loopState(s: State, id: string) {
  let st = s.loops.get(id)
  if (!st) {
    st = { iteration: 1, lastSig: '' }
    s.loops.set(id, st)
  }
  return st
}

/**
 * A loop that ran out of road. Nothing shipped means the run genuinely failed;
 * a PR that exists but still carries findings is partial, not a failure.
 */
function exhausted(s: State, loop: CompiledLoopNode): Signal {
  s.degraded = s.degraded || `"${loop.id}" did not clear within ${loop.maxIterations} attempt(s).`
  const shipped = s.prs.some((p) => p.status === 'opened')
  return loop.noProgress === 'stop'
    ? { type: 'stop', terminal: shipped ? 'partial' : 'failed', note: s.degraded }
    : CONTINUE
}

async function runPhase(ctx: InterpCtx, s: State, phase: CompiledPhase): Promise<Signal> {
  switch (phase.kind) {
    case 'step':
      return runStepNode(ctx, s, phase)
    case 'stop':
      return {
        type: 'stop',
        terminal: phase.terminal,
        outcome: phase.outcome as RunOutcome | undefined,
        note: phase.note,
        reported: phase.reported,
      }
    case 'branch': {
      const source = s.outputs.get(s.plan.nodes.get(phase.on.nodeId)?.step.produces.key || '')
      const value = source ? parseRouteField(source.text, phase.on.field) : undefined
      // Capture the routing rationale even when the branch continues — a later
      // stop still benefits from knowing why the ticket took this path.
      const reason = source ? parseRouteReason(source.text) : undefined
      if (reason) s.routeReason = reason
      const chosen = value ? phase.cases[value] : undefined
      if (chosen) {
        log.info(`  ⑂ ${phase.id}: ${phase.on.field}=${value}${reason ? ` — ${reason}` : ''}`)
        return runPhases(ctx, s, chosen)
      }
      if (Array.isArray(phase.default)) {
        log.info(`  ⑂ ${phase.id}: ${phase.on.field}=${value ?? '(unset)'} → default${reason ? ` — ${reason}` : ''}`)
        return runPhases(ctx, s, phase.default)
      }
      if (phase.default === 'stop') return { type: 'stop', terminal: 'skipped', note: `No branch matched ${phase.on.field}.` }
      return CONTINUE // 'continue'
    }
    case 'loop':
      return runLoop(ctx, s, phase)
  }
}

// ---- the bounded repair loop -----------------------------------------------

async function runLoop(ctx: InterpCtx, s: State, loop: CompiledLoopNode): Promise<Signal> {
  const st = loopState(s, loop.id)
  while (true) {
    const iteration = st.iteration
    s.iteration = iteration
    const repaired = await runStepNode(ctx, s, loop.repair, iteration)
    if (repaired.type !== 'continue') return repaired

    // Run gates in order; the first non-pass short-circuits — reviewing a change
    // that verification already rejected is wasted model time.
    let failure: { nodeId: string; detail: string } | undefined
    let exiting = false
    for (const gate of loop.gates) {
      const sig = await runStepNode(ctx, s, gate, iteration)
      if (sig.type === 'continue') continue
      if (sig.type === 'exit-loop' && (!sig.loopId || sig.loopId === loop.id)) {
        exiting = true
        break
      }
      if (sig.type === 'repair' && sig.loopId === loop.id) {
        failure = { nodeId: gate.id, detail: sig.detail }
        break
      }
      return sig // suspend / stop / a repair aimed at an OUTER loop
    }
    if (exiting || !failure) return CONTINUE // every gate passed

    // --- decide whether another repair pass is worth it ---------------------
    if (iteration >= loop.maxIterations) {
      log.warn(`  ↻ ${loop.id}: iteration cap reached — ${s.ticket.identifier}`)
      s.degraded = `"${loop.id}" did not clear within ${loop.maxIterations} attempt(s).`
      return exhausted(s, loop)
    }
    // No-progress backstop: identical findings twice means the model is stuck,
    // and another identical pass is pure waste.
    const sig = djb2(`${failure.nodeId}::${failure.detail}`)
    if (sig === st.lastSig) {
      log.warn(`  ↻ ${loop.id}: identical findings twice — stopping the loop`)
      s.degraded = `"${loop.id}" made no progress between attempts.`
      return exhausted(s, loop)
    }
    st.lastSig = sig
    s.openFindings = `The "${failure.nodeId}" step reported problems:\n${failure.detail.slice(0, 1500)}`
    st.iteration++
    log.info(`  ↻ ${loop.id} attempt ${st.iteration}/${loop.maxIterations} — ${s.ticket.identifier}`)
  }
}

// ---- one node --------------------------------------------------------------

async function runStepNode(
  ctx: InterpCtx,
  s: State,
  node: CompiledStepNode,
  iteration?: number,
): Promise<Signal> {
  // Real work begins here, so the last routing call stops being the explanation
  // for how this run ends. See State.routeReason.
  s.routeReason = undefined
  if (!node.settings.enabled) {
    recordSkipped(s, node, 'step disabled')
    return applyTransition(s, node, 'skip', '')
  }

  // A per-repo step runs once for every repo that actually changed. With no
  // changed repo there is nothing to ship — which is a skip, not a failure.
  if (node.step.capabilities.perRepo === 'changed') {
    return runPerRepo(ctx, s, node, iteration)
  }

  const key = checkpointKey(s.plan, node.id, iteration)
  const res = await invoke(ctx, s, node, key, iteration)
  if ('signal' in res) return res.signal
  return applyResult(ctx, s, node, res.text, res.result, res.reason, res.blockerKind)
}

/** Ship-like steps: one invocation per changed repo, each with its own key. */
async function runPerRepo(
  ctx: InterpCtx,
  s: State,
  node: CompiledStepNode,
  iteration?: number,
): Promise<Signal> {
  await ensureWorkspace(ctx, s, node)
  const guard = guardrail(ctx, s)
  if (guard) return guard
  if (!s.dirty.length) {
    // Nothing changed. If a PR already exists this is a normal resumed run;
    // otherwise the earlier steps genuinely produced nothing.
    const had = Object.values(s.artifacts).some((a) => a.type === 'github-pr')
    recordSkipped(s, node, had ? 'no new changes to ship' : 'no file changes were produced')
    if (!had) s.degraded = 'No file changes were produced, so nothing was shipped.'
    return applyTransition(s, node, 'skip', '')
  }

  let worst: { result: StepResult; reason: string; text: string; blockerKind?: WaitKind } | undefined
  for (const repo of s.dirty) {
    const key = checkpointKey(s.plan, node.id, iteration, repo.name)
    const res = await invoke(ctx, s, node, key, iteration, repo)
    if ('signal' in res) return res.signal
    const artifact = extractArtifact(node.step, res.text, res.result, repo.name)
    const ok = res.result === 'pass' && artifactSucceeded(artifact)
    s.prs.push({
      repo: repo.name,
      branch: repo.branch,
      url: artifact?.type === 'github-pr' ? artifact.url : undefined,
      status: ok ? 'opened' : 'failed',
      error: ok ? undefined : firstLine(res.text),
    })
    if (artifact && ok) s.artifacts[node.step.produces.key] = artifact
    storeOutput(s, node, res.text)
    if (!ok && !worst) {
      worst = {
        result: res.result === 'pass' ? 'fail' : res.result,
        reason: res.reason,
        text: res.text,
        blockerKind: res.blockerKind,
      }
    }
  }
  const opened = s.prs.filter((p) => p.status === 'opened')
  s.rec.prUrl = opened[0]?.url
  if (s.ws?.multi) s.rec.prs = s.prs
  if (worst) {
    if (opened.length) s.degraded = `${s.prs.length - opened.length} repo(s) failed to ship.`
    return applyTransition(s, node, worst.result, worst.text, worst.reason, worst.blockerKind)
  }
  return applyTransition(s, node, 'pass', '')
}

/** Result of one model invocation, or a signal that unwound it. */
type Invoked = { text: string; result: StepResult; reason: string; blockerKind?: WaitKind } | { signal: Signal }

async function invoke(
  ctx: InterpCtx,
  s: State,
  node: CompiledStepNode,
  key: string,
  iteration?: number,
  repo?: WorkRepo,
): Promise<Invoked> {
  const step = node.step

  // --- REPLAY -------------------------------------------------------------
  // `replay` reuses the cached output with no model call — this is what fast-
  // forwards a resumed run to the node that actually stopped. `rerun` and
  // `revalidate` deliberately do NOT trust a cached pass: local state and
  // external state both move while a run is interrupted.
  const cached = s.ck.nodeOutputs?.[key]
  if (cached !== undefined && step.resumePolicy === 'replay') {
    log.info(`  ⤿ ${node.id} (cached)`)
    const sr = beginStage(s.rec, step.id as StageName, node)
    endStage(s.rec, sr, 'ok', `⤿ resumed (cached) — ${firstLine(cached)}`, cached)
    storeOutput(s, node, cached)
    return { text: cached, ...classify(step, cached) }
  }
  if (cached !== undefined && step.resumePolicy === 'idempotent') {
    // The step already posted. Re-posting would double-comment on the ticket.
    log.info(`  ⤿ ${node.id} (already delivered)`)
    const sr = beginStage(s.rec, step.id as StageName, node)
    endStage(s.rec, sr, 'ok', `⤿ already delivered — ${firstLine(cached)}`, cached)
    storeOutput(s, node, cached)
    return { text: cached, ...classify(step, cached) }
  }

  // --- PAUSE boundary ------------------------------------------------------
  if (s.paused()) {
    persist(s)
    throw new WorkflowPaused(node.id)
  }

  // --- QUOTA ---------------------------------------------------------------
  // Provider exhaustion is a HARNESS event, never a model verdict: it suspends
  // the node and keeps the checkpoint so the same run continues later.
  const provider = (node.settings.provider || ctx.cfg.runner.defaultProvider) as AgentProvider
  const gate = ctx.mock ? { ok: true, resetAt: undefined } : ctx.governor.canRun(provider)
  if (!gate.ok) {
    persist(s)
    return {
      signal: {
        type: 'suspend',
        nodeId: node.id,
        blocker: {
          kind: 'provider',
          reason: `${provider} quota is unavailable`,
          resume: 'automatic',
          provider,
          resumeAt: gate.resetAt,
        },
      },
    }
  }

  await ensureWorkspace(ctx, s, node)
  const workdir = repo?.workdir || workdirFor(s, node)
  const sr = beginStage(s.rec, step.id as StageName, node)
  log.info(
    `  ▸ ${node.id} (${provider}/${node.settings.model || 'default'})${node.settings.skill ? ` +skill:${node.settings.skill}` : ''} — ${s.rec.ticket}`,
  )

  const res = await runAgent({
    prompt: buildNodePrompt(step, {
      ticket: s.ticket,
      project: s.project,
      workdir,
      instruction: node.settings.instruction,
      imagePaths: s.imagePaths,
      isReprocess: s.isReprocess,
      workspace: s.ws?.multi ? s.ws.repos.map((r) => ({ name: r.name, base: r.base, readOnly: r.shipDisabled })) : undefined,
      targetRepo: repo?.name,
      priors: priorsFor(s, node),
      iteration,
      openFindings: s.openFindings,
    }),
    cwd: workdir,
    stage: {
      enabled: true,
      provider,
      model: node.settings.model,
      effort: node.settings.effort as never,
      permissionMode: node.settings.permissionMode as never,
      skill: node.settings.skill,
      allowedTools: node.settings.allowedTools,
    },
    runner: ctx.cfg.runner,
    authMode: ctx.cfg.runner.providers[provider].authMode,
    mcp: s.project.mcp || ctx.cfg.mcp,
    mock: ctx.mock,
    mockKind: step.id,
    // Post steps get the tracker key in the ENV so they hit the right workspace
    // via the API. It never enters the prompt text and is never logged.
    env:
      step.capabilities.externalEffects.includes('tracker-comment') && s.trackerKey && ctx.cfg.tracker.type === 'linear'
        ? { LINEAR_API_KEY: s.trackerKey }
        : undefined,
    ticketKey: `${s.project.name}:${s.ticket.identifier}`,
  })

  if (!res.isError && looksLikeGarbage(res.text)) {
    res.isError = true
    res.text = `withheld non-answer output: ${firstLine(res.text)}`
  }
  accountUsage(ctx, s, res, step.id as StageName, sr)
  endStage(s.rec, sr, res.isError || res.failure ? 'failed' : 'ok', firstLine(res.text), res.text)

  if (res.failure?.kind === 'quota-exhausted') {
    const limit = setRateLimited(res.provider, res.failure.retryAt, res.failure.message, res.failure.scope)
    persist(s)
    return {
      signal: {
        type: 'suspend',
        nodeId: node.id,
        blocker: {
          kind: 'provider',
          reason: limit.message || `${res.provider} quota is unavailable`,
          resume: 'automatic',
          provider: res.provider,
          resumeAt: limit.retryAt || limit.nextProbeAt,
        },
      },
    }
  }
  if (res.isError) throw new Error(`step "${node.id}" failed: ${firstLine(res.text)}`)
  clearRateLimited(res.provider, Date.now())

  s.ck.nodeOutputs![key] = res.text
  storeOutput(s, node, res.text)
  persist(s)
  return { text: res.text, ...classify(step, res.text) }
}

/** Turn raw output into a result according to the step's contract. */
function classify(
  step: CompiledStepNode['step'],
  text: string,
): { result: StepResult; reason: string; blockerKind?: WaitKind } {
  if (step.contract === 'verdict') return parseResult(text)
  return { result: 'pass', reason: '' } // non-gates simply complete
}

async function applyResult(
  ctx: InterpCtx,
  s: State,
  node: CompiledStepNode,
  text: string,
  result: StepResult,
  reason: string,
  blockerKind?: WaitKind,
): Promise<Signal> {
  const artifact = extractArtifact(node.step, text, result, s.project.name)
  if (artifact) s.artifacts[node.step.produces.key] = artifact
  if (node.step.contract === 'post') {
    const url = parseCommentUrl(text)
    if (url) s.rec.commentUrl = url
  }
  // The guardrail runs after ANY step that may have touched the repo — more
  // often than the legacy engine checked, and a git diff is cheap next to a
  // model call.
  if (node.step.capabilities.mutatesRepo) {
    const blocked = guardrail(ctx, s)
    if (blocked) return blocked
  }
  return applyTransition(s, node, result, text, reason, blockerKind)
}

function applyTransition(
  s: State,
  node: CompiledStepNode,
  result: StepResult,
  text: string,
  reason = '',
  blockerKind?: WaitKind,
): Signal {
  const target = node.transitions[result] || 'next'
  switch (target) {
    case 'next':
    case 'continue':
      return CONTINUE
    case 'stop':
      return {
        type: 'stop',
        terminal: result === 'pass' ? 'success' : result === 'wait' ? 'waiting' : 'failed',
        note: `"${node.id}" ended the run: ${reason || firstLine(text) || result}`,
      }
    case 'suspend': {
      const detail = reason || firstLine(text) || `Waiting at "${node.id}".`
      return {
        type: 'suspend',
        nodeId: node.id,
        blocker: {
          kind: blockerKind || waitingKind(node),
          reason: detail,
          resume: 'manual',
        },
      }
    }
    case 'exit-loop':
      return { type: 'exit-loop', loopId: node.loopId }
    case 'repair':
      return { type: 'repair', loopId: node.loopId!, detail: text }
    default: {
      const m = target.match(/^(.+)\.repair$/)
      if (m) return { type: 'repair', loopId: m[1], detail: text }
      log.warn(`node "${node.id}": unknown transition "${target}" — continuing`)
      return CONTINUE
    }
  }
}

/** Classify WHY a node is waiting, so the dashboard can say what to do. */
function waitingKind(node: CompiledStepNode): WaitKind {
  if (node.step.capabilities.externalEffects.includes('deploy-dev')) return 'deployment'
  return 'external'
}

// ---- workspace + guardrail --------------------------------------------------

/** Create the worktree(s) the first time a node actually needs a repo. */
async function ensureWorkspace(ctx: InterpCtx, s: State, node: CompiledStepNode): Promise<void> {
  const need = node.step.capabilities.workspace
  if (need === 'none' || need === 'checkout') return
  if (s.ws) return
  // `locate` may have named an open PR's branch to refresh.
  const reuseBranch = parseReuse(s.outputs.get('reuseBranch')?.text || '')
  s.ws = setupWorkspace(ctx, s.project, s.ticket.identifier, reuseBranch, s.ck.workspace)
  s.ck.workspace = toWorkspaceCk(s.ws)
  persist(s)
}

function workdirFor(s: State, node: CompiledStepNode): string {
  const need = node.step.capabilities.workspace
  if (need === 'none' || need === 'checkout') return s.project.repoPath
  return s.ws?.cwd || s.project.repoPath
}

/** The one deterministic safety check. Returns a stop signal when it trips. */
function guardrail(ctx: InterpCtx, s: State): Signal | undefined {
  if (!s.ws) return undefined
  const scan = scanRepos(ctx, s.project, s.ws)
  s.dirty = scan.dirty
  if (scan.block) return { type: 'stop', terminal: 'blocked', note: scan.block, reported: false }
  return undefined
}

// ---- final reporting --------------------------------------------------------

/**
 * The dependable report. It runs on success, partial completion, waiting AND
 * failure, so a ticket is never left silent — and it is skipped when the path
 * already replied (a `reported` terminal), so nothing double-posts.
 */
async function runFinally(ctx: InterpCtx, s: State, cls: TerminalClass): Promise<void> {
  for (const node of s.plan.finallyNodes) {
    if (!node.runOn?.includes(cls)) continue
    if (!node.settings.enabled) continue
    try {
      // Scoped by terminal class: a run that reported failure and then resumed
      // to success must report the success too.
      const key = checkpointKey(s.plan, node.id, undefined, cls)
      const res = await invoke(ctx, s, node, key)
      if ('signal' in res) return // paused / out of quota — report on the next resume
      if (node.step.contract === 'post') {
        const url = parseCommentUrl(res.text)
        if (url) s.rec.commentUrl = url
      }
    } catch (e) {
      // A failed report must not turn a successful run into a failed one.
      log.warn(`final report "${node.id}" failed: ${e}`)
    }
  }
}

// ---- outcome mapping --------------------------------------------------------

function resolveOutcome(s: State, cls: TerminalClass, explicit?: RunOutcome): RunOutcome {
  if (explicit) return legacyWaitKind(explicit as string) ? 'waiting' : explicit
  const mapping = s.plan.outcomes[cls]
  if (!mapping) return cls === 'success' ? 'pr-opened' : 'failed'
  // An upgraded outcome must be EARNED by a real artifact — never inferred from
  // "the deploy step was enabled".
  for (const [key, outcome] of Object.entries(mapping.whenArtifact || {})) {
    if (artifactSucceeded(s.artifacts[key])) return legacyWaitKind(outcome as string) ? 'waiting' : outcome
  }
  return legacyWaitKind(mapping.default as string) ? 'waiting' : mapping.default
}

function describeOutcome(s: State, cls: TerminalClass): string {
  const pr = s.rec.prUrl ? ` · PR: ${s.rec.prUrl}` : ''
  if (cls === 'success') {
    const dep = s.artifacts['devDeployment']
    return dep && artifactSucceeded(dep) ? `Deployed to dev${pr}.` : `Completed${pr}.`
  }
  if (cls === 'partial') return `${s.degraded || 'Completed with unresolved findings.'}${pr}`
  return `${cls}${pr}`
}

// ---- prior outputs ----------------------------------------------------------

/** The earlier outputs THIS step declared it wants, in a stable order. */
function priorsFor(s: State, node: CompiledStepNode): PriorOutput[] {
  const keys = [...(node.step.requires || []), ...(node.step.consumes || [])]
  const seen = new Set<string>()
  const out: PriorOutput[] = []
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    const artifact = s.artifacts[key]
    if (artifact) {
      out.push({ key, label: `Recorded ${key}`, text: JSON.stringify(artifact) })
      continue
    }
    const prior = s.outputs.get(key)
    if (prior) out.push({ key, label: prior.label, text: prior.text })
  }
  return out
}

function storeOutput(s: State, node: CompiledStepNode, text: string): void {
  s.outputs.set(node.step.produces.key, { label: `Result of the ${node.step.id} step`, text })
}

// ---- bookkeeping ------------------------------------------------------------

function persist(s: State): void {
  s.ck.artifacts = s.artifacts
  saveCheckpoint(s.ck)
}

function accountUsage(ctx: InterpCtx, s: State, res: AgentResult, stage: StageName, sr: StageRecord): void {
  appendUsage({
    ts: Date.now(),
    runId: s.rec.id,
    ticket: s.rec.ticket,
    stage,
    provider: res.provider,
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: res.cacheReadTokens,
    cacheCreationTokens: res.cacheCreationTokens,
    totalTokens: res.totalTokens,
    costUsd: res.costUsd,
    authMode: ctx.cfg.runner.providers[res.provider].authMode,
  })
  s.rec.totalTokens += res.totalTokens
  s.rec.costUsd += res.costUsd
  sr.totalTokens = res.totalTokens
  sr.costUsd = res.costUsd
}

function beginStage(rec: RunRecord, stage: StageName, node: CompiledStepNode): StageRecord {
  const sr: StageRecord = {
    stage,
    status: 'running',
    startedAt: Date.now(),
    provider: node.settings.provider,
    model: node.settings.model,
    nodeId: node.id,
  }
  rec.stages.push(sr)
  appendRun(rec)
  return sr
}

function endStage(rec: RunRecord, sr: StageRecord, status: StageRecord['status'], summary?: string, detail?: string) {
  sr.status = status
  sr.endedAt = Date.now()
  if (summary) sr.summary = summary
  if (detail) sr.detail = detail.slice(0, 4000)
  appendRun(rec)
}

function recordSkipped(s: State, node: CompiledStepNode, why: string): void {
  const sr = beginStage(s.rec, node.step.id as StageName, node)
  endStage(s.rec, sr, 'skipped', why)
}

function finish(s: State, outcome: RunOutcome, note: string): void {
  const rec = s.rec
  rec.outcome = outcome
  rec.endedAt = Date.now()
  const last = rec.stages[rec.stages.length - 1]
  if (last && last.status === 'running') endStage(rec, last, 'ok')
  // Persist the reason for EVERY outcome. `error` only ever covered failures, so
  // a skipped run kept its explanation in the daemon log and nowhere the user
  // could see it.
  rec.summary = note
  if (outcome === 'failed' || outcome === 'blocked' || outcome.startsWith('waiting')) rec.error = note
  log.info(`  = ${rec.ticket}: ${outcome} — ${note}`)
  appendRun(rec)
}

// ---- small helpers ----------------------------------------------------------

function parseReuse(text: string): string | undefined {
  const m = (text || '').match(/REUSE:\s*(\S+)/i)
  if (!m || /^none$/i.test(m[1])) return undefined
  return m[1].trim().replace(/[).,]+$/, '')
}

function looksLikeGarbage(t: string): boolean {
  if (!t || !t.trim()) return true
  return (
    t.includes('step of an automated dev-cycle loop') ||
    t.includes('SECURITY: the ticket title/description') ||
    /(^|\n)\s*Invalid argument:/.test(t) ||
    t.includes('Valid options are: low, medium, high')
  )
}

function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const firstLine = (s: string) => (s || '').trim().split('\n')[0]?.slice(0, 160) || ''
