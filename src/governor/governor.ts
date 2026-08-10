import type { Config, UsageSummary, WindowUsage, UsageEvent } from '../types.js'
import { readUsage } from '../store.js'
import { readRealUsage } from '../realUsage.js'

// The governor tracks the tokens Claude reports back and expresses them as a
// percentage of a *configured* budget. Anthropic does not publish real
// subscription quotas, so `sessionTokenBudget` / `weeklyTokenBudget` are
// user-tunable estimates. Treat the % as a relative gauge, not a hard truth.

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR

function windowUsage(
  events: UsageEvent[],
  now: number,
  spanMs: number,
  budget: number,
): WindowUsage {
  const since = now - spanMs
  const inWindow = events.filter((e) => e.ts >= since)
  // Weight cache-READ tokens low (they're the cheap cached portion, ~0.1x) so a
  // single cache-heavy agentic stage doesn't falsely max the meter. Input,
  // output, and cache-CREATION count in full.
  const used = inWindow.reduce(
    (s, e) => s + e.inputTokens + e.outputTokens + e.cacheCreationTokens + 0.1 * e.cacheReadTokens,
    0,
  )
  const costUsd = inWindow.reduce((s, e) => s + e.costUsd, 0)
  // Oldest event in the window frees up when it exits the trailing span.
  const oldest = inWindow.reduce((m, e) => Math.min(m, e.ts), now)
  const resetAt = inWindow.length ? oldest + spanMs : now
  return {
    used,
    budget,
    pct: budget > 0 ? Math.min(100, (used / budget) * 100) : 0,
    resetAt,
    costUsd,
  }
}

export class Governor {
  constructor(private cfg: Config) {}

  summary(now = Date.now()): UsageSummary {
    const events = readUsage(now - WEEK) // widest span we need
    const windowSpan = this.cfg.quota.windowHours * HOUR
    return {
      window: windowUsage(
        events,
        now,
        windowSpan,
        this.cfg.quota.sessionTokenBudget,
      ),
      weekly: windowUsage(events, now, WEEK, this.cfg.quota.weeklyTokenBudget),
      authMode: this.cfg.auth.mode,
      plan: this.cfg.quota.plan,
    }
  }

  /**
   * Should the loop start a new run right now? Gates on the REAL Claude
   * subscription usage % (read from Claude Code) when available; if it isn't, we
   * don't hard-block on the unreliable token estimate — the rate-limit backstop
   * (Claude actually returning "limit reached") protects us instead.
   * `headroomPct` reserves a small margin so a single run doesn't blow past.
   */
  canRun(_now = Date.now(), headroomPct = 3): {
    ok: boolean
    reason?: string
    resetAt?: number
  } {
    const real = readRealUsage()
    if (!real) return { ok: true } // no real data → allow; rate-limit backstop guards
    if (real.fiveHour && real.fiveHour.pct >= 100 - headroomPct) {
      return { ok: false, reason: `5h usage at ${real.fiveHour.pct}% (real)`, resetAt: real.fiveHour.resetsAt }
    }
    if (real.sevenDay && real.sevenDay.pct >= 100 - headroomPct) {
      return { ok: false, reason: `weekly usage at ${real.sevenDay.pct}% (real)`, resetAt: real.sevenDay.resetsAt }
    }
    return { ok: true }
  }
}
