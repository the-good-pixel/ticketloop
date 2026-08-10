import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Claude Code writes the REAL subscription usage into the statusline payload it
// feeds its statusline command. We read that file to display accurate 5h/7d
// usage %, rather than our own (unreliable) token estimate. It refreshes
// whenever an interactive Claude Code session renders its statusline, so it's
// current as long as you use Claude Code; we surface its age via `asOf`.
const STATUSLINE_INPUT = join(homedir(), '.claude', 'last-statusline-input.json')

export interface RealWindow {
  pct: number
  resetsAt: number // epoch ms
}
export interface RealUsage {
  fiveHour: RealWindow | null
  sevenDay: RealWindow | null
  asOf: number // file mtime, epoch ms — how fresh the number is
}

// Cache the last successful read so a transient failure (e.g. reading the file
// while Claude Code is mid-write) never makes us fall back to the estimate —
// we keep showing the last known REAL number instead.
let lastGood: RealUsage | null = null

export function readRealUsage(): RealUsage | null {
  try {
    const raw = JSON.parse(readFileSync(STATUSLINE_INPUT, 'utf8'))
    const rl = raw?.rate_limits
    if (!rl) return lastGood
    const mk = (o: any): RealWindow | null =>
      o && typeof o.used_percentage === 'number'
        ? { pct: o.used_percentage, resetsAt: (o.resets_at || 0) * 1000 }
        : null
    const fiveHour = mk(rl.five_hour)
    const sevenDay = mk(rl.seven_day)
    if (!fiveHour && !sevenDay) return lastGood
    lastGood = { fiveHour, sevenDay, asOf: statSync(STATUSLINE_INPUT).mtimeMs }
    return lastGood
  } catch {
    return lastGood
  }
}
