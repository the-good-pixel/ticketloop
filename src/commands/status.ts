import type { Config } from '../types.js'
import { readRuns } from '../store.js'
import { isPaused } from '../daemon/control.js'
import { refreshProviderQuotaSnapshots } from '../providerQuota.js'

function bar(pct: number, width = 24): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  const color = pct > 90 ? '\x1b[31m' : pct > 70 ? '\x1b[33m' : '\x1b[32m'
  return `${color}${'█'.repeat(filled)}\x1b[0m${'░'.repeat(width - filled)}`
}
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n))

export async function statusCmd(cfg: Config): Promise<void> {
  const snapshots = await refreshProviderQuotaSnapshots(cfg)
  console.log(`\nticketloop${isPaused() ? '  \x1b[33m⏸ PAUSED\x1b[0m' : ''}\n`)
  for (const snapshot of snapshots) {
    console.log(`  ${snapshot.provider} · ${snapshot.plan || snapshot.authMode}`)
    if (!snapshot.windows.length) console.log('    usage unknown — provider did not report a percentage')
    for (const window of snapshot.windows) {
      const pct = Math.round(window.usedPercent)
      const reset = window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : ''
      console.log(`    ${window.name.padEnd(12)} ${bar(pct)} ${pct}%${reset}`)
    }
  }

  const runs = readRuns(8)
  console.log(`\n  Recent runs (${runs.length}):`)
  if (!runs.length) console.log('    (none yet)')
  for (const r of runs) {
    const when = new Date(r.startedAt).toLocaleTimeString()
    console.log(`    ${when}  ${r.ticket.padEnd(10)} ${r.outcome.padEnd(16)} ${k(r.totalTokens)} tok  ${r.ticketTitle.slice(0, 40)}`)
  }
  console.log('')
}
