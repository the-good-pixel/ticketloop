import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../paths.js'

// Tracks live coding-agent child process GROUPS so they can be killed on daemon
// shutdown, and reaped on the next startup if the daemon died without cleaning
// up (kill -9 / power loss). Children are spawned `detached`, so each pid is
// its own process-group id and `process.kill(-pgid, …)` takes down the subtree.
const INFLIGHT_DIR = join(DATA_DIR, 'inflight')
// pgid → the "<project>:<identifier>" whose run spawned it, when known. Kept so
// a stop request can take down ONE ticket's agent instead of every run on the
// box. Absent for calls with no ticket context (nothing to target).
const live = new Map<number, string | undefined>()
let counter = 0

export function registerChild(pgid: number, meta: Record<string, unknown>): string {
  live.set(pgid, typeof meta.ticketKey === 'string' ? meta.ticketKey : undefined)
  const key = `${pgid}-${(counter++).toString(36)}`
  try {
    mkdirSync(INFLIGHT_DIR, { recursive: true })
    writeFileSync(
      join(INFLIGHT_DIR, key + '.json'),
      JSON.stringify({ pgid, startedAt: Date.now(), ...meta }),
    )
  } catch {
    /* best effort */
  }
  return key
}

export function unregisterChild(pgid: number, key: string): void {
  live.delete(pgid)
  try {
    unlinkSync(join(INFLIGHT_DIR, key + '.json'))
  } catch {
    /* already gone */
  }
}

export function killAllChildren(sig: NodeJS.Signals): number {
  let n = 0
  for (const pgid of live.keys()) {
    try {
      process.kill(-pgid, sig)
      n++
    } catch {
      /* already gone */
    }
  }
  return n
}

/**
 * Kill the agent subprocess group(s) belonging to ONE ticket. This is what makes
 * "stop now" different from a pause: a pause lets the current step finish, which
 * can be many minutes of a model working on something the user already decided
 * was wrong. Returns how many groups were signalled.
 */
export function killChildrenFor(ticketKey: string, sig: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0
  for (const [pgid, owner] of live) {
    if (owner !== ticketKey) continue
    try {
      process.kill(-pgid, sig)
      n++
    } catch {
      /* already gone */
    }
  }
  return n
}

/** Startup: SIGKILL any coding-agent process group a previous crash left running. */
export function sweepOrphans(): number {
  if (!existsSync(INFLIGHT_DIR)) return 0
  let killed = 0
  for (const f of readdirSync(INFLIGHT_DIR)) {
    if (!f.endsWith('.json')) continue
    const p = join(INFLIGHT_DIR, f)
    try {
      const { pgid } = JSON.parse(readFileSync(p, 'utf8')) as { pgid: number }
      if (typeof pgid === 'number') {
        try {
          process.kill(-pgid, 0) // throws if the group is gone
          process.kill(-pgid, 'SIGKILL')
          killed++
        } catch {
          /* not alive — nothing to kill */
        }
      }
    } catch {
      /* unreadable */
    }
    try {
      unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
  return killed
}
