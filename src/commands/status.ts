import type { Config } from '../types.js'
import { Governor } from '../governor/governor.js'
import { readRuns } from '../store.js'
import { readRealUsage } from '../realUsage.js'

function bar(pct: number, width = 24): string {
  const filled = Math.round((pct / 100) * width)
  const color = pct > 90 ? '\x1b[31m' : pct > 70 ? '\x1b[33m' : '\x1b[32m'
  return `${color}${'█'.repeat(filled)}\x1b[0m${'░'.repeat(width - filled)}`
}
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n))

export function statusCmd(cfg: Config): void {
  const gov = new Governor(cfg)
  const s = gov.summary()
  const real = readRealUsage()
  console.log(`\nticketloop — plan ${s.plan}, auth ${s.authMode}\n`)
  const line = (label: string, realPct: number | undefined, loopUsed: number, cost: number) => {
    const pct = Math.round(realPct ?? 0)
    const src = realPct != null ? 'real' : 'no data'
    console.log(
      `  ${label.padEnd(10)} ${bar(pct)} ${realPct != null ? pct + '%' : '  —'} (${src})  ` +
        `loop: ${k(loopUsed)} tok  $${cost.toFixed(3)}`,
    )
  }
  line('5h usage', real?.fiveHour?.pct, s.window.used, s.window.costUsd)
  line('weekly', real?.sevenDay?.pct, s.weekly.used, s.weekly.costUsd)

  const runs = readRuns(8)
  console.log(`\n  Recent runs (${runs.length}):`)
  if (!runs.length) console.log('    (none yet)')
  for (const r of runs) {
    const when = new Date(r.startedAt).toLocaleTimeString()
    console.log(
      `    ${when}  ${r.ticket.padEnd(10)} ${r.outcome.padEnd(9)} ` +
        `${k(r.totalTokens)} tok  ${r.ticketTitle.slice(0, 40)}`,
    )
  }
  console.log('')
}
