import { existsSync, readFileSync } from 'node:fs'
import { COOLDOWN_FILE } from '../paths.js'
import { atomicWrite, removeFile } from '../store.js'
import { readRealUsage } from '../realUsage.js'

// When Claude returns a real usage limit it tells us WHEN it resets. We remember
// that reset time and simply don't run anything until it passes. (The usage
// gauge can read far below 100% while Claude is actually limiting the daemon's
// runs, so the reset time from the limit itself is the only thing to trust.)

interface RL {
  until: number // epoch ms the limit resets; no runs before this
}

function read(): RL {
  try {
    if (!existsSync(COOLDOWN_FILE)) return { until: 0 }
    return JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')) as RL
  } catch {
    return { until: 0 }
  }
}

/** The reset deadline if we're still inside a rate-limit window, else 0. */
export function resetUntil(now = Date.now()): number {
  const u = read().until
  return u > now ? u : 0
}

/**
 * Record a rate-limit's reset time. Prefer what Claude reported; fall back to
 * the status line's window reset; last resort, an hour out.
 */
export function setRateLimited(resetAt?: number, now = Date.now()): number {
  let until = resetAt && resetAt > now ? resetAt : 0
  if (!until) {
    const real = readRealUsage()
    const g = real?.fiveHour?.resetsAt
    until = g && g > now ? g : now + 60 * 60 * 1000
  }
  atomicWrite(COOLDOWN_FILE, JSON.stringify({ until } satisfies RL))
  return until
}

/** A clean run means we're not limited — drop the reset window. */
export function clearRateLimited(): void {
  if (existsSync(COOLDOWN_FILE)) {
    try {
      removeFile(COOLDOWN_FILE)
    } catch {
      /* best effort */
    }
  }
}
