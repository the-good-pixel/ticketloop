import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { AgentProvider, Config, ProviderQuotaSnapshot, ProviderQuotaWindow } from './types.js'
import { PROVIDER_QUOTA_FILE } from './paths.js'
import { atomicWrite } from './store.js'
import { readRealUsage } from './realUsage.js'
import { clearRateLimited, setRateLimited } from './governor/cooldown.js'
import { log } from './logger.js'

type SnapshotFile = Partial<Record<AgentProvider, ProviderQuotaSnapshot>>

function readFile(): SnapshotFile {
  try {
    return existsSync(PROVIDER_QUOTA_FILE)
      ? JSON.parse(readFileSync(PROVIDER_QUOTA_FILE, 'utf8'))
      : {}
  } catch {
    return {}
  }
}

function saveFile(file: SnapshotFile): void {
  atomicWrite(PROVIDER_QUOTA_FILE, JSON.stringify(file))
}

function claudeSnapshot(cfg: Config): ProviderQuotaSnapshot | null {
  if (cfg.runner.providers.claude.authMode !== 'subscription') return null
  const usage = readRealUsage()
  if (!usage) return null
  const windows: ProviderQuotaWindow[] = []
  if (usage.fiveHour) windows.push({ name: '5-hour', usedPercent: usage.fiveHour.pct, windowDurationMins: 300, resetsAt: usage.fiveHour.resetsAt })
  if (usage.sevenDay) windows.push({ name: 'weekly', usedPercent: usage.sevenDay.pct, windowDurationMins: 10080, resetsAt: usage.sevenDay.resetsAt })
  return {
    provider: 'claude',
    authMode: cfg.runner.providers.claude.authMode,
    fetchedAt: usage.asOf,
    windows,
    limitReached: windows.some((window) => window.usedPercent >= 100),
    source: 'provider-status',
  }
}

function windowName(duration?: number, fallback?: string): string {
  if (duration === 300) return '5-hour'
  if (duration === 10080) return 'weekly'
  if (duration) return `${duration}-minute`
  return fallback || 'usage'
}

function normalizeCodex(result: any, cfg: Config): ProviderQuotaSnapshot {
  const root = result?.rateLimits ?? result ?? {}
  const byLimitId = result?.rateLimitsByLimitId ?? root.rateLimitsByLimitId
  const buckets = byLimitId && typeof byLimitId === 'object' && Object.keys(byLimitId).length
    ? Object.entries(byLimitId).map(([limitId, value]: [string, any]) => ({ limitId, ...value }))
    : [root]
  const windows: ProviderQuotaWindow[] = []
  let reachedType: string | null = root.rateLimitReachedType ?? null
  let plan = root.planType
  for (const bucket of buckets as any[]) {
    plan ||= bucket.planType
    reachedType ||= bucket.rateLimitReachedType ?? null
    for (const [key, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]] as const) {
      if (!window || typeof window.usedPercent !== 'number') continue
      windows.push({
        name: windowName(window.windowDurationMins, bucket.limitName || bucket.limitId || key),
        usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins,
        resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : undefined,
      })
    }
  }
  return {
    provider: 'codex',
    authMode: cfg.runner.providers.codex.authMode,
    plan,
    fetchedAt: Date.now(),
    windows,
    limitReached: !!reachedType || windows.some((window) => window.usedPercent >= 100),
    reachedType,
    source: 'provider-status',
  }
}

async function readCodexRateLimits(cfg: Config): Promise<ProviderQuotaSnapshot> {
  const provider = cfg.runner.providers.codex
  const env = { ...process.env }
  if (provider.authMode === 'subscription') {
    delete env.OPENAI_API_KEY
    delete env.CODEX_API_KEY
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(provider.bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error, snapshot?: ProviderQuotaSnapshot) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already stopped */ }
      if (error) reject(error)
      else resolve(snapshot!)
    }
    const timer = setTimeout(() => finish(new Error('Codex rate-limit status timed out')), 8000)
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line)
          if (message.id === 1) {
            send({ method: 'initialized' })
            send({ method: 'account/rateLimits/read', id: 2 })
          } else if (message.id === 2) {
            if (message.error) finish(new Error(message.error.message || 'Codex rate-limit status failed'))
            else finish(undefined, normalizeCodex(message.result, cfg))
          }
        } catch { /* ignore app-server log lines */ }
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (!settled) finish(new Error(`Codex rate-limit status exited ${code}: ${stderr.trim().slice(0, 200)}`))
    })
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'ticketloop', title: 'ticketloop', version: '0.1.0' } } })
  })
}

export function readProviderQuotaSnapshots(cfg: Config): ProviderQuotaSnapshot[] {
  const file = readFile()
  const claude = claudeSnapshot(cfg)
  if (claude) file.claude = claude
  else if (cfg.runner.providers.claude.authMode !== 'subscription') delete file.claude
  return (['claude', 'codex'] as AgentProvider[])
    .map((provider) => (file[provider]?.authMode === cfg.runner.providers[provider].authMode ? file[provider] : undefined) || {
      provider,
      authMode: cfg.runner.providers[provider].authMode,
      fetchedAt: 0,
      windows: [],
      limitReached: false,
      source: 'provider-status' as const,
    })
}

export async function refreshProviderQuotaSnapshots(cfg: Config): Promise<ProviderQuotaSnapshot[]> {
  const file = readFile()
  const claude = claudeSnapshot(cfg)
  if (claude) file.claude = claude
  else if (cfg.runner.providers.claude.authMode !== 'subscription') delete file.claude
  try {
    if (cfg.runner.providers.codex.authMode === 'subscription') file.codex = await readCodexRateLimits(cfg)
    else delete file.codex
  } catch (error) {
    log.debug(`could not refresh Codex usage: ${String(error)}`)
  }
  for (const snapshot of Object.values(file)) {
    if (!snapshot) continue
    // An old status file is display-only. It must not override a newer limit
    // returned by a live provider request.
    if (Date.now() - snapshot.fetchedAt > 10 * 60_000) continue
    const exhausted = snapshot.windows.find((window) => window.usedPercent >= 100 && (!window.resetsAt || window.resetsAt > Date.now()))
    if (snapshot.reachedType || exhausted) {
      setRateLimited(snapshot.provider, exhausted?.resetsAt, snapshot.reachedType || undefined, exhausted?.name)
    } else {
      clearRateLimited(snapshot.provider, snapshot.fetchedAt)
    }
  }
  saveFile(file)
  return readProviderQuotaSnapshots(cfg)
}
