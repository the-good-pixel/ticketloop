import type { Config, ProjectConfig, RunRecord } from '../types.js'
import { makeEngineCtx, processTicket } from '../loop/engine.js'
import { resolveTracker, saveConfig, validateProject } from '../config.js'
import { makeTracker } from '../adapters/tracker/tracker.js'
import { resolveTrackerKey, setCredential } from '../credentials.js'
import { startServer } from './server.js'
import { readJson, writeJson, abortStaleRuns, pruneUsage, appendRun, getRun, readRuns, CorruptStateError } from '../store.js'
import { DAEMON_STATE } from '../paths.js'
import { assertAuthSafe } from '../runner/index.js'
import { sweepOrphans, killAllChildren, killChildrenFor } from '../runner/children.js'
import { latestHumanActivity } from '../loop/context.js'
import { deleteCheckpoint, loadCheckpoint } from '../loop/checkpoint.js'
import {
  cancelRequestedTickets,
  clearCancel,
  ignoredTickets,
  isCancelRequested,
  isIgnored,
  isPaused,
  requestCancel,
  pausedTickets,
  setTicketIgnored,
  setTicketPaused,
} from './control.js'
import { log } from '../logger.js'
import { renameSync } from 'node:fs'
import { refreshProviderQuotaSnapshots } from '../providerQuota.js'
import type { WaitBlocker } from '../types.js'
import { legacyWaitKind } from '../waiting.js'

const MAX_ATTEMPTS = 3 // stop retrying a failing ticket after this many tries

// Per-ticket state: `marker` is the newest-human-comment timestamp last
// processed (re-run when it advances), `attempts` counts consecutive failures.
interface TicketState {
  marker: string
  attempts: number
  lastOutcome: string
  blocker?: WaitBlocker
  // Legacy provider-wait fields, normalized by loadState().
  waitingProvider?: WaitBlocker['provider']
  resumeAt?: number
}
interface DaemonState {
  tickets: Record<string, TicketState>
}

function loadState(): { state: Map<string, TicketState>; recovered: boolean } {
  try {
    const s = readJson<DaemonState>(DAEMON_STATE)
    const entries = Object.entries(s?.tickets || {}).map(([key, value]) => [key, normalizeTicketState(value)] as const)
    return { state: new Map(entries), recovered: false }
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

function normalizeTicketState(value: TicketState): TicketState {
  const kind = legacyWaitKind(value.lastOutcome)
  if (!kind) return value
  return {
    marker: value.marker,
    attempts: value.attempts,
    lastOutcome: 'waiting',
    blocker: {
      kind,
      reason: 'Waiting for the blocking condition to change.',
      resume: kind === 'provider' ? 'automatic' : 'manual',
      provider: value.waitingProvider,
      resumeAt: value.resumeAt,
    },
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
    if (reaped) log.warn(`reaped ${reaped} orphaned coding-agent process group(s) from a previous crash`)
    const pruned = pruneUsage()
    if (pruned) log.info(`pruned ${pruned} usage event(s) older than 8 days`)
    const aborted = abortStaleRuns()
    if (aborted) log.warn(`marked ${aborted} stale "running" run(s) as failed (from a previous stop)`)
  }
  let running = true
  let lastScan: number | undefined
  let scanning = false // guards the SELECTION pass only (not the runs)
  // Parallelism: projects always run concurrently with each other. WITHIN a
  // project the default is one run at a time (two runs share one repo, so a
  // fixed-port dev server or concurrent git would collide) — a project can opt
  // into more via `maxParallel`. `activeRuns` is keyed by "<project>:<ticket>".
  const activeRuns = new Map<string, { project: string; ticket: string }>()
  const slotsFree = (p: (typeof cfg.projects)[number]) =>
    Math.max(1, p.maxParallel || 1) - [...activeRuns.values()].filter((a) => a.project === p.name).length
  const inflight = new Set<Promise<void>>() // launched runs (awaited on once/shutdown)

  for (const w of assertAuthSafe(cfg).warnings) log.warn(w)
  if (cfg.runner.permissionMode === 'bypass') {
    log.warn(
      'permissionMode=bypass — steps run with --dangerously-skip-permissions. ' +
        'Safety relies on worktree isolation + exclude guardrail + PR review (never ' +
        'auto-merge). Only run on tickets from sources you trust.',
    )
  }
  log.info(
    `ticketloop watching (${cfg.tracker.type}) — provider=${cfg.runner.defaultProvider}, ` +
      `${cfg.projects.length} project(s), poll every ${cfg.tracker.pollIntervalSec}s` +
      (opts.mock ? '  [DEMO/MOCK MODE]' : ''),
  )

  type Job = {
    project: (typeof cfg.projects)[number]
    tracker: ReturnType<typeof makeTracker>
    ticket: Awaited<ReturnType<ReturnType<typeof makeTracker>['listCandidates']>>[number]
    key: string
    marker: string
    reprocess: boolean
  }

  // Pick up to `limit` tickets this project should work on now. `limit` is the
  // project's free parallel slots (1 unless it opted into maxParallel).
  async function selectJobs(project: (typeof cfg.projects)[number], limit: number): Promise<Job[]> {
    const picked: Job[] = []
    if (limit <= 0) return picked
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
      return picked
    }
    for (const t of tickets) {
      const sKey = `${project.name}:${t.identifier}`
      const marker = latestHumanActivity(t)
      // After state corruption: adopt every current ticket as done (don't re-run)
      // so recovery can't cause mass re-processing.
      if (adoptMode) {
        state.set(sKey, { marker, attempts: 0, lastOutcome: 'adopted' })
        continue
      }
      // Never-process: checked FIRST, and ahead of the new-activity test, because
      // the whole point of the mark is that fresh comments must not wake the
      // ticket. A pause says "later"; this says "not at all".
      if (isIgnored(sKey)) continue
      const prev = state.get(sKey)
      // Process when: never seen, OR a genuinely NEW human comment arrived (newest
      // timestamp advanced), OR the last run failed / was interrupted mid-run and
      // we're under the retry cap, OR it paused mid-flight (resume when unpaused).
      const newActivity = !prev || marker > prev.marker
      const needsRetry =
        !!prev &&
        prev.attempts < MAX_ATTEMPTS &&
        (prev.lastOutcome === 'failed' || prev.lastOutcome === 'running')
      const needsResume =
        !!prev && (prev.lastOutcome === 'paused' || (prev.lastOutcome === 'waiting' && prev.blocker?.resume === 'automatic'))
      if (!newActivity && !needsRetry && !needsResume) continue
      if (
        prev?.lastOutcome === 'waiting' &&
        prev.blocker?.kind === 'provider' &&
        prev.blocker.resumeAt &&
        prev.blocker.resumeAt > Date.now() &&
        (!prev.blocker.provider || !ctx.governor.canRun(prev.blocker.provider).ok)
      ) continue
      // Individually paused → leave it (a global pause already stopped the scan).
      if (isPaused(sKey)) continue
      if (activeRuns.has(sKey)) continue // already running (parallel projects)
      picked.push({ project, tracker, ticket: t, key, marker, reprocess: !!prev })
      if (picked.length >= limit) break
    }
    return picked
  }

  // The newest run record for a ticket. Needed on the crash path, where the run
  // threw (its agent was killed) and runJob never received the record.
  function latestRunFor(sKey: string): RunRecord | undefined {
    const project = sKey.slice(0, sKey.indexOf(':'))
    const ticket = sKey.slice(sKey.indexOf(':') + 1)
    const hit = readRuns().find((r) => r.ticket === ticket && r.project === project)
    return hit ? getRun(hit.id) : undefined
  }

  // A stopped run is finished, deliberately. Unlike a pause it keeps no
  // checkpoint (you stopped it because it should not have been running, so there
  // is nothing to resume) and unlike a failure it is never retried — `attempts`
  // is reset and the marker is recorded as handled, so the same ask cannot pick
  // it straight back up on the next scan.
  function settleCancelled(sKey: string, marker: string, rec?: RunRecord): void {
    clearCancel(sKey)
    deleteCheckpoint(sKey)
    // The engine sees a stop as a pause (it halts at the same boundary) or as a
    // crash (the agent was killed). Neither is what happened, and both would
    // offer the user a Continue button for a run they deliberately ended — so
    // the record is corrected to say who stopped it and why.
    if (rec) {
      rec.outcome = 'cancelled'
      rec.summary = 'Stopped by request.'
      rec.error = undefined
      rec.blocker = undefined
      rec.waitReason = undefined
      rec.waitingProvider = undefined
      rec.resumeAt = undefined
      appendRun(rec)
    }
    state.set(sKey, { marker, attempts: 0, lastOutcome: 'cancelled' })
    saveState(state)
    log.info(`  ✋ ${sKey}: stopped by request`)
  }

  /**
   * Stop a ticket now, and/or never process it again.
   *
   * The stop is immediate by design: pausing waits for the current step to end,
   * which can be many minutes of a model working on something already judged
   * wrong. This kills that ticket's agent process group and leaves other
   * projects' runs alone.
   */
  function stopTicket(ticketKey: string, opts: { ignore?: boolean; reason?: string } = {}): {
    stopped: boolean
    killed: number
    ignored: boolean
  } {
    if (opts.ignore) setTicketIgnored(ticketKey, true, opts.reason)
    const wasRunning = activeRuns.has(ticketKey)
    let killed = 0
    if (wasRunning) {
      // Record the intent BEFORE killing: runJob reads it to tell a deliberate
      // stop apart from a genuine crash.
      requestCancel(ticketKey)
      killed = killChildrenFor(ticketKey)
      log.info(`✋ stop requested for ${ticketKey}${killed ? ` — killed ${killed} agent process group(s)` : ''}`)
    }
    // A queued-but-not-running ticket needs no kill; the ignore mark (or the
    // pause) is what keeps it from starting.
    if (!wasRunning && opts.ignore) log.info(`🚫 ${ticketKey} marked never-process`)
    return { stopped: wasRunning, killed, ignored: !!opts.ignore }
  }

  // Run one job to completion and fold its outcome back into per-ticket state.
  // Called fire-and-forget from scanNow (one per project, concurrently).
  async function runJob(job: Job): Promise<void> {
    const sKey = `${job.project.name}:${job.ticket.identifier}`
    // Persist state BEFORE the run (marked 'running', attempts pre-incremented)
    // so a crash mid-run still counts toward MAX_ATTEMPTS.
    const prev = state.get(sKey)
    const attempts = (prev?.attempts || 0) + 1
    state.set(sKey, { marker: job.marker, attempts, lastOutcome: 'running' })
    saveState(state)

    log.info(`→ [${job.project.name}] ${job.ticket.identifier}: ${job.ticket.title}${job.reprocess ? ' (re-processing)' : ''}`)
    let rec
    try {
      rec = await processTicket(ctx, job.ticket, job.project, job.tracker, {
        reprocess: job.reprocess,
        trackerKey: job.key,
        marker: job.marker,
        // System- or ticket-level pause at each stage boundary — and a stop, which
        // must also halt there. Killing the agent covers a stop that lands mid-step,
        // but a stop landing BETWEEN steps has no child to kill; without this the
        // run would calmly carry on to the next step and finish the whole workflow.
        isPaused: () => isPaused(sKey) || isCancelRequested(sKey),
      })
    } catch (e) {
      // A stop request kills the agent mid-step, which surfaces here as a crash.
      // It is not a failure and must not be retried, so it is checked first.
      if (isCancelRequested(sKey)) return settleCancelled(sKey, job.marker, latestRunFor(sKey))
      log.error(`[${job.project.name}] ${job.ticket.identifier} crashed: ${String(e)}`)
      state.set(sKey, { marker: job.marker, attempts, lastOutcome: 'failed' })
      saveState(state)
      return
    }

    // The run may also have ended "cleanly" after the kill (a step that swallowed
    // the signal, or a stop that landed between steps). Same treatment.
    if (isCancelRequested(sKey)) return settleCancelled(sKey, job.marker, rec)

    if (rec.outcome === 'paused') {
      // Not an attempt — the run checkpointed and will resume when unpaused.
      state.set(sKey, { marker: job.marker, attempts: prev?.attempts || 0, lastOutcome: 'paused' })
    } else if (rec.outcome === 'waiting') {
      state.set(sKey, {
        marker: job.marker,
        attempts: prev?.attempts || 0,
        lastOutcome: 'waiting',
        blocker: rec.blocker || {
          kind: 'external',
          reason: rec.summary || 'Waiting for an external condition.',
          resume: 'manual',
        },
      })
    } else if (rec.outcome === 'blocked') {
      // A safety guardrail needs a human or new ticket activity, not retries.
      state.set(sKey, { marker: job.marker, attempts: prev?.attempts || 0, lastOutcome: 'blocked' })
    } else if (rec.outcome === 'failed') {
      state.set(sKey, { marker: job.marker, attempts, lastOutcome: 'failed' })
      if (attempts >= MAX_ATTEMPTS) {
        log.warn(`${job.ticket.identifier}: failed ${attempts}× — giving up, flagging for a human`)
        deleteCheckpoint(sKey) // give up cleanly: a human starts fresh
        try {
          await job.tracker.comment(
            job.ticket.id,
            `⚠️ ticketloop tried to handle this ${attempts} times but couldn't complete it. It needs a human. (Last error: ${(rec.error || '').slice(0, 200)})`,
          )
        } catch { /* best effort */ }
      }
    } else {
      // answered / exported / pr-opened / partial / skipped — done at this marker
      state.set(sKey, { marker: job.marker, attempts: 0, lastOutcome: rec.outcome })
    }
    saveState(state)
  }

  // Both providers refresh together, on one timer, deliberately OUTSIDE the
  // scan. Scanning stops while the daemon is paused, so quota tied to scanning
  // would freeze both meters for the whole pause — the stale-card problem again.
  // The floor keeps a short tracker poll interval from turning into a hot loop
  // against either provider; polling costs no quota, but it is still a request.
  const QUOTA_MIN_INTERVAL_MS = 60_000
  let lastQuotaRefresh = 0
  let quotaInflight: Promise<void> | null = null
  async function refreshQuota(force = false): Promise<void> {
    if (opts.mock) return
    if (quotaInflight) return quotaInflight
    if (!force && Date.now() - lastQuotaRefresh < QUOTA_MIN_INTERVAL_MS) return
    quotaInflight = refreshProviderQuotaSnapshots(cfg)
      .then(() => { lastQuotaRefresh = Date.now() })
      .catch((e) => log.debug(`quota refresh failed: ${String(e)}`))
      .finally(() => { quotaInflight = null })
    return quotaInflight
  }

  // A scan LAUNCHES runs into each project's free slots (fire-and-forget) and
  // returns — it does NOT await them. Projects run concurrently; within a
  // project, `maxParallel` (default 1) caps how many of its tickets run at once.
  async function scanNow(): Promise<{ processed: number }> {
    if (scanning) return { processed: 0 }
    // Paused: don't pick up new work OR resume anything until `resume`. In-flight
    // runs pause themselves at their next stage boundary (checkpointed).
    if (isPaused()) return { processed: 0 }
    scanning = true
    let launched = 0
    try {
      await refreshQuota()
      for (const project of cfg.projects) {
        const jobs = await selectJobs(project, slotsFree(project))
        for (const job of jobs) {
          const sKey = `${project.name}:${job.ticket.identifier}`
          activeRuns.set(sKey, { project: project.name, ticket: job.ticket.identifier })
          launched++
          const p = runJob(job)
            .catch((e) => log.error(`runJob ${job.ticket.identifier}: ${String(e)}`))
            .finally(() => {
              activeRuns.delete(sKey)
              inflight.delete(p)
            })
          inflight.add(p)
        }
      }
      if (adoptMode) {
        adoptMode = false
        saveState(state)
        log.warn(`adopted ${state.size} existing ticket(s) after state recovery — none re-run`)
      }
      if (launched) log.info(`scan: launched ${launched} run(s) — active: ${[...activeRuns.keys()].join(', ')}`)
    } catch (e) {
      log.error(`scan failed: ${String(e)}`)
    } finally {
      lastScan = Date.now()
      scanning = false
    }
    // One-shot `run` awaits the launched work so the process doesn't exit early.
    if (opts.once) await Promise.all([...inflight])
    return { processed: launched }
  }

  // Manually re-run a failed/paused ticket now. `fresh` discards the resume
  // checkpoint so it re-runs from scratch under the CURRENT workflow (use after
  // changing an already-completed stage); otherwise it resumes from the
  // checkpoint. It fetches the ticket DIRECTLY (so it works even if the ticket
  // has moved out of the watched states) and launches it — subject to the
  // one-per-project rule.
  function retryTicket(ticketKey: string, fresh: boolean): { ok: true } | { error: string } {
    const idx = ticketKey.indexOf(':')
    if (idx < 0) return { error: 'bad ticket key' }
    const projectName = ticketKey.slice(0, idx)
    const identifier = ticketKey.slice(idx + 1)
    const project = cfg.projects.find((p) => p.name === projectName)
    if (!project) return { error: `unknown project "${projectName}"` }
    if (isPaused()) return { error: 'Ticket processing is paused. Resume all before continuing a run.' }
    if (activeRuns.has(ticketKey)) return { error: `${identifier} is already running.` }
    if (slotsFree(project) <= 0) {
      const busy = [...activeRuns.values()].filter((a) => a.project === project.name).map((a) => a.ticket)
      const cap = Math.max(1, project.maxParallel || 1)
      return {
        error: `Project "${project.name}" is at its parallel limit (${cap}) — running ${busy.join(', ')}. Try again once one finishes${cap === 1 ? ', or raise "max parallel tickets" for this project' : ''}.`,
      }
    }
    const prev = state.get(ticketKey)
    if (!fresh && prev?.lastOutcome === 'waiting' && prev.blocker?.resume === 'manual' && !loadCheckpoint(ticketKey)) {
      return {
        error:
          'This wait was recorded before safe resume checkpoints were available. ' +
          'Complete the external step manually; do not restart the whole ticket.',
      }
    }
    setTicketPaused(ticketKey, false)
    if (fresh) deleteCheckpoint(ticketKey)
    if (prev) {
      state.set(ticketKey, { ...prev, attempts: 0 }) // clear the give-up cap
      saveState(state)
    }
    log.info(`↻ ${fresh ? 'restart (fresh)' : 'resume'} requested for ${ticketKey}`)
    // Fetch + launch out of band (works regardless of the ticket's current state).
    activeRuns.set(ticketKey, { project: project.name, ticket: identifier }) // reserve the slot
    const tc = resolveTracker(cfg, project)
    const key = resolveTrackerKey(project, tc)
    const tracker = makeTracker(tc, key)
    const p = (async () => {
      await refreshQuota(true) // a manual retry deserves a current answer, not a cached one
      const t = await tracker.getTicket(identifier).catch(() => null)
      if (!t) {
        log.error(`retry: ticket ${identifier} not found in ${project.name}`)
        return
      }
      await runJob({ project, tracker, ticket: t, key, marker: latestHumanActivity(t), reprocess: true })
    })()
      .catch((e) => log.error(`retry ${ticketKey}: ${String(e)}`))
      .finally(() => {
        activeRuns.delete(ticketKey)
        inflight.delete(p)
      })
    inflight.add(p)
    return { ok: true }
  }

  // Failed or paused tickets the user can resume/restart from the dashboard.
  function resumableTickets(): { key: string; outcome: string; attempts: number; canResume: boolean; blocker?: WaitBlocker }[] {
    return [...state.entries()]
      .filter(([, v]) =>
        v.lastOutcome === 'failed' ||
        v.lastOutcome === 'paused' ||
        v.lastOutcome === 'waiting',
      )
      .map(([key, v]) => ({
        key,
        outcome: v.lastOutcome,
        attempts: v.attempts,
        canResume: !!loadCheckpoint(key),
        blocker: v.blocker,
      }))
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
      // every in-flight run (across projects, and within a parallel project)
      activeRuns: [...activeRuns.values()].map((a) => ({ project: a.project, ticket: a.ticket })),
      pausedTickets: pausedTickets(),
      ignoredTickets: ignoredTickets(),
      stoppingTickets: cancelRequestedTickets(),
      resumableTickets: resumableTickets(),
      // first active kept for the legacy single-run widgets
      activeTicket: activeRuns.values().next().value?.ticket,
      activeProject: activeRuns.values().next().value?.project,
      scanTotal: activeRuns.size,
      scanDone: 0,
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
    // Global settings from the dashboard. Mutates the LIVE cfg (so the next run
    // picks it up) and persists the YAML. Only these groups are accepted —
    // Provider auth/server are deliberately not editable here.
    saveSettings: (patch) => {
      try {
        const num = (v: unknown, min: number, max: number) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < min || n > max) throw new Error(`value out of range (${min}–${max})`)
          return Math.round(n)
        }
        const p = patch as any
        if (p.loop) {
          if (p.loop.enabled !== undefined) cfg.loop.enabled = !!p.loop.enabled
          if (p.loop.maxFixIterations !== undefined) cfg.loop.maxFixIterations = num(p.loop.maxFixIterations, 1, 20)
        }
        if (p.runner) {
          if (p.runner.defaultProvider) cfg.runner.defaultProvider = p.runner.defaultProvider
          const selected = cfg.runner.providers[cfg.runner.defaultProvider]
          if (p.runner.defaultModel) selected.defaultModel = String(p.runner.defaultModel)
          if (p.runner.defaultEffort) selected.defaultEffort = p.runner.defaultEffort
          if (p.runner.permissionMode) cfg.runner.permissionMode = p.runner.permissionMode
          if (p.runner.maxTurns !== undefined) cfg.runner.maxTurns = num(p.runner.maxTurns, 1, 1000)
          if (p.runner.stageTimeoutSec !== undefined) cfg.runner.stageTimeoutSec = num(p.runner.stageTimeoutSec, 0, 86400)
          if (p.runner.stageIdleTimeoutSec !== undefined) cfg.runner.stageIdleTimeoutSec = num(p.runner.stageIdleTimeoutSec, 0, 86400)
        }
        if (p.tracker) {
          if (p.tracker.simpleLabel !== undefined) cfg.tracker.simpleLabel = String(p.tracker.simpleLabel)
          if (Array.isArray(p.tracker.states) && p.tracker.states.length) cfg.tracker.states = p.tracker.states.map(String)
          if (p.tracker.pollIntervalSec !== undefined) cfg.tracker.pollIntervalSec = num(p.tracker.pollIntervalSec, 10, 86400)
        }
        return persist()
      } catch (e) {
        return { error: String(e instanceof Error ? e.message : e) }
      }
    },
    retryTicket,
    stopTicket,
  })

  if (opts.once) {
    // one-shot `run --all`: drain every project's queue (each scanNow awaits its
    // launched runs), one ticket per project per round, until nothing's left.
    while ((await scanNow()).processed > 0) { /* keep draining */ }
    running = false
    return
  }

  // Fill both meters before the first scan, so a daemon that starts paused still
  // shows current quota instead of an empty card.
  await refreshQuota(true)

  // initial scan
  await scanNow()

  const timer = setInterval(scanNow, cfg.tracker.pollIntervalSec * 1000)
  // Keeps both meters current while the daemon is paused, when scanNow never
  // runs. refreshQuota's own floor makes the overlap with scanNow a no-op — and
  // is also why this ticks at HALF the floor: ticking at exactly the floor would
  // land each tick a hair under it, skip, and halve the real refresh rate.
  const quotaTimer = setInterval(() => { void refreshQuota() }, QUOTA_MIN_INTERVAL_MS / 2)
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    running = false
    clearInterval(timer)
    clearInterval(quotaTimer)
    srv?.close()
    // Kill any in-flight coding-agent children so nothing keeps editing/pushing after
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
