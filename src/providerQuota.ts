import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { AgentProvider, Config, ProviderQuotaSnapshot, ProviderQuotaWindow } from './types.js'
import { PROVIDER_QUOTA_FILE } from './paths.js'
import { atomicWrite } from './store.js'
import { readRealUsage } from './realUsage.js'
import { resolveClaudeOAuth } from './providerAuth.js'
import { clearRateLimited, setRateLimited } from './governor/cooldown.js'
import { log } from './logger.js'

// Both providers are polled the SAME way: ask the provider, stamp the answer
// with the time we asked. Neither one is allowed to report a number whose
// freshness we cannot vouch for. Claude used to be the odd one out — it read
// whatever Claude Code's statusline hook last wrote to disk, so its `fetchedAt`
// was "when the user last had an interactive Claude Code window open", which
// could be hours stale while Codex sat at seconds. That file is now only a
// fallback, and it is labelled `local-cache` so it can never masquerade as live.

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

// Claude Code's own usage endpoint. It reports subscription utilization only —
// no inference happens, so polling it costs nothing against the quota it
// describes. Claude Code caches its own response for 5 minutes; we poll more
// eagerly than that (see QUOTA_MIN_INTERVAL_MS) because a dashboard people
// watch has to move, and the request is cheap.
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

// Percentages come back as 0-100 numbers under `utilization`, and reset times as
// ISO 8601 strings — NOT the epoch seconds the statusline payload uses.
function claudeWindow(bucket: any, name: string, windowDurationMins: number): ProviderQuotaWindow[] {
  if (!bucket || typeof bucket.utilization !== 'number') return []
  const resetsAt = bucket.resets_at ? Date.parse(bucket.resets_at) : NaN
  return [{
    name,
    usedPercent: bucket.utilization,
    windowDurationMins,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
  }]
}

function normalizeClaude(body: any, cfg: Config, plan?: string): ProviderQuotaSnapshot {
  const windows: ProviderQuotaWindow[] = [
    ...claudeWindow(body?.five_hour, '5-hour', 300),
    ...claudeWindow(body?.seven_day, 'weekly', 10080),
    // Model-scoped weekly caps exist on Max plans and are the limit a heavy
    // Opus user actually hits first, so surface them when the account has them.
    ...claudeWindow(body?.seven_day_opus, 'weekly (Opus)', 10080),
    ...claudeWindow(body?.seven_day_sonnet, 'weekly (Sonnet)', 10080),
  ]
  return {
    provider: 'claude',
    authMode: cfg.runner.providers.claude.authMode,
    plan,
    fetchedAt: Date.now(),
    windows,
    limitReached: windows.some((window) => window.usedPercent >= 100),
    source: 'provider-status',
  }
}

async function readClaudeRateLimits(cfg: Config): Promise<ProviderQuotaSnapshot> {
  const oauth = resolveClaudeOAuth()
  if (!oauth?.accessToken) throw new Error('no Claude OAuth token found (run `claude setup-token` or sign in to Claude Code)')
  const res = await fetch(CLAUDE_USAGE_URL, {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  // A 401 means the stored token is stale or scoped wrong. We do not refresh it
  // (see providerAuth.ts) — we fall back and let the next `claude -p` stage
  // refresh it for us.
  if (!res.ok) throw new Error(`Claude usage request failed: ${res.status}`)
  // The plan comes from the stored credential; the usage body does not carry it.
  return normalizeClaude(await res.json(), cfg, oauth.subscriptionType)
}

// Fallback only: whatever Claude Code's statusline hook last wrote to disk. Its
// `fetchedAt` is that file's mtime, which is why the source is labelled so the
// dashboard can say "cached" instead of implying we just asked.
function claudeCachedSnapshot(cfg: Config): ProviderQuotaSnapshot | null {
  const usage = readRealUsage()
  if (!usage) return null
  const all: ProviderQuotaWindow[] = []
  if (usage.fiveHour) all.push({ name: '5-hour', usedPercent: usage.fiveHour.pct, windowDurationMins: 300, resetsAt: usage.fiveHour.resetsAt })
  if (usage.sevenDay) all.push({ name: 'weekly', usedPercent: usage.sevenDay.pct, windowDurationMins: 10080, resetsAt: usage.sevenDay.resetsAt })
  // Past its own reset, a cached percentage is not stale — it is wrong. Dropping
  // the window is what stops a long-expired "weekly 100%" from pinning the card
  // at LIMIT hours after the quota actually came back.
  const windows = all.filter((window) => !window.resetsAt || window.resetsAt > Date.now())
  if (!windows.length) return null
  return {
    provider: 'claude',
    authMode: cfg.runner.providers.claude.authMode,
    fetchedAt: usage.asOf,
    windows,
    limitReached: windows.some((window) => window.usedPercent >= 100),
    source: 'local-cache',
  }
}

function windowName(duration?: number, fallback?: string): string {
  if (duration === 300) return '5-hour'
  if (duration === 10080) return 'weekly'
  if (duration) return `${duration}-minute`
  return fallback || 'usage'
}

// Codex reports several DISTINCT limits at once: a plan-wide one plus per-model
// ones (e.g. limitId `codex_bengalfox`, limitName "GPT-5.3-Codex-Spark"). They
// routinely share a window length, so naming a row by its duration alone
// produced two rows both labelled "weekly" with no way to tell them apart.
// Qualify by the limit's own identity, but only when there IS more than one —
// a single limit reads better as plain "weekly".
function limitLabel(bucket: any, rootLimitId?: string): string | undefined {
  if (bucket?.limitName) return String(bucket.limitName)
  // The plan-wide bucket has no name of its own; it is the one whose id matches
  // the top-level limit. Saying "all models" beats echoing the raw id.
  if (bucket?.limitId && bucket.limitId === rootLimitId) return 'all models'
  return bucket?.limitId ? String(bucket.limitId) : undefined
}

// Exported so a mock script can feed it recorded provider payloads — the shape
// of this response changes on OpenAI's schedule, not ours.
export function normalizeCodex(result: any, cfg: Config): ProviderQuotaSnapshot {
  const root = result?.rateLimits ?? result ?? {}
  const byLimitId = result?.rateLimitsByLimitId ?? root.rateLimitsByLimitId
  const buckets = byLimitId && typeof byLimitId === 'object' && Object.keys(byLimitId).length
    ? Object.entries(byLimitId)
        .map(([limitId, value]: [string, any]) => ({ limitId, ...value }))
        // Object key order is the provider's to change; sorting keeps the card's
        // rows from swapping places between polls. Plan-wide limit first — it is
        // the one that gates everything — then the per-model ones by name.
        .sort((a, b) =>
          (a.limitId === root.limitId ? 0 : 1) - (b.limitId === root.limitId ? 0 : 1) ||
          String(a.limitId).localeCompare(String(b.limitId)))
    : [root]
  const windows: ProviderQuotaWindow[] = []
  let reachedType: string | null = root.rateLimitReachedType ?? null
  let plan = root.planType
  for (const bucket of buckets as any[]) {
    plan ||= bucket.planType
    reachedType ||= bucket.rateLimitReachedType ?? null
    for (const [key, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]] as const) {
      if (!window || typeof window.usedPercent !== 'number') continue
      const base = windowName(window.windowDurationMins, bucket.limitName || bucket.limitId || key)
      const label = buckets.length > 1 ? limitLabel(bucket, root.limitId) : undefined
      windows.push({
        name: label ? `${base} · ${label}` : base,
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

// Both providers read from the same persisted file, so the dashboard and the
// governor always see the same numbers the last refresh actually obtained.
export function readProviderQuotaSnapshots(cfg: Config): ProviderQuotaSnapshot[] {
  const file = readFile()
  return (['claude', 'codex'] as AgentProvider[])
    .map((provider) => (file[provider]?.authMode === cfg.runner.providers[provider].authMode ? file[provider] : undefined) || {
      provider,
      authMode: cfg.runner.providers[provider].authMode,
      fetchedAt: 0,
      windows: [],
      limitReached: false,
      source: 'unpolled' as const,
    })
}

// One poller per provider, same contract: ask, or throw. Only subscription auth
// has a quota to report; API-key auth is billed per token and has no window.
const POLLERS: Record<AgentProvider, (cfg: Config) => Promise<ProviderQuotaSnapshot>> = {
  claude: readClaudeRateLimits,
  codex: readCodexRateLimits,
}

// When a live poll fails we keep showing the last thing we know rather than
// blanking the card, but we never upgrade its freshness — a stale snapshot keeps
// its original `fetchedAt`, so the age shown on the dashboard stays honest.
function fallbackSnapshot(provider: AgentProvider, cfg: Config, previous?: ProviderQuotaSnapshot): ProviderQuotaSnapshot | undefined {
  if (provider === 'claude') {
    const cached = claudeCachedSnapshot(cfg)
    if (cached && cached.fetchedAt >= (previous?.fetchedAt || 0)) return cached
  }
  return previous
}

export async function refreshProviderQuotaSnapshots(cfg: Config): Promise<ProviderQuotaSnapshot[]> {
  const file = readFile()
  await Promise.all((['claude', 'codex'] as AgentProvider[]).map(async (provider) => {
    if (cfg.runner.providers[provider].authMode !== 'subscription') {
      delete file[provider]
      return
    }
    try {
      file[provider] = await POLLERS[provider](cfg)
    } catch (error) {
      log.debug(`could not refresh ${provider} usage: ${String(error)}`)
      file[provider] = fallbackSnapshot(provider, cfg, file[provider])
    }
  }))
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
