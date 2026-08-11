import type { Config, ProjectConfig } from '../types.js'
import { makeEngineCtx, processTicket } from '../loop/engine.js'
import { resolveTracker, saveConfig, validateProject } from '../config.js'
import { makeTracker } from '../adapters/tracker/tracker.js'
import { resolveTrackerKey, setCredential } from '../credentials.js'
import { startServer } from './server.js'
import { readJson, writeJson, abortStaleRuns, pruneUsage, CorruptStateError } from '../store.js'
import { DAEMON_STATE } from '../paths.js'
import { assertAuthSafe } from '../runner/claude.js'
import { sweepOrphans, killAllChildren } from '../runner/children.js'
import { latestHumanActivity } from '../loop/context.js'
import { deleteCheckpoint } from '../loop/checkpoint.js'
import { isPaused, setPaused } from './control.js'
import { log } from '../logger.js'
import { renameSync } from 'node:fs'

const MAX_ATTEMPTS = 3 // stop retrying a failing ticket after this many tries

// Per-ticket state: `marker` is the newest-human-comment timestamp last
// processed (re-run when it advances), `attempts` counts consecutive failures.
interface TicketState {
  marker: string
  attempts: number
  lastOutcome: string
}
interface DaemonState {
  tickets: Record<string, TicketState>
}

function loadState(): { state: Map<string, TicketState>; recovered: boolean } {
  try {
    const s = readJson<DaemonState>(DAEMON_STATE)
    return { state: new Map(Object.entries(s?.tickets || {})), recovered: false }
  } catch (e) {
    // Corrupt state file — do NOT silently reset (that would re-process every
    // ticket → duplicate PRs/comments). Quarantine it, warn loudly, and recover
    // by adopting current tickets on the first scan instead of re-running them.
    if (e instanceof CorruptStateError) {
      try {
        renameSync(DAEMON_STATE, DAEMON_STATE + '.corrupt')
      } catch {
        /* ignore */
      }
      log.error(
        `daemon state was CORRUPT — quarantined to ${DAEMON_STATE}.corrupt. Recovering ` +
          `safely: current tickets are adopted (not re-run); they'll process again only on new activity.`,
      )
      return { state: new Map(), recovered: true }
    }
    throw e
  }
}
function saveState(m: Map<string, TicketState>) {
  writeJson(DAEMON_STATE, { tickets: Object.fromEntries(m) })
}

export interface WatchOpts {
  mock: boolean
  once?: boolean // scan a single time then exit (used by `run --all`)
  configPath?: string | null // where to persist UI-driven project edits
}

export async function watch(cfg: Config, opts: WatchOpts): Promise<void> {
  const ctx = makeEngineCtx(cfg, opts.mock)
  const loaded = loadState()
  const state = loaded.state
  let adoptMode = loaded.recovered // first scan after corruption: adopt, don't run
  // These startup-recovery tasks belong ONLY to the long-running daemon — a
  // one-shot `run` must never reap the live daemon's children or abort its runs.
  const isDaemon = !opts.once && !opts.mock
  if (isDaemon) {
    const reaped = sweepOrphans()
    if (reaped) log.warn(`reaped ${reaped} orphaned claude process group(s) from a previous crash`)
    const pruned = pruneUsage()
    if (pruned) log.info(`pruned ${pruned} usage event(s) older than 8 days`)
    const aborted = abortStaleRuns()
    if (aborted) log.warn(`marked ${aborted} stale "running" run(s) as failed (from a previous stop)`)
  }
  let running = true
  let lastScan: number | undefined
  let scanning = false
  // live scan progress for the real-time monitor
  let scanTotal = 0
  let scanDone = 0
  let activeTicket: string | undefined
  let activeProject: string | undefined

  for (const w of assertAuthSafe(cfg.auth.mode).warnings) log.warn(w)
  if (cfg.runner.permissionMode === 'bypass') {
    log.warn(
      'permissionMode=bypass — steps run with --dangerously-skip-permissions. ' +
        'Safety relies on worktree isolation + exclude guardrail + PR review (never ' +
        'auto-merge). Only run on tickets from sources you trust.',
    )
  }
  log.info(
    `ticketloop watching (${cfg.tracker.type}) — auth=${cfg.auth.mode}, ` +
      `${cfg.projects.length} project(s), poll every ${cfg.tracker.pollIntervalSec}s` +
      (opts.mock ? '  [DEMO/MOCK MODE]' : ''),
  )

  async function scanNow(): Promise<{ processed: number }> {
    if (scanning) return { processed: 0 }
    // Paused: don't pick up new work OR resume anything until `resume`. In-flight
    // runs pause themselves at their next stage boundary (checkpointed).
    if (isPaused()) return { processed: 0 }
    scanning = true
    let count = 0
    try {
      // Phase 1: gather all not-yet-processed jobs (each project = its own
      // tracker/workspace) so we know the total upfront for the progress bar.
      const jobs: {
        project: (typeof cfg.projects)[number]
        tracker: ReturnType<typeof makeTracker>
        ticket: Awaited<ReturnType<ReturnType<typeof makeTracker>['listCandidates']>>[number]
        key: string
        marker: string
        reprocess: boolean
      }[] = []
      for (const project of cfg.projects) {
        const tc = resolveTracker(cfg, project)
        if (tc.type === 'linear' && !tc.simpleLabel) {
          log.warn(
            `[${project.name}] no tracker label set — the loop will consider ALL ` +
              `tickets in states [${tc.states.join(', ')}]. Set a label to opt tickets in.`,
          )
        }
        const key = resolveTrackerKey(project, tc)
        const tracker = makeTracker(tc, key)
        let tickets
        try {
          tickets = await tracker.listCandidates()
        } catch (e) {
          log.error(`scan ${project.name}: tracker error — ${String(e)}`)
          continue
        }
        for (const t of tickets) {
          const sKey = `${project.name}:${t.identifier}`
          const marker = latestHumanActivity(t)
          // After state corruption: adopt every current ticket as done (don't
          // re-run) so recovery can't cause mass re-processing.
          if (adoptMode) {
            state.set(sKey, { marker, attempts: 0, lastOutcome: 'adopted' })
            continue
          }
          const prev = state.get(sKey)
          // Process when: never seen, OR a genuinely NEW human comment arrived
          // (newest-comment timestamp advanced — edits/typo-fixes don't count),
          // OR the last run failed / was interrupted mid-run and we're under the
          // retry cap.
          const newActivity = !prev || marker > prev.marker
          const needsRetry =
            !!prev &&
            prev.attempts < MAX_ATTEMPTS &&
            (prev.lastOutcome === 'failed' || prev.lastOutcome === 'running')
          // A run paused mid-flight resumes on the next (unpaused) scan.
          const needsResume = !!prev && prev.lastOutcome === 'paused'
          if (!newActivity && !needsRetry && !needsResume) continue
          jobs.push({ project, tracker, ticket: t, key, marker, reprocess: !!prev })
        }
      }
      if (adoptMode) {
        adoptMode = false
        saveState(state)
        log.warn(`adopted ${state.size} existing ticket(s) after state recovery — none re-run`)
      }
      scanTotal = jobs.length
      scanDone = 0
      log.info(`scan: ${jobs.length} ticket(s) to process`)

      // Phase 2: process sequentially, updating live progress.
      for (const job of jobs) {
        // A pause between jobs stops the scan here; in-flight jobs pause at their
        // own stage boundary (below).
        if (isPaused()) {
          saveState(state)
          return { processed: count }
        }
        const gate = ctx.governor.canRun()
        if (!gate.ok) {
          log.warn(`pausing scan — ${gate.reason}`)
          saveState(state)
          return { processed: count }
        }
        activeTicket = job.ticket.identifier
        activeProject = job.project.name
        const sKey = `${job.project.name}:${job.ticket.identifier}`
        // Persist state BEFORE the run (marked 'running', attempts pre-incremented)
        // so a crash mid-run still counts toward MAX_ATTEMPTS — otherwise a ticket
        // that crashes the daemon would restart-and-rerun forever.
        const prev = state.get(sKey)
        const attempts = (prev?.attempts || 0) + 1
        state.set(sKey, { marker: job.marker, attempts, lastOutcome: 'running' })
        saveState(state)

        log.info(`→ [${job.project.name}] ${job.ticket.identifier}: ${job.ticket.title}${job.reprocess ? ' (re-processing)' : ''}`)
        const rec = await processTicket(ctx, job.ticket, job.project, job.tracker, {
          reprocess: job.reprocess,
          trackerKey: job.key,
          marker: job.marker,
          isPaused, // checked at every stage boundary → checkpoint + pause
        })
        // Update per-ticket state based on outcome.
        if (rec.outcome === 'paused') {
          // Not an attempt — the run checkpointed and will resume when unpaused.
          state.set(sKey, { marker: job.marker, attempts: prev?.attempts || 0, lastOutcome: 'paused' })
        } else if (rec.outcome === 'blocked') {
          // quota/guardrail — not an attempt; restore prior state so it retries.
          if (prev) state.set(sKey, prev)
          else state.delete(sKey)
        } else if (rec.outcome === 'failed') {
          state.set(sKey, { marker: job.marker, attempts, lastOutcome: 'failed' })
          if (attempts >= MAX_ATTEMPTS) {
            log.warn(`${job.ticket.identifier}: failed ${attempts}× — giving up, flagging for a human`)
            // Give up cleanly: drop the resume checkpoint so a human starts fresh.
            deleteCheckpoint(sKey)
            try {
              await job.tracker.comment(
                job.ticket.id,
                `⚠️ ticketloop tried to handle this ${attempts} times but couldn't complete it. It needs a human. (Last error: ${(rec.error || '').slice(0, 200)})`,
              )
            } catch { /* best effort */ }
          }
        } else {
          // answered / pr-opened / partial / skipped — done at this fingerprint
          state.set(sKey, { marker: job.marker, attempts: 0, lastOutcome: rec.outcome })
        }
        saveState(state)
        count++
        scanDone++
      }
    } catch (e) {
      log.error(`scan failed: ${String(e)}`)
    } finally {
      lastScan = Date.now()
      scanning = false
      activeTicket = undefined
      activeProject = undefined
    }
    return { processed: count }
  }

  // Persist UI edits: mutate the LIVE cfg (so the next scan sees them) + write YAML.
  function persist(): { ok: true } | { error: string } {
    try {
      const at = saveConfig(cfg, opts.configPath ?? null)
      log.info(`config saved → ${at}`)
      return { ok: true }
    } catch (e) {
      return { error: String(e) }
    }
  }

  // A one-shot `run` scan doesn't need the dashboard server (and shouldn't
  // collide with a running daemon on the same port).
  const srv = opts.once ? null : startServer(cfg, {
    scanNow,
    status: () => ({
      running,
      lastScan,
      nextScan: lastScan ? lastScan + cfg.tracker.pollIntervalSec * 1000 : undefined,
      scanning,
      scanDone,
      scanTotal,
      activeTicket,
      activeProject,
    }),
    saveProject: (p: ProjectConfig) => {
      try {
        validateProject(p)
      } catch (e) {
        return { error: String(e) }
      }
      const i = cfg.projects.findIndex((x) => x.name === p.name)
      if (i >= 0) cfg.projects[i] = p
      else cfg.projects.push(p)
      return persist()
    },
    removeProject: (name: string) => {
      const before = cfg.projects.length
      cfg.projects = cfg.projects.filter((p) => p.name !== name)
      if (cfg.projects.length === before) return { error: `no project "${name}"` }
      return persist()
    },
    setKey: (project: string, key: string) => {
      if (!project || !key) return { error: 'project and key required' }
      setCredential(project, key)
      log.info(`stored key for "${project}"`)
      return { ok: true }
    },
  })

  // initial scan
  await scanNow()

  if (opts.once) {
    running = false
    return
  }

  const timer = setInterval(scanNow, cfg.tracker.pollIntervalSec * 1000)
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    running = false
    clearInterval(timer)
    srv?.close()
    // Kill any in-flight claude children so nothing keeps editing/pushing after
    // we exit (they're detached process groups and won't get our signal).
    const killed = killAllChildren('SIGTERM')
    if (killed) log.info(`stopping ${killed} in-flight stage(s)…`)
    setTimeout(() => {
      killAllChildren('SIGKILL')
      process.exit(0)
    }, killed ? 3000 : 0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // keep alive
  await new Promise<void>(() => {})
}
