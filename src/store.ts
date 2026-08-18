import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR, USAGE_LOG, RUNS_LOG } from './paths.js'
import type { RunRecord, UsageEvent } from './types.js'
import { legacyWaitKind } from './waiting.js'

function ensureDir(dir = DATA_DIR) {
  mkdirSync(dir, { recursive: true })
}

const RUNS_DIR = join(DATA_DIR, 'runs')

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const out: T[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as T)
    } catch {
      /* skip corrupt line */
    }
  }
  return out
}

// ---- Usage events (append-only jsonl, pruned to a rolling window) -----------

export function appendUsage(ev: UsageEvent): void {
  ensureDir()
  appendFileSync(USAGE_LOG, JSON.stringify(ev) + '\n')
}

export function readUsage(sinceMs?: number): UsageEvent[] {
  const all = readJsonl<UsageEvent>(USAGE_LOG)
  return sinceMs ? all.filter((e) => e.ts >= sinceMs) : all
}

/** Drop usage events older than `days` (nothing queries beyond ~7d). */
export function pruneUsage(days = 8): number {
  if (!existsSync(USAGE_LOG)) return 0
  const cutoff = Date.now() - days * 24 * 3600_000
  const all = readJsonl<UsageEvent>(USAGE_LOG)
  const kept = all.filter((e) => e.ts >= cutoff)
  if (kept.length === all.length) return 0
  atomicWrite(USAGE_LOG, kept.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return all.length - kept.length
}

// ---- Run records -----------------------------------------------------------
// One file per run at runs/<id>.json, rewritten IN PLACE (no append/write
// amplification). A lazily-built in-memory index of lightweight summaries
// (stage detail stripped) serves the list/history views without opening every
// file. The index is rebuildable from the files, so it is never the source of
// truth and never persisted.

let index: Map<string, RunRecord> | null = null

function runFile(id: string): string {
  return join(RUNS_DIR, encodeURIComponent(id) + '.json')
}

/** A run with per-stage `detail` stripped — small enough for list payloads. */
function lite(rec: RunRecord): RunRecord {
  const normalized = normalizeRunRecord(rec)
  return {
    ...normalized,
    stages: normalized.stages.map((s) => ({ ...s, detail: undefined })),
  }
}

/** Normalize old persisted wait outcomes at the read boundary. */
export function normalizeRunRecord(rec: RunRecord): RunRecord {
  const legacyKind = legacyWaitKind(rec.outcome as string)
  if (!legacyKind && rec.outcome !== 'waiting') return rec
  const kind = legacyKind || rec.blocker?.kind || 'external'
  const reason = rec.blocker?.reason || rec.waitReason || waitReasonFromStages(rec) || rec.summary || 'Waiting for an external condition.'
  return {
    ...rec,
    outcome: 'waiting',
    blocker: rec.blocker || {
      kind,
      reason,
      resume: kind === 'provider' ? 'automatic' : 'manual',
      provider: rec.waitingProvider,
      resumeAt: rec.resumeAt,
    },
  }
}

// Older waiting records may only name the reason in the model output. Recover
// it while the full record is in memory, before stage detail is stripped.
function waitReasonFromStages(rec: RunRecord): string | undefined {
  if (rec.outcome !== 'waiting' && !(rec.outcome as string).startsWith('waiting-')) return undefined
  for (let i = rec.stages.length - 1; i >= 0; i--) {
    const detail = rec.stages[i].detail || ''
    const matches = [...detail.matchAll(/^\s*VERDICT:\s*wait(?:\s*[—-]\s*(.+))?\s*$/gim)]
    const reason = matches.at(-1)?.[1]?.trim()
    if (reason) return reason
  }
  return undefined
}

function ensureIndex(): Map<string, RunRecord> {
  if (index) return index
  index = new Map()
  migrateLegacyRunsLog()
  if (existsSync(RUNS_DIR)) {
    for (const f of readdirSync(RUNS_DIR)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8')) as RunRecord
        index.set(rec.id, lite(rec))
      } catch {
        /* skip unreadable run file */
      }
    }
  }
  return index
}

/** One-time import of the old append-only runs.jsonl into per-run files. */
function migrateLegacyRunsLog(): void {
  if (!existsSync(RUNS_LOG)) return
  ensureDir(RUNS_DIR)
  const byId = new Map<string, RunRecord>()
  for (const r of readJsonl<RunRecord>(RUNS_LOG)) byId.set(r.id, r) // last wins
  for (const rec of byId.values()) {
    try {
      atomicWrite(runFile(rec.id), JSON.stringify(rec))
    } catch {
      /* ignore */
    }
  }
  try {
    renameSync(RUNS_LOG, RUNS_LOG + '.migrated')
  } catch {
    /* ignore */
  }
}

/** Write/update a run — in place, 1× per call. Named appendRun for callers. */
export function appendRun(rec: RunRecord): void {
  const normalized = normalizeRunRecord(rec)
  ensureDir(RUNS_DIR)
  atomicWrite(runFile(normalized.id), JSON.stringify(normalized))
  ensureIndex().set(normalized.id, lite(normalized))
}

/** Lightweight run summaries (no stage detail), newest first. */
export function readRuns(limit?: number): RunRecord[] {
  const list = [...ensureIndex().values()].sort((a, b) => b.startedAt - a.startedAt)
  return limit ? list.slice(0, limit) : list
}

/** Full run record (with stage detail) from disk. */
export function getRun(id: string): RunRecord | undefined {
  const f = runFile(id)
  if (existsSync(f)) {
    try {
      return normalizeRunRecord(JSON.parse(readFileSync(f, 'utf8')) as RunRecord)
    } catch {
      /* fall through to index */
    }
  }
  return ensureIndex().get(id)
}

/** Mark any run still "running" (daemon killed mid-run) as failed. */
export function abortStaleRuns(): number {
  let n = 0
  for (const summary of readRuns()) {
    if (summary.outcome !== 'running') continue
    const r = getRun(summary.id) || summary
    r.outcome = 'failed'
    r.endedAt = Date.now()
    r.error = 'aborted — daemon stopped while this run was in progress'
    for (const s of r.stages) {
      if (s.status === 'running') {
        s.status = 'failed'
        s.endedAt = Date.now()
      }
    }
    appendRun(r)
    n++
  }
  return n
}

// ---- Atomic file writes ----------------------------------------------------

/** Write via temp file + fsync + rename so a crash never leaves a torn file. */
export function atomicWrite(path: string, data: string): void {
  // Several first-run state files are written before any run record exists.
  // Make the destination here so every atomic writer is safe on a clean home.
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

// ---- Daemon state / JSON (atomic; corruption is loud, not silent) ----------

export function writeJson(path: string, data: unknown): void {
  ensureDir()
  atomicWrite(path, JSON.stringify(data, null, 2))
}

export class CorruptStateError extends Error {}

/**
 * Returns null when the file is MISSING (a normal fresh start), but THROWS
 * CorruptStateError when the file exists yet fails to parse — callers must
 * handle that loudly instead of silently resetting state (which would cause
 * mass re-processing).
 */
export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new CorruptStateError(`${path} is corrupt: ${String(e)}`)
  }
}

export { unlinkSync as removeFile }
