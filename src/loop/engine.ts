import type { Config, ProjectConfig, RunRecord, Ticket } from '../types.js'
import { Governor } from '../governor/governor.js'
import type { Tracker } from '../adapters/tracker/tracker.js'
import { makeRepo, type Repo } from '../adapters/repo/github.js'
import { appendRun, getRun, readRuns } from '../store.js'
import { runWorkflow } from './interpreter.js'
import { planForProject } from '../commands/catalog.js'
import { uncertainOperations, OperationReviewError } from './operations.js'
import { reattachWorkspace } from './workspace.js'
import { selectPlan } from './planSnapshot.js'
import { PausedError, ProviderUnavailableError } from './legacyErrors.js'
import { extractImageUrls, downloadImages } from './context.js'
import { DATA_DIR } from '../paths.js'
import { join } from 'node:path'
import { log } from '../logger.js'
import { type Checkpoint, loadCheckpoint, saveCheckpoint, deleteCheckpoint } from './checkpoint.js'
export { resolveBranch } from './workspace.js'
const RESUMABLE_OUTCOMES = new Set([
  'failed',
  'blocked',
  'paused',
  'waiting',
])

let runCounterSeed = 0
function newRunId(ticket: string): string {
  runCounterSeed++
  return `${ticket}-${Date.now().toString(36)}-${runCounterSeed}`
}

export interface EngineCtx {
  reconcileOperation?: import('./operations.js').Reconciler
  invokeAgent?: typeof import('../runner/index.js').runAgent
  cfg: Config
  repo: Repo
  governor: Governor
  mock: boolean
}

export function makeEngineCtx(cfg: Config, mock: boolean): EngineCtx {
  return {
    cfg,
    mock,
    repo: makeRepo(mock),
    governor: new Governor(cfg, mock),
  }
}

export interface ProcessOpts {
  reprocess?: boolean
  trackerKey?: string
  // latest-human-activity marker; a checkpoint from a DIFFERENT marker is stale
  // (the human changed the ask) and is discarded so the run starts fresh.
  marker?: string
  // live pause predicate (the daemon supplies one backed by the control file);
  // checked at every stage boundary. Absent → never pauses (one-shot `run`).
  isPaused?: () => boolean
}

export async function processTicket(
  ctx: EngineCtx,
  ticket: Ticket,
  project: ProjectConfig,
  tracker: Tracker,
  opts: ProcessOpts = {},
): Promise<RunRecord> {
  // ---- Resume checkpoint ---------------------------------------------------
  // Reload a prior attempt's checkpoint if it's for the SAME ask (marker). A
  // checkpoint from different human activity is stale → discard and start fresh.
  const ticketKey = `${project.name}:${ticket.identifier}`
  const marker = opts.marker || ''
  let ck: Checkpoint | null = null
  let checkpointError: string | undefined
  try { ck = loadCheckpoint(ticketKey, true) } catch (e) { checkpointError = String(e instanceof Error ? e.message : e) }
  if (ck && ck.marker !== marker) {
    deleteCheckpoint(ticketKey)
    ck = null
  }
  // A saved intent may exist before the first output. Any checkpoint continues
  // the same run, including a crash before its first model response.
  const resuming = !!ck

  // CONTINUE THE SAME RUN when resuming: an interruption isn't a new attempt, so
  // reuse the checkpoint's record instead of minting another one (no duplicate
  // card, and tokens/cost accumulate into the true total for this work).
  // `stages` is rebuilt as the replay re-walks them, so nothing duplicates.
  const prior = resuming && ck!.runId ? getRun(ck!.runId) : checkpointError
    ? readRuns().find(run => run.project === project.name && run.ticket === ticket.identifier && run.marker === marker) : undefined
  const legacy = ck?.executor === 'legacy' || (!!ck && !ck.executor && !ck.plan && !ck.snapshot && ck.nodeOutputs === undefined && !!ck.stageOutputs)
  let plan: ReturnType<typeof planForProject> | undefined
  try {
    if (checkpointError) throw new Error(checkpointError)
    if (!ctx.mock && uncertainOperations(ticketKey, ck?.runId).length)
      throw new Error('An earlier run has uncertain external actions. Review its saved operations before starting a new run.')
    if (!legacy) {
      if (project.engine === 'legacy' && !ck?.plan && !ck?.snapshot)
        throw new Error('engine: legacy is retired for new runs. Remove the setting or set engine: workflow; existing legacy checkpoints can still finish.')
      const scratch: Checkpoint = ck || { runId: '', ticketKey, marker, imagePaths: [], stageOutputs: {}, updatedAt: 0 }
      plan = selectPlan(scratch, () => planForProject(ctx.cfg, project), ctx.cfg, project)
      if (ck?.workspace && !reattachWorkspace(ck.workspace, ctx.mock))
        throw new Error('Saved worktree is missing. Restore it or review existing PRs and operations before starting fresh.')
      if (!ck) ck = scratch
    }
  } catch (e) {
    const note = String(e instanceof Error ? e.message : e)
    const rec: RunRecord = prior || { id: ck?.runId || newRunId(ticket.identifier), ticket: ticket.identifier,
      ticketTitle: ticket.title, ticketUrl: ticket.url, project: project.name, marker,
      autonomy: project.autonomy, startedAt: Date.now(), outcome: 'waiting', stages: [], totalTokens: 0, costUsd: 0 }
    rec.outcome = 'waiting'
    rec.blocker = { kind: 'approval', reason: note, resume: 'manual' }
    rec.summary = rec.error = note
    rec.endedAt = Date.now()
    appendRun(rec)
    if (!ck && !checkpointError) saveCheckpoint({ runId: rec.id, ticketKey, marker, executor: 'workflow', imagePaths: [], stageOutputs: {}, updatedAt: 0 })
    return rec
  }
  let rec: RunRecord
  if (prior) {
    rec = prior
    rec.stages = []
    rec.outcome = 'running'
    rec.endedAt = undefined
    rec.error = undefined
    rec.blocker = undefined
    rec.waitingProvider = undefined
    rec.resumeAt = undefined
    rec.waitReason = undefined
    rec.resumes = (rec.resumes || 0) + 1
    rec.ticketTitle = ticket.title // keep in sync if it was renamed
    rec.ticketUrl = ticket.url
  } else {
    rec = {
      id: ck?.runId || newRunId(ticket.identifier),
      ticket: ticket.identifier,
      ticketTitle: ticket.title,
      ticketUrl: ticket.url,
      project: project.name,
      marker,
      autonomy: project.autonomy,
      startedAt: Date.now(),
      outcome: 'running',
      stages: [],
      totalTokens: 0,
      costUsd: 0,
    }
  }
  appendRun(rec)

  if (!ck) ck = { runId: rec.id, ticketKey, marker, imagePaths: [], stageOutputs: {}, updatedAt: 0 }
  ck.executor = legacy ? 'legacy' : 'workflow'
  ck.runId = rec.id // a fresh record adopts the checkpoint (and vice versa)
  saveCheckpoint(ck)
  if (resuming)
    log.info(
      `  ⤿ resuming ${ticket.identifier}${prior ? ` (run ${rec.id}, continue #${rec.resumes})` : ''} — ${Object.keys(ck.nodeOutputs || ck.stageOutputs).length} stage(s) cached`,
    )

  try {
    // Download any ticket images so the model can actually see them. On resume,
    // reuse the previously-downloaded paths instead of re-fetching.
    let imagePaths: string[] = ck.imagePaths || []
    if (!ctx.mock && !imagePaths.length) {
      const urls = extractImageUrls(ticket)
      if (urls.length) {
        imagePaths = await downloadImages(urls, opts.trackerKey || '', join(DATA_DIR, 'images', rec.id))
        if (imagePaths.length) log.info(`  ⤓ downloaded ${imagePaths.length} image(s) for ${ticket.identifier}`)
      }
      ck.imagePaths = imagePaths
    }
    if (legacy) {
      log.warn('continuing a legacy checkpoint; new runs use the workflow interpreter')
      const { runLegacyPipeline } = await import('./legacy.js')
      return await runLegacyPipeline(ctx, ticket, project, rec, ck, opts, imagePaths)
    }
    return await runWorkflow(ctx, plan!, ticket, project, rec, ck, {
      trackerKey: opts.trackerKey, isReprocess: !!opts.reprocess,
      isPaused: opts.isPaused, imagePaths,
    })
  } catch (e) {
    if (e instanceof OperationReviewError) {
      rec.blocker = { kind: 'approval', reason: e.message, resume: 'manual' }
      finish(rec, 'waiting', e.message)
      return rec
    }
    if (e instanceof PausedError) {
      // Not a failure — the loop was asked to pause. Keep the worktree +
      // checkpoint; `resume` continues from this exact stage.
      finish(rec, 'paused', `Paused before "${e.stage}". Resume to continue.`)
      return rec
    }
    if (e instanceof ProviderUnavailableError) {
      rec.blocker = { kind: 'provider', reason: `${e.provider} quota is unavailable; resume from "${e.stage}" when the provider allows it.`, resume: 'automatic', provider: e.provider, resumeAt: e.resumeAt }
      finish(rec, 'waiting', rec.blocker.reason)
      return rec
    }
    const msg = String(e)
    finish(rec, 'failed', msg)
    rec.error = msg
    appendRun(rec)
    return rec
  } finally {
    // Keep the checkpoint only for outcomes that resume; otherwise the work is
    // done (or abandoned) — remove it so a fresh ask starts clean.
    if (RESUMABLE_OUTCOMES.has(rec.outcome)) saveCheckpoint(ck)
    else deleteCheckpoint(ticketKey)
  }
}
function finish(rec: RunRecord, outcome: RunRecord['outcome'], note: string) {
  rec.outcome = outcome
  rec.endedAt = Date.now()
  const last = rec.stages[rec.stages.length - 1]
  if (last && last.status === 'running') { last.status = 'ok'; last.endedAt = Date.now() }
  // Every outcome carries its reason, not just the failing ones (see the same
  // change in interpreter.ts — both engines must record history identically).
  rec.summary = note
  rec.error = outcome === 'failed' || outcome === 'blocked' ? note : rec.error
  log.info(`  = ${rec.ticket}: ${outcome} — ${note}`)
  appendRun(rec)
}
