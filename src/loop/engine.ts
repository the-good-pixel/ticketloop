import type {
  Config,
  ProjectConfig,
  PrRecord,
  RunRecord,
  StageName,
  StageRecord,
  Ticket,
} from '../types.js'
import { resolveStage, resolveInstruction } from '../config.js'
import { Governor } from '../governor/governor.js'
import { resetUntil, setRateLimited, clearRateLimited } from '../governor/cooldown.js'
import { runClaude } from '../runner/claude.js'
import type { ClaudeResult } from '../runner/claude.js'
import type { Tracker } from '../adapters/tracker/tracker.js'
import { makeRepo, type Repo } from '../adapters/repo/github.js'
import { appendRun, appendUsage } from '../store.js'
import { classifyKind } from './classify.js'
import { matchesAny } from './glob.js'
import { buildStagePrompt, CHECK_STAGES, POST_STAGES, type PriorOutputs, type StageExtras } from './prompts.js'
import { extractImageUrls, downloadImages, latestHumanActivity } from './context.js'
import { DATA_DIR } from '../paths.js'
import { join, isAbsolute } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { log } from '../logger.js'
import {
  type Checkpoint,
  type WorkspaceCk,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
} from './checkpoint.js'

// Thrown by a stage when a pause was requested at its boundary. It carries the
// run up to the outer handler, which marks the run 'paused' (not failed), keeps
// the worktree + checkpoint, and returns — a later `resume` continues from here.
export class PausedError extends Error {
  constructor(public stage: StageName) {
    super(`paused before "${stage}"`)
    this.name = 'PausedError'
  }
}

// Outcomes whose checkpoint we KEEP so the ticket can resume where it stopped.
// Everything else (success, skipped) deletes the checkpoint — the work is done.
const RESUMABLE_OUTCOMES = new Set(['failed', 'blocked', 'paused'])

// Per-run mutable context: the run record, its resume checkpoint, and the live
// pause predicate. Threaded into every stage() so stages can replay from cache
// and honor a pause request at their boundary.
interface Session {
  rec: RunRecord
  ck: Checkpoint
  paused: () => boolean
}

// A CHECK step's verdict. Every check step (see CHECK_STAGES) must end its
// output with a line `VERDICT: pass` or `VERDICT: fail — <reason>`; the harness
// appends that requirement to the prompt. The LAST verdict line wins (the model
// may reason first, then conclude). Missing verdict → fail-OPEN (treat as pass)
// so a model that forgets the format can't spin the loop forever; the human PR
// review and the off-limits guardrail remain the hard backstops.
export function parseVerdict(text: string): { pass: boolean; reason: string } {
  const m = [...text.matchAll(/VERDICT:\s*(pass|clean|ok|fail|issues|needs[-\s]?fix)\b(.*)/gi)]
  if (!m.length) {
    log.warn('check step emitted no VERDICT line — treating as pass (fail-open)')
    return { pass: true, reason: '' }
  }
  const last = m[m.length - 1]
  const pass = /^(pass|clean|ok)$/i.test(last[1])
  return { pass, reason: (last[2] || '').replace(/^\s*[—:-]\s*/, '').trim() }
}

// Store a check step's output where later steps (and the ship/comment prompts)
// pick it up as context.
function setPrior(priors: PriorOutputs, stage: StageName, text: string) {
  if (stage === 'verify') priors.verify = text
  else if (stage === 'review') priors.review = text
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// The kind triage emitted (question | data | change | bug), or null if unset.
function parseKind(text: string): 'question' | 'data' | 'change' | 'bug' | null {
  if (/KIND:\s*data/i.test(text)) return 'data'
  if (/KIND:\s*bug/i.test(text)) return 'bug'
  if (/KIND:\s*change/i.test(text)) return 'change'
  if (/KIND:\s*question/i.test(text)) return 'question'
  return null
}

// The branch `locate` said to refresh (an open PR's head), or undefined for fresh.
function parseReuse(text: string): string | undefined {
  const m = (text || '').match(/REUSE:\s*(\S+)/i)
  if (!m || /^none$/i.test(m[1])) return undefined
  return m[1].trim().replace(/[).,]+$/, '')
}

// Data path: plan → prepare → (export ↔ verify) → comment. Read-only, no
// worktree/branch/PR — runs in the repo checkout; the comment step posts the
// export file to the ticket with the project's Linear key.
async function runDataPath(
  ctx: EngineCtx,
  s: Session,
  ticket: Ticket,
  project: ProjectConfig,
  priors: PriorOutputs,
  extras: StageExtras,
): Promise<RunRecord> {
  const rec = s.rec
  // The data path runs in a THROWAWAY worktree that is removed on every exit
  // (below), so a resumed data run can't reattach a prior worktree — its export
  // file would be gone. Run it fresh each time (pause still works going forward);
  // read-only data pulls are cheap enough that this is the safe tradeoff.
  s.ck.stageOutputs = {}
  s.ck.workspace = undefined
  // Isolate in a throwaway worktree so a mis-following stage can't touch the real
  // checkout. It's read-only work — the export file is written here; no push/PR.
  const ws = setupWorkspace(ctx, project, ticket.identifier)
  const workdir = ws.cwd
  extras.dataMode = true // shared stages (prepare/verify) run read-only, data-aware
  if (ws.multi) extras.workspace = ws.repos.map((r) => ({ name: r.name, base: r.base, readOnly: r.shipDisabled }))
  try {
    priors.plan = (await stage(ctx, s, 'plan', 'plan', project, ticket, priors, workdir, extras)).text
    await stage(ctx, s, 'prepare', 'prepare', project, ticket, priors, workdir, extras)

    const loopEnabled = ctx.cfg.loop?.enabled !== false
    const maxIters = Math.max(1, ctx.cfg.loop?.maxFixIterations ?? 1)
    let iteration = 1
    let lastSig = ''
    let exhausted = false
    while (true) {
      priors.export = (await stage(ctx, s, 'export', `export#${iteration}`, project, ticket, priors, workdir, extras)).text
      const v = (await stage(ctx, s, 'verify', `verify#${iteration}`, project, ticket, priors, workdir, extras)).text
      priors.verify = v
      if (parseVerdict(v).pass) break // data verified correct → deliver

      if (!loopEnabled || iteration >= maxIters) { exhausted = true; break }
      if (!ctx.governor.canRun().ok) { exhausted = true; break }
      const sig = djb2(v)
      if (sig === lastSig) { exhausted = true; break }
      lastSig = sig
      priors.openFindings = `The verify step found problems with the export:\n${v.slice(0, 1500)}`
      iteration++
      priors.iteration = iteration
      log.info(`  ↻ export attempt ${iteration}/${maxIters} — ${ticket.identifier}`)
    }

    const c = await stage(ctx, s, 'comment', 'comment', project, ticket, priors, workdir, extras)
    rec.commentUrl = extractCommentUrl(c.text)
    finish(rec, 'exported', exhausted ? 'Exported, but verify had unresolved concerns.' : 'Data export posted to the ticket.')
    return rec
  } finally {
    // Throwaway worktree — nothing to ship; always remove it + its empty branch.
    if (ws.useWorktree) {
      for (const r of ws.repos) {
        ctx.repo.removeWorktree(r.srcPath, r.workdir)
        ctx.repo.deleteBranch(r.srcPath, r.branch)
      }
    }
  }
}

let runCounterSeed = 0
function newRunId(ticket: string): string {
  runCounterSeed++
  return `${ticket}-${Date.now().toString(36)}-${runCounterSeed}`
}

export interface EngineCtx {
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
    governor: new Governor(cfg),
  }
}

const MOCK_KIND: Record<StageName, any> = {
  triage: 'triage',
  clarify: 'answer',
  export: 'export',
  locate: 'locate',
  reproduce: 'reproduce',
  plan: 'plan',
  prepare: 'prepare',
  fix: 'diff',
  verify: 'verify',
  review: 'review',
  ship: 'ship',
  'deploy-dev': 'deploy-dev',
  'verify-dev': 'verify-dev',
  comment: 'comment',
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
  const rec: RunRecord = {
    id: newRunId(ticket.identifier),
    ticket: ticket.identifier,
    ticketTitle: ticket.title,
    ticketUrl: ticket.url,
    project: project.name,
    autonomy: project.autonomy,
    startedAt: Date.now(),
    outcome: 'running',
    stages: [],
    totalTokens: 0,
    costUsd: 0,
  }
  appendRun(rec)
  const priors: PriorOutputs = {}

  // ---- Resume checkpoint ---------------------------------------------------
  // Reload a prior attempt's checkpoint if it's for the SAME ask (marker). A
  // checkpoint from different human activity is stale → discard and start fresh.
  const ticketKey = `${project.name}:${ticket.identifier}`
  const marker = opts.marker || ''
  let ck = loadCheckpoint(ticketKey)
  if (ck && ck.marker !== marker) {
    deleteCheckpoint(ticketKey)
    ck = null
  }
  const resuming = !!ck && Object.keys(ck.stageOutputs).length > 0
  if (!ck) ck = { runId: rec.id, ticketKey, marker, imagePaths: [], stageOutputs: {}, updatedAt: 0 }
  const session: Session = { rec, ck, paused: opts.isPaused || (() => false) }
  if (resuming) log.info(`  ⤿ resuming ${ticket.identifier} from checkpoint (${Object.keys(ck.stageOutputs).length} stage(s) cached)`)

  try {
    const gate = ctx.governor.canRun()
    if (!gate.ok) {
      finish(rec, 'blocked', `Quota: ${gate.reason}. Resets ~${fmt(gate.resetAt)}.`)
      return rec
    }

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
    const extras: StageExtras = { imagePaths, isReprocess: !!opts.reprocess, trackerKey: opts.trackerKey }

    // Triage & clarify are read-only — run them against the main checkout.
    const repoPath = project.repoPath

    // --- Triage (model decides eligibility + kind) --------------------------
    const triage = await stage(ctx, session, 'triage', 'triage', project, ticket, priors, repoPath, extras)
    // Only skip when triage EXPLICITLY says ineligible. A missing/oddly-formatted
    // decision defaults to eligible (real safety is the exclude guardrail + PR
    // review, not this soft filter) — so a stray answer never wrongly skips.
    const eligible = ctx.mock || !/DECISION:\s*ineligible/i.test(triage.text)
    const kind = parseKind(triage.text) || classifyKind(ticket) // question | data | change | bug

    // No action needed: the latest activity is a sign-off / approval / ack, or an
    // ask the loop can't do (deploy to prod). Skip WITHOUT running any pipeline —
    // this is what stops sign-offs re-triggering a doomed "no file changes" run.
    if (/DECISION:\s*no[-\s]?action/i.test(triage.text)) {
      finish(rec, 'skipped', 'No action required (triage: latest activity is a sign-off / approval / not a request).')
      return rec
    }

    if (!eligible) {
      finish(rec, 'skipped', `Triage: ineligible. ${firstLine(triage.text)}`)
      return rec
    }

    // --- Data path: read-only export in an isolated throwaway worktree ------
    if (kind === 'data') {
      return await runDataPath(ctx, session, ticket, project, priors, extras)
    }
    skip(rec, 'export', 'not a data request')

    // --- Question path ------------------------------------------------------
    if (kind === 'question' || project.autonomy === 'clarify') {
      // The clarify step posts its own answer with the project's Linear key.
      const ans = await stage(ctx, session, 'clarify', 'clarify', project, ticket, priors, repoPath, extras)
      skip(rec, 'comment', 'answer posted by the clarify step')
      rec.commentUrl = extractCommentUrl(ans.text)
      finish(rec, 'answered', 'Posted an answer comment.')
      return rec
    }
    skip(rec, 'clarify', 'not a question')

    // --- Change path: isolate in a git worktree (default) ------------------
    // LOCATE: find an existing OPEN PR to refresh (single-repo only for now).
    let reuseBranch: string | undefined
    if (!project.repos?.length) {
      const loc = await stage(ctx, session, 'locate', 'locate', project, ticket, priors, repoPath, extras)
      reuseBranch = parseReuse(loc.text)
      if (reuseBranch) log.info(`  ↩ refreshing existing PR on branch ${reuseBranch} — ${ticket.identifier}`)
    } else {
      skip(rec, 'locate', 'multi-repo: PR refresh not supported yet')
    }
    // If the checkpoint's worktree vanished (user cleaned up), the cached
    // change-path work (plan/fix edits) is unusable — replaying it into a fresh
    // empty worktree would look like "no changes". Discard the whole checkpoint
    // and start clean. (triage/locate already ran this attempt; harmless.)
    if (ck.workspace && !reattachWorkspace(ck.workspace, ctx.mock)) {
      log.warn(`  checkpoint worktree gone — discarding cached work, starting fresh`)
      ck.stageOutputs = {}
      ck.workspace = undefined
      saveCheckpoint(ck)
    }
    // On resume, reattach the SAME worktree/branch from the checkpoint (rebuilds
    // the workspace without cutting a new branch). Fresh runs create it and
    // persist the descriptor so a later resume can reattach.
    const ws = setupWorkspace(ctx, project, ticket.identifier, reuseBranch, ck.workspace)
    if (!ck.workspace) {
      ck.workspace = toWorkspaceCk(ws)
      saveCheckpoint(ck)
    }
    const workdir = ws.cwd // plan→verify run here (workspace root for multi-repo)
    if (ws.multi) extras.workspace = ws.repos.map((r) => ({ name: r.name, base: r.base, readOnly: r.shipDisabled }))
    let dirty: WorkRepo[] = []

    try {
      // Bug Investigation: reproduce + root-cause the bug before planning a fix.
      if (kind === 'bug') {
        priors.reproduce = (await stage(ctx, session, 'reproduce', 'reproduce', project, ticket, priors, workdir, extras)).text
      } else {
        skip(rec, 'reproduce', 'not a bug investigation')
      }
      priors.plan = (await stage(ctx, session, 'plan', 'plan', project, ticket, priors, workdir, extras)).text
      await stage(ctx, session, 'prepare', 'prepare', project, ticket, priors, workdir, extras)
      priors.iteration = 1
      priors.fix = (await stage(ctx, session, 'fix', 'fix#1', project, ticket, priors, workdir, extras)).text

      // ---- Bounded fix-loop: fix → checks → (verify/review) → repeat while ----
      // not clean, up to maxFixIterations, with no-progress + quota backstops.
      const loopEnabled = ctx.cfg.loop?.enabled !== false
      const maxIters = Math.max(1, ctx.cfg.loop?.maxFixIterations ?? 1)
      // Dev steps are opt-in per project; when on they gate after ship.
      const deployDevEnabled = resolveStage(ctx.cfg, 'deploy-dev', project.stages).enabled !== false
      const verifyDevEnabled = resolveStage(ctx.cfg, 'verify-dev', project.stages).enabled !== false
      let iteration = 1
      let lastSig = ''
      let exhausted = false
      let prs: PrRecord[] = []
      while (true) {
        // Guardrail EVERY iteration, over ALL repos: no off-limits paths, and
        // something changed. Counts committed (base...HEAD) + uncommitted.
        const scan = scanRepos(ctx, project, ws)
        if (scan.block) {
          finish(rec, 'blocked', scan.block)
          return rec
        }
        if (!scan.dirty.length) {
          finish(rec, 'failed', 'Fix step produced no file changes (nothing committed or staged in any repo).')
          return rec
        }
        dirty = scan.dirty

        // Sequential gates: verify → review. Each must PASS before the next
        // runs — reviewing (or shipping) a change that verify already failed is
        // wasted work — so we stop at the first failing verdict and route
        // straight back to fix. No separate test command: a check like "run
        // deno task check" lives inside a step's own instruction.
        const failures: { stage: StageName; detail: string }[] = []
        for (const cs of CHECK_STAGES) {
          const out = (await stage(ctx, session, cs, `${cs}#${iteration}`, project, ticket, priors, workdir, extras)).text
          setPrior(priors, cs, out) // feed each check's output into the next step's context
          if (!parseVerdict(out).pass) {
            failures.push({ stage: cs, detail: out })
            break // don't run later gates on a change an earlier one rejected
          }
        }
        // Ship ONLY after verify+review pass — never push a PR review rejected.
        // Ship opens/updates one PR per dirty repo; its own instruction watches
        // the PR's CI and must return VERDICT: pass. A ship fail routes back to
        // fix like any other check.
        if (!failures.length) {
          prs = []
          for (const r of dirty) {
            const shipExtras: StageExtras = { ...extras, shipRepo: ws.multi ? r.name : undefined }
            const shipRes = await stage(ctx, session, 'ship', `ship:${r.name}#${iteration}`, project, ticket, priors, r.workdir, shipExtras)
            const prUrl = extractPrUrl(shipRes.text) || undefined
            const shipOk = parseVerdict(shipRes.text).pass && !!prUrl
            prs.push({
              repo: r.name,
              branch: r.branch,
              url: prUrl,
              status: prUrl ? 'opened' : 'failed',
              error: shipOk ? undefined : firstLine(shipRes.text),
            })
            if (!ws.multi) priors.ship = shipRes.text
            if (!shipOk) failures.push({ stage: 'ship', detail: `[${r.name}] ${shipRes.text}` })
          }
          // All repos shipped → (optionally) deploy to dev, then verify in dev.
          // Each is gated; a failure routes back to fix like any other gate.
          if (!failures.length && deployDevEnabled) {
            if (ws.multi) priors.ship = prs.map((p) => (p.url ? `${p.repo}: ${p.url}` : `${p.repo}: SHIP FAILED`)).join('\n')
            const dep = await stage(ctx, session, 'deploy-dev', `deploy-dev#${iteration}`, project, ticket, priors, workdir, extras)
            priors.deployDev = dep.text
            if (!parseVerdict(dep.text).pass) failures.push({ stage: 'deploy-dev', detail: dep.text })
            else if (verifyDevEnabled) {
              // Deployed OK → check it actually works in the dev environment.
              const vd = await stage(ctx, session, 'verify-dev', `verify-dev#${iteration}`, project, ticket, priors, workdir, extras)
              priors.verifyDev = vd.text
              if (!parseVerdict(vd.text).pass) failures.push({ stage: 'verify-dev', detail: vd.text })
            }
          }
          if (!failures.length) break // checks + ship (+ deploy-dev + verify-dev) all passed → done
        }

        if (!loopEnabled || iteration >= maxIters) {
          exhausted = true
          break
        }
        if (!ctx.governor.canRun().ok) {
          exhausted = true
          log.warn(`${ticket.identifier}: quota reached mid-loop — shipping with unresolved findings`)
          break
        }
        // no-progress: identical findings twice ⇒ the model is stuck.
        const sig = djb2(failures.map((f) => f.stage + '::' + f.detail).join('\n'))
        if (sig === lastSig) {
          exhausted = true
          log.warn(`${ticket.identifier}: no progress between fix attempts — stopping the loop`)
          break
        }
        lastSig = sig

        // Repair pass: feed the open findings back into another fix.
        priors.openFindings = failures
          .map((f) => `The "${f.stage}" step reported problems:\n${f.detail.slice(0, 1500)}`)
          .join('\n\n')
        iteration++
        priors.iteration = iteration
        log.info(`  ↻ fix attempt ${iteration}/${maxIters} — ${ticket.identifier}`)
        priors.fix = (await stage(ctx, session, 'fix', `fix#${iteration}`, project, ticket, priors, workdir, extras)).text
      }

      // ---- Record PRs · comment · outcome · cleanup ----------------------
      const opened = prs.filter((p) => p.status === 'opened')
      const failedRepos = prs.filter((p) => p.status === 'failed')
      rec.prUrl = opened[0]?.url
      if (ws.multi) {
        rec.prs = prs
        priors.ship = prs.map((p) => (p.url ? `${p.repo}: ${p.url}` : `${p.repo}: SHIP FAILED`)).join('\n')
      }

      if (!prs.length) {
        // Verify/review never passed within the cap → nothing was shipped.
        skip(rec, 'ship', 'never reached — verify/review did not pass')
        skip(rec, 'comment', 'no PR to report')
        finish(rec, 'failed', `Couldn't pass verify/review within ${iteration} attempt(s); no PR opened.`)
      } else {
        // The comment step posts to Linear itself, with the project's key (right
        // workspace). The harness never posts — it just records where it landed.
        const commentText = await stage(ctx, session, 'comment', 'comment', project, ticket, priors, workdir, extras)
        rec.commentUrl = extractCommentUrl(commentText.text)

        if (ws.multi && opened.length && failedRepos.length) {
          finish(rec, 'partial', `Opened ${opened.length} PR(s); ${failedRepos.length} repo(s) failed to ship/green — needs a human: ${failedRepos.map((p) => p.repo).join(', ')}.`)
        } else if (!opened.length) {
          finish(rec, 'failed', `Ship produced no PRs across ${prs.length} repo(s).`)
        } else {
          // Clean finish (not exhausted) with deploy-dev on ⇒ it reached dev.
          const deployedToDev = deployDevEnabled && !exhausted
          const outcome = exhausted ? 'pr-opened-with-findings' : deployedToDev ? 'deployed' : 'pr-opened'
          const note = deployedToDev
            ? `Deployed to dev${verifyDevEnabled ? ' (verified in dev)' : ''}${rec.prUrl ? ` · PR: ${rec.prUrl}` : ''}.`
            : rec.prUrl
              ? `Opened PR${exhausted ? ` (unresolved findings/CI after ${iteration} attempt(s))` : ''}${ws.multi ? ` in ${opened.length} repo(s)` : ''}: ${rec.prUrl}`
              : 'Shipped (no PR URL parsed).'
          finish(rec, outcome, note)
        }
      }

      // Clean up worktrees only on FULL success — branches/PRs carry the work.
      if (ws.useWorktree && prs.length && !failedRepos.length) {
        const shipped = new Set(dirty.map((r) => r.name))
        for (const r of ws.repos) {
          ctx.repo.removeWorktree(r.srcPath, r.workdir)
          // Untouched repo → empty branch; delete it so unused per-ticket
          // branches don't pile up. Shipped repos keep theirs — the PR needs it.
          if (!shipped.has(r.name)) ctx.repo.deleteBranch(r.srcPath, r.branch)
        }
      }
      return rec
    } catch (e) {
      // Keep the worktree(s) on failure so a human can inspect them.
      if (ws.useWorktree) log.warn(`left worktree(s) for inspection under: ${ws.cwd}`)
      throw e
    }
  } catch (e) {
    if (e instanceof PausedError) {
      // Not a failure — the loop was asked to pause. Keep the worktree +
      // checkpoint; `resume` continues from this exact stage.
      finish(rec, 'paused', `Paused before "${e.stage}". Resume to continue.`)
      return rec
    }
    const msg = String(e)
    // A rate limit is not a failure — block so the ticket retries after reset.
    const outcome = msg.includes('RATE_LIMIT') ? 'blocked' : 'failed'
    finish(rec, outcome, msg)
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

function worktreePath(project: ProjectConfig, ticketId: string): string {
  const base = project.worktreeBase || join(DATA_DIR, 'worktrees', project.name)
  return join(base, ticketId)
}

// ---- Workspace (single- or multi-repo) -------------------------------------
// A WorkRepo is one git repo the change path operates on. Single-repo projects
// produce a one-element list (today's behaviour); multi-repo projects (`repos`
// set) produce one per entry, each in its own worktree under a shared root.
interface WorkRepo {
  name: string
  srcPath: string // absolute source repo (for worktree ops / in-place)
  workdir: string // where edits happen (worktree path or in-place)
  base: string // PR base branch
  branch: string // this run's working branch (may be versioned on re-processing)
  exclude: string[] // repo-relative extra excludes
  shipDisabled: boolean
}

// The harness must put the worktree on SOME branch before any model step runs
// (a worktree needs a branch; the guardrail diffs against a base). So it picks a
// safe DEFAULT — a fresh branch off the current base, i.e. a clean new PR. It
// does NOT decide new-vs-update-an-existing-PR: that judgment, if wanted, lives
// in the `prepare`/`ship` instruction, where the model can run `gh pr list` and
// check out an open PR's branch itself. Here we only avoid colliding with a
// branch a prior run left behind (which would sit at stale/merged code).
export function resolveBranch(ctx: EngineCtx, srcPath: string, ticketId: string): string {
  const base = `ticketloop/${ticketId.toLowerCase()}`
  if (ctx.mock) return base
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`
    if (!ctx.repo.localBranchExists(srcPath, name)) return name
  }
}
interface Workspace {
  repos: WorkRepo[]
  cwd: string // where plan→verify run (workspace root for multi, the repo for single)
  multi: boolean
  useWorktree: boolean
}

// Serialize a live Workspace into the checkpoint so a resumed run can reattach.
function toWorkspaceCk(ws: Workspace): WorkspaceCk {
  return { repos: ws.repos.map((r) => ({ ...r })), cwd: ws.cwd, multi: ws.multi, useWorktree: ws.useWorktree }
}

// Rebuild the Workspace from a checkpoint WITHOUT touching git — the worktrees
// and branches from the interrupted attempt are still on disk. Returns null if
// they're gone (user cleaned up), so the caller starts fresh instead.
function reattachWorkspace(resumeWs: WorkspaceCk, skipDiskCheck = false): Workspace | null {
  if (resumeWs.useWorktree && !skipDiskCheck) {
    for (const r of resumeWs.repos) {
      // A git worktree has a `.git` file (not dir) pointing at the main repo.
      if (!existsSync(join(r.workdir, '.git'))) return null
    }
  }
  return {
    repos: resumeWs.repos.map((r) => ({ ...r })),
    cwd: resumeWs.cwd,
    multi: resumeWs.multi,
    useWorktree: resumeWs.useWorktree,
  }
}

// Create the worktrees/branches and return the workspace. Throws on a dirty
// in-place repo (caught by the outer handler → 'failed').
function setupWorkspace(
  ctx: EngineCtx,
  project: ProjectConfig,
  ticketId: string,
  reuseBranch?: string,
  resumeWs?: WorkspaceCk,
): Workspace {
  const useWorktree = project.useWorktree !== false
  const multi = !!(project.repos && project.repos.length)

  // RESUME: reattach the interrupted attempt's worktree/branch as-is.
  if (resumeWs) {
    const re = reattachWorkspace(resumeWs, ctx.mock)
    if (re) {
      log.info(`  ⤿ reattached workspace at ${re.cwd} (${re.repos.map((r) => r.branch).join(', ')})`)
      return re
    }
    log.warn(`  checkpoint workspace missing on disk — starting fresh`)
  }

  // Single-repo PR refresh: `locate` found an open PR → check out its branch and
  // guard only the model's new delta (base = the branch tip at checkout).
  if (!multi && reuseBranch && useWorktree) {
    const src = project.repoPath
    const workdir = worktreePath(project, ticketId)
    if (ctx.repo.reuseWorktree(src, workdir, reuseBranch)) {
      const base = ctx.repo.tipSha(workdir)
      return {
        repos: [{ name: project.name, srcPath: src, workdir, base, branch: reuseBranch, exclude: [], shipDisabled: false }],
        cwd: workdir,
        multi,
        useWorktree,
      }
    }
    log.warn(`locate named branch "${reuseBranch}" but it couldn't be checked out — starting fresh`)
  }

  if (multi) {
    const root = worktreePath(project, ticketId)
    if (useWorktree) mkdirSync(root, { recursive: true })
    const repos: WorkRepo[] = []
    for (const r of project.repos!) {
      const src = isAbsolute(r.path) ? r.path : join(project.repoPath, r.path)
      const base = ctx.repo.resolveBase(src, r.base) // origin/<branch> — fetched, never stale
      const branch = resolveBranch(ctx, src, ticketId)
      let workdir = src
      if (useWorktree) {
        workdir = join(root, r.name)
        ctx.repo.createWorktree(src, workdir, branch, base)
      } else if (!ctx.mock) {
        const clean = ctx.repo.ensureClean(src)
        if (!clean.clean) throw new Error(`Repo "${r.name}" not clean before starting:\n${clean.detail?.slice(0, 200)}`)
        ctx.repo.createBranch(src, branch)
      }
      repos.push({ name: r.name, srcPath: src, workdir, base, branch, exclude: r.exclude || [], shipDisabled: !!r.shipDisabled })
    }
    return { repos, cwd: useWorktree ? root : project.repoPath, multi, useWorktree }
  }

  // Single-repo: same flow, one repo.
  const base = ctx.repo.resolveBase(project.repoPath) // origin/<branch> — fetched, never stale
  const branch = resolveBranch(ctx, project.repoPath, ticketId)
  let workdir = project.repoPath
  if (useWorktree) {
    workdir = worktreePath(project, ticketId)
    ctx.repo.createWorktree(project.repoPath, workdir, branch, base)
  } else if (!ctx.mock) {
    const clean = ctx.repo.ensureClean(project.repoPath)
    if (!clean.clean) throw new Error(`Repo not clean before starting:\n${clean.detail?.slice(0, 200)}`)
    ctx.repo.createBranch(project.repoPath, branch)
  }
  return {
    repos: [{ name: project.name, srcPath: project.repoPath, workdir, base, branch, exclude: [], shipDisabled: false }],
    cwd: workdir,
    multi,
    useWorktree,
  }
}

// The ONE deterministic safety check, now over every repo. Returns the dirty
// repos to ship, or a `block` reason if an off-limits path/repo was touched.
function scanRepos(
  ctx: EngineCtx,
  project: ProjectConfig,
  ws: Workspace,
): { dirty: WorkRepo[]; block?: string } {
  const dirty: WorkRepo[] = []
  for (const r of ws.repos) {
    const changed = ctx.repo.changedFilesVsBase(r.workdir, r.base)
    if (!changed.length) continue
    // A read-only repo must never be modified.
    if (r.shipDisabled)
      return { dirty, block: `Off-limits repo "${r.name}" was modified (read-only). Aborted before ship.` }
    for (const f of changed) {
      // project.exclude matches repo-PREFIXED paths in multi mode (so existing
      // patterns like `backend/migrations/**` keep working); repo.exclude
      // matches the repo-relative path.
      const projPath = ws.multi ? `${r.name}/${f}` : f
      const hit = matchesAny(projPath, project.exclude || []) || matchesAny(f, r.exclude)
      if (hit) return { dirty, block: `Off-limits path touched: ${projPath} (matches "${hit}"). Aborted before ship.` }
    }
    dirty.push(r)
  }
  return { dirty }
}

// ---- stage runner ----------------------------------------------------------

async function stage(
  ctx: EngineCtx,
  s: Session,
  name: StageName,
  ckKey: string,
  project: ProjectConfig,
  ticket: Ticket,
  priors: PriorOutputs,
  workdir: string,
  extras: StageExtras,
): Promise<ClaudeResult> {
  const rec = s.rec
  const sc = resolveStage(ctx.cfg, name, project.stages)

  // REPLAY: a stage already completed in a prior attempt returns its cached
  // output with NO model call. This is what fast-forwards a resumed run to the
  // exact stage that failed/paused — priors, kind, reuse-branch and loop
  // counters all rebuild as the surrounding code re-executes on instant replays.
  const cached = s.ck.stageOutputs[ckKey]
  if (cached !== undefined) {
    const sr0 = beginStage(rec, name, sc.model)
    endStage(rec, sr0, 'ok', `⤿ resumed (cached) — ${firstLine(cached)}`, cached)
    return { ...emptyResult(sc.model || ctx.cfg.runner.defaultModel), text: cached }
  }

  if (sc.enabled === false) {
    const sr0 = beginStage(rec, name, sc.model)
    endStage(rec, sr0, 'skipped', 'stage disabled in config')
    return emptyResult(sc.model || ctx.cfg.runner.defaultModel)
  }

  // PAUSE boundary: before spending a model call, honor a pause request. Persist
  // the checkpoint and unwind — `resume` re-enters and replays up to here.
  if (s.paused()) {
    saveCheckpoint(s.ck)
    throw new PausedError(name)
  }

  // QUOTA check before spending a model call: if we're still inside Claude's
  // usage-limit window, don't run — end the run (blocked); it resumes here once
  // the reset passes. (Guards mid-run steps + parallel runs after one hits it.)
  const rl = resetUntil()
  if (rl > Date.now()) {
    saveCheckpoint(s.ck)
    throw new Error(`RATE_LIMIT: Claude usage limit — waiting for reset at ${new Date(rl).toLocaleTimeString()}`)
  }

  const sr = beginStage(rec, name, sc.model)
  const instruction = resolveInstruction(name, sc)
  const prompt = buildStagePrompt(name, ticket, project, instruction, priors, workdir, extras)
  log.info(`  ▸ ${name} (${sc.model})${sc.skill ? ` +skill:${sc.skill}` : ''} — ${rec.ticket}`)

  // Post steps get the project's Linear key in the env so they hit the RIGHT
  // workspace via the API (not the global MCP). The key stays out of the prompt.
  const env =
    POST_STAGES.includes(name) && extras.trackerKey && ctx.cfg.tracker.type === 'linear'
      ? { LINEAR_API_KEY: extras.trackerKey }
      : undefined
  const res = await runClaude({
    prompt,
    cwd: workdir,
    stage: sc,
    runner: ctx.cfg.runner,
    authMode: ctx.cfg.auth.mode,
    mcp: project.mcp || ctx.cfg.mcp,
    mock: ctx.mock,
    mockKind: MOCK_KIND[name],
    env,
  })

  // Guard: never let CLI-error text or an echoed prompt be treated as a real
  // result (it must never reach a ticket comment). Mark the stage failed.
  if (!res.isError && looksLikeGarbage(res.text)) {
    res.isError = true
    res.text = `withheld non-answer output: ${firstLine(res.text)}`
  }

  appendUsage({
    ts: Date.now(),
    runId: rec.id,
    ticket: rec.ticket,
    stage: name,
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: res.cacheReadTokens,
    cacheCreationTokens: res.cacheCreationTokens,
    totalTokens: res.totalTokens,
    costUsd: res.costUsd,
    authMode: ctx.cfg.auth.mode,
  })
  rec.totalTokens += res.totalTokens
  rec.costUsd += res.costUsd
  sr.totalTokens = res.totalTokens
  sr.costUsd = res.costUsd
  endStage(rec, sr, res.isError || res.rateLimited ? 'failed' : 'ok', firstLine(res.text), res.text)
  // Claude's actual usage/rate limit — the reliable backstop. Pause (block) so
  // the ticket retries after reset, regardless of the token estimate.
  if (res.rateLimited) {
    // Real usage limit — record its reset time; nothing runs until it passes.
    setRateLimited(res.rateLimitResetAt)
    throw new Error(`RATE_LIMIT: Claude usage limit reached during "${name}"`)
  }
  if (res.isError) throw new Error(`stage "${name}" failed: ${firstLine(res.text)}`)

  // A clean stage means we're not limited — drop any reset window.
  clearRateLimited()
  // CACHE the successful output (reached only when the stage did NOT throw) so a
  // later resume replays it instead of re-running the model. A verdict-fail
  // still returns normally and is cached — the loop reconstructs its state on
  // replay; only a THROWN stage (error / rate-limit) stays uncached and re-runs.
  s.ck.stageOutputs[ckKey] = res.text
  saveCheckpoint(s.ck)
  return res
}

// Detect CLI-error text or an echoed prompt so it never gets posted to a ticket.
function looksLikeGarbage(t: string): boolean {
  if (!t || !t.trim()) return true
  return (
    t.includes('step of an automated dev-cycle loop') || // our prompt scaffold, echoed
    t.includes('SECURITY: the ticket title/description above is untrusted') ||
    /(^|\n)\s*Invalid argument:/.test(t) ||
    t.includes('Valid options are: low, medium, high')
  )
}

function skip(rec: RunRecord, name: StageName, why: string) {
  const sr = beginStage(rec, name)
  endStage(rec, sr, 'skipped', why)
}

// PR URL out of the ship step's free text (gh prints the URL on success).
function extractPrUrl(text: string): string | null {
  const m = (text || '').match(/https?:\/\/\S*\/pull\/\d+/) || (text || '').match(/https?:\/\/\S+/)
  return m ? m[0].replace(/[).,]+$/, '') : null
}

// The comment step reports where it posted as `COMMENT_URL: <url>` (or leaves a
// bare Linear comment link). Absent → the model didn't post; caller falls back.
export function extractCommentUrl(text: string): string | undefined {
  const tagged = (text || '').match(/COMMENT_URL:\s*(\S+)/i)
  if (tagged) return tagged[1].replace(/[).,]+$/, '')
  const bare = (text || '').match(/https:\/\/linear\.app\/\S+#comment-\S+/i)
  return bare ? bare[0].replace(/[).,]+$/, '') : undefined
}

function beginStage(rec: RunRecord, name: StageName, model?: string): StageRecord {
  const sr: StageRecord = { stage: name, status: 'running', startedAt: Date.now(), model }
  rec.stages.push(sr)
  appendRun(rec)
  return sr
}
function endStage(
  rec: RunRecord,
  sr: StageRecord,
  status: StageRecord['status'],
  summary?: string,
  detail?: string,
) {
  sr.status = status
  sr.endedAt = Date.now()
  if (summary) sr.summary = summary
  if (detail) sr.detail = detail.slice(0, 4000)
  appendRun(rec)
}
function finish(rec: RunRecord, outcome: RunRecord['outcome'], note: string) {
  rec.outcome = outcome
  rec.endedAt = Date.now()
  const last = rec.stages[rec.stages.length - 1]
  if (last && last.status === 'running') endStage(rec, last, 'ok')
  rec.error = outcome === 'failed' || outcome === 'blocked' ? note : rec.error
  log.info(`  = ${rec.ticket}: ${outcome} — ${note}`)
  appendRun(rec)
}

function emptyResult(model: string): ClaudeResult {
  return {
    text: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    model,
    isError: false,
  }
}
// Stable key for a bot comment so a crash-retry doesn't double-post: same
// ticket + same latest-human-activity + same purpose → same key.
function commentKey(ticket: Ticket, purpose: string): string {
  const s = `${ticket.identifier}|${latestHumanActivity(ticket)}|${purpose}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const firstLine = (s: string) => (s || '').trim().split('\n')[0]?.slice(0, 160) || ''
const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : 'soon')
