import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, extname } from 'node:path'
import type { Config, ProjectConfig } from '../types.js'
import { STAGE_ORDER } from '../types.js'
import { Governor } from '../governor/governor.js'
import { readRuns, getRun } from '../store.js'
import { assertAuthSafe } from '../runner/index.js'
import { resolveTracker, DEFAULT_INSTRUCTIONS } from '../config.js'
import { hasCredential, resolveTrackerKey } from '../credentials.js'
import { isPaused, setPaused, setTicketPaused, pausedTickets } from './control.js'
import { log } from '../logger.js'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export interface ServerHooks {
  scanNow: () => Promise<{ processed: number }>
  status: () => {
    running: boolean
    lastScan?: number
    nextScan?: number
    scanning?: boolean
    scanDone?: number
    scanTotal?: number
    activeTicket?: string
    activeProject?: string
    activeRuns?: { project: string; ticket: string }[]
    pausedTickets?: string[]
    resumableTickets?: { key: string; outcome: string; attempts: number }[]
  }
  // project setup (UI-driven); these persist config / credentials on disk
  saveProject: (p: ProjectConfig) => { ok: true } | { error: string }
  removeProject: (name: string) => { ok: true } | { error: string }
  setKey: (project: string, key: string) => { ok: true } | { error: string }
  // Edit the global (non-project) settings from the dashboard.
  saveSettings: (patch: Record<string, unknown>) => { ok: true } | { error: string }
  // Re-run a failed/paused ticket now; `fresh` discards its resume checkpoint.
  retryTicket: (ticketKey: string, fresh: boolean) => { ok: true } | { error: string }
}

// Selectable models for the per-step dropdown. Aliases (opus/sonnet/haiku)
// always resolve to the latest of that tier; the dated/specific IDs pin a version.
const MODELS: Record<string, { label: string; value: string }[]> = {
  claude: [
    { label: 'Opus (latest)', value: 'opus' },
    { label: 'Sonnet (latest)', value: 'sonnet' },
    { label: 'Haiku (latest)', value: 'haiku' },
  ],
  codex: [
    { label: 'GPT-5.6 Sol', value: 'gpt-5.6-sol' },
    { label: 'GPT-5.6 Terra', value: 'gpt-5.6-terra' },
    { label: 'GPT-5.6 Luna', value: 'gpt-5.6-luna' },
  ],
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function toolExists(bin: string, args: string[]): boolean {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  return (r.status ?? 1) === 0
}

let toolingCache: { claude: boolean; codex: boolean; gh: boolean; git: boolean } | null = null
function tooling(cfg: Config) {
  if (!toolingCache) {
    toolingCache = {
      claude: toolExists(cfg.runner.providers.claude.bin, ['--version']),
      codex: toolExists(cfg.runner.providers.codex.bin, ['--version']),
      gh: toolExists('gh', ['--version']),
      git: toolExists('git', ['--version']),
    }
  }
  return toolingCache
}

const OUTCOMES = ['answered', 'exported', 'pr-opened', 'pr-opened-with-findings', 'deployed', 'partial', 'merged', 'skipped', 'blocked', 'waiting-provider', 'paused', 'failed', 'running']

function parseDate(v: string | null, endOfDay = false): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v) // epoch ms
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (endOfDay) d.setHours(23, 59, 59, 999)
    return d.getTime()
  }
  return null
}

/** Filter/sort/paginate the run index for the History view. */
function queryHistory(p: URLSearchParams) {
  const projects = p.getAll('project')
  const outcomes = p.getAll('outcome')
  const ticket = (p.get('ticket') || '').toLowerCase()
  const q = (p.get('q') || '').toLowerCase().slice(0, 200)
  const from = parseDate(p.get('from'))
  const to = parseDate(p.get('to'), true)
  const sort = p.get('sort') || 'started_desc'
  const limit = Math.min(200, Math.max(1, Number(p.get('limit') || 25)))
  const offset = Math.max(0, Number(p.get('offset') || 0))

  let runs = readRuns() // lite summaries from the in-memory index
  if (projects.length) runs = runs.filter((r) => projects.includes(r.project))
  if (outcomes.length) runs = runs.filter((r) => outcomes.includes(r.outcome))
  if (ticket) runs = runs.filter((r) => r.ticket.toLowerCase().startsWith(ticket))
  if (q) runs = runs.filter((r) => (r.ticketTitle || '').toLowerCase().includes(q) || r.ticket.toLowerCase().includes(q))
  if (from != null) runs = runs.filter((r) => r.startedAt >= from)
  if (to != null) runs = runs.filter((r) => r.startedAt <= to)

  const dur = (r: (typeof runs)[number]) => (r.endedAt || Date.now()) - r.startedAt
  const sorters: Record<string, (a: any, b: any) => number> = {
    started_desc: (a, b) => b.startedAt - a.startedAt,
    started_asc: (a, b) => a.startedAt - b.startedAt,
    cost_desc: (a, b) => (b.costUsd || 0) - (a.costUsd || 0),
    tokens_desc: (a, b) => (b.totalTokens || 0) - (a.totalTokens || 0),
    duration_desc: (a, b) => dur(b) - dur(a),
  }
  runs.sort(sorters[sort] || sorters.started_desc)
  const total = runs.length
  return { total, limit, offset, sort, runs: runs.slice(offset, offset + limit) }
}

function historyFacets() {
  const runs = readRuns()
  const projects = [...new Set(runs.map((r) => r.project))].sort()
  let earliest = Infinity
  let latest = 0
  for (const r of runs) {
    if (r.startedAt < earliest) earliest = r.startedAt
    if (r.startedAt > latest) latest = r.startedAt
  }
  return {
    projects,
    outcomes: OUTCOMES,
    earliest: runs.length ? earliest : null,
    latest: runs.length ? latest : null,
  }
}

export function startServer(cfg: Config, hooks: ServerHooks): { close: () => void } {
  const gov = new Governor(cfg)

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname

    try {
      if (path === '/api/status') return json(res, buildStatus(cfg, hooks))
      if (path === '/api/usage') {
        return json(res, { providers: gov.summary() })
      }
      if (path === '/api/activity') {
        const limit = Number(url.searchParams.get('limit') || 50)
        return json(res, readRuns(limit))
      }
      if (path.startsWith('/api/activity/')) {
        const id = decodeURIComponent(path.slice('/api/activity/'.length))
        const run = getRun(id)
        return run ? json(res, run) : notFound(res)
      }
      // ---- History (searchable archive) ----
      if (path === '/api/history' && req.method === 'GET') {
        return json(res, queryHistory(url.searchParams))
      }
      if (path === '/api/history/facets' && req.method === 'GET') {
        return json(res, historyFacets())
      }
      if (path === '/api/scan' && req.method === 'POST') {
        hooks.scanNow().then((r) => json(res, r)).catch((e) => serverError(res, e))
        return
      }
      // ---- Resume / restart a failed or paused ticket now ----
      if (path === '/api/retry' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { ticketKey?: string; fresh?: boolean }
          if (!b.ticketKey) return json(res, { error: 'ticketKey required' })
          json(res, hooks.retryTicket(b.ticketKey, !!b.fresh))
        }).catch((e) => serverError(res, e))
        return
      }
      // ---- Pause / resume — system-level (no ticketKey) or per-ticket ----
      if (path === '/api/pause' && req.method === 'POST') {
        readBody(req).then((body) => {
          const b = body as { paused?: boolean; ticketKey?: string }
          const paused = !!b.paused
          if (b.ticketKey) {
            setTicketPaused(b.ticketKey, paused)
            log.info(`${paused ? '⏸ paused' : '▶ resumed'} ticket ${b.ticketKey} via dashboard`)
            // On resume, warn if the project is busy with a DIFFERENT ticket —
            // one-per-project means this one waits until that finishes.
            let warning: string | undefined
            if (!paused) {
              const proj = b.ticketKey.split(':')[0]
              const busy = (hooks.status().activeRuns || []).find((a) => a.project === proj && `${a.project}:${a.ticket}` !== b.ticketKey)
              if (busy) warning = `Project "${proj}" is busy with ${busy.ticket} — this ticket will resume once that finishes (one run per project).`
            }
            json(res, { paused, ticketKey: b.ticketKey, warning })
          } else {
            setPaused(paused)
            log.info(paused ? '⏸ paused via dashboard' : '▶ resumed via dashboard')
            json(res, { paused })
          }
        }).catch((e) => serverError(res, e))
        return
      }
      // ---- Filesystem browser for the repo-path picker ----
      if (path === '/api/fs' && req.method === 'GET') {
        return json(res, listDir(url.searchParams.get('path')))
      }
      // ---- Project setup (UI) ----
      if (path === '/api/config' && req.method === 'GET') {
        return json(res, buildConfigView(cfg))
      }
      if (path === '/api/projects' && req.method === 'POST') {
        readBody(req).then((body) => {
          const p = body as ProjectConfig
          json(res, hooks.saveProject(p))
        }).catch((e) => serverError(res, e))
        return
      }
      if (path.startsWith('/api/projects/') && req.method === 'DELETE') {
        const name = decodeURIComponent(path.slice('/api/projects/'.length))
        return json(res, hooks.removeProject(name))
      }
      if (path === '/api/settings' && req.method === 'POST') {
        readBody(req).then((body) => {
          json(res, hooks.saveSettings(body as Record<string, unknown>))
        }).catch((e) => serverError(res, e))
        return
      }
      if (path === '/api/keys' && req.method === 'POST') {
        readBody(req).then((body) => {
          const { project, key } = body as { project: string; key: string }
          json(res, hooks.setKey(project, key))
        }).catch((e) => serverError(res, e))
        return
      }
      return serveStatic(path, res)
    } catch (e) {
      serverError(res, e)
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `dashboard port ${cfg.server.port} is already in use — another ticketloop is ` +
          `likely running. Stop it, or set server.port to a free port.`,
      )
    } else {
      log.error(`dashboard server error: ${err.message}`)
    }
    process.exit(1)
  })
  server.listen(cfg.server.port, cfg.server.host, () => {
    log.info(
      `dashboard: http://${cfg.server.host}:${cfg.server.port}  (usage + history)`,
    )
  })
  return { close: () => server.close() }
}

function buildStatus(cfg: Config, hooks: ServerHooks) {
  const auth = assertAuthSafe(cfg)
  const s = hooks.status()
  return {
    running: s.running,
    paused: isPaused(),
    lastScan: s.lastScan,
    nextScan: s.nextScan,
    scanning: !!s.scanning,
    scanDone: s.scanDone ?? 0,
    scanTotal: s.scanTotal ?? 0,
    activeTicket: s.activeTicket,
    activeProject: s.activeProject,
    activeRuns: s.activeRuns ?? [],
    pausedTickets: s.pausedTickets ?? [],
    resumableTickets: s.resumableTickets ?? [],
    authMode: cfg.runner.providers[cfg.runner.defaultProvider].authMode,
    provider: cfg.runner.defaultProvider,
    tracker: cfg.tracker.type,
    warnings: auth.warnings,
    projects: cfg.projects.map((p) => ({
      name: p.name,
      autonomy: p.autonomy,
      repoPath: p.repoPath,
    })),
  }
}

/** Sanitized config for the UI: globals read-only, projects editable, NO keys. */
function buildConfigView(cfg: Config) {
  return {
    // globals — editable from the dashboard's Settings card except provider
    // auth and server settings, which are config-file-only.
    globals: {
      loop: cfg.loop,
      runner: cfg.runner,
      server: cfg.server,
      trackerDefaults: {
        type: cfg.tracker.type,
        simpleLabel: cfg.tracker.simpleLabel,
        states: cfg.tracker.states,
        pollIntervalSec: cfg.tracker.pollIntervalSec,
      },
      stages: cfg.stages,
    },
    stageOrder: STAGE_ORDER,
    defaultInstructions: DEFAULT_INSTRUCTIONS,
    models: MODELS,
    efforts: EFFORTS,
    tooling: tooling(cfg),
    projects: cfg.projects.map((p) => {
      const tc = resolveTracker(cfg, p)
      return {
        ...p,
        // never expose the key; report whether one is resolvable and its source
        hasKey: !!resolveTrackerKey(p, tc),
        keySource: hasCredential(p.name)
          ? 'daemon'
          : process.env[tc.apiKeyEnv]
            ? 'env'
            : null,
        resolvedTracker: { type: tc.type, simpleLabel: tc.simpleLabel, states: tc.states, team: tc.team },
        repoExists: existsSync(p.repoPath),
      }
    }),
  }
}

/** List sub-directories of a local path for the repo-path picker (localhost only). */
function listDir(p: string | null): {
  path: string
  parent: string | null
  isGitRepo: boolean
  dirs: { name: string; path: string }[]
} {
  const base = p && p.trim() ? resolve(p) : homedir()
  const parent = dirname(base)
  const dirs: { name: string; path: string }[] = []
  try {
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (ent.name.startsWith('.') && ent.name !== '.') continue // skip dotdirs (except allow navigating)
      dirs.push({ name: ent.name, path: join(base, ent.name) })
    }
  } catch {
    /* unreadable dir → empty list */
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return {
    path: base,
    parent: parent === base ? null : parent,
    isGitRepo: existsSync(join(base, '.git')),
    dirs,
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(body)
}
function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"error":"not found"}')
}
function serverError(res: ServerResponse, e: unknown) {
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: String(e) }))
}

// The dashboard is served fresh from disk and changes whenever the daemon is
// updated, so tell browsers never to cache it — otherwise a stale app.js/style
// keeps rendering an old UI even after a hard refresh (the source of every
// "hard-refresh needed / button missing" surprise).
const NO_CACHE = 'no-cache, no-store, must-revalidate'

function serveStatic(path: string, res: ServerResponse) {
  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '')
  const file = resolve(WEB_DIR, rel)
  if (!file.startsWith(resolve(WEB_DIR)) || !existsSync(file)) {
    // SPA-ish fallback to index
    const index = join(WEB_DIR, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': NO_CACHE })
      res.end(readFileSync(index))
      return
    }
    return notFound(res)
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': NO_CACHE,
  })
  res.end(readFileSync(file))
}
