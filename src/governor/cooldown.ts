import { existsSync, readFileSync } from 'node:fs'
import { COOLDOWN_FILE } from '../paths.js'
import { atomicWrite, removeFile } from '../store.js'
import type { AgentProvider } from '../types.js'

const UNKNOWN_LIMIT_PROBE_MS = 15 * 60_000

export interface ProviderLimitState {
  detectedAt: number
  retryAt?: number
  nextProbeAt: number
  message?: string
  scope?: string
}

interface LimitFile {
  version: 2
  providers: Partial<Record<AgentProvider, ProviderLimitState>>
}

function read(): LimitFile {
  try {
    if (!existsSync(COOLDOWN_FILE)) return { version: 2, providers: {} }
    const raw = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')) as any
    if (raw.version === 2 && raw.providers) return raw
    // Version 1 stored provider reset timestamps directly.
    const providers: LimitFile['providers'] = {}
    for (const provider of ['claude', 'codex'] as AgentProvider[]) {
      const retryAt = Number(raw[provider] || (provider === 'claude' ? raw.until : 0))
      if (retryAt > Date.now()) providers[provider] = { detectedAt: Date.now(), retryAt, nextProbeAt: retryAt }
    }
    return { version: 2, providers }
  } catch {
    return { version: 2, providers: {} }
  }
}

function write(file: LimitFile): void {
  if (Object.keys(file.providers).length) atomicWrite(COOLDOWN_FILE, JSON.stringify(file))
  else if (existsSync(COOLDOWN_FILE)) removeFile(COOLDOWN_FILE)
}

/** A confirmed provider limit that should still hold work, or null when a probe is due. */
export function activeProviderLimit(provider: AgentProvider, now = Date.now()): ProviderLimitState | null {
  const state = read().providers[provider]
  if (!state) return null
  if (state.retryAt && state.retryAt <= now) return null
  if (!state.retryAt && state.nextProbeAt <= now) return null
  return state
}

/** Record only provider-reported reset data. nextProbeAt is a retry timer, not a made-up reset. */
export function setRateLimited(
  provider: AgentProvider,
  resetAt?: number,
  message?: string,
  scope?: string,
  now = Date.now(),
): ProviderLimitState {
  const file = read()
  const retryAt = resetAt && resetAt > now ? resetAt : undefined
  const state: ProviderLimitState = {
    detectedAt: now,
    retryAt,
    nextProbeAt: retryAt || now + UNKNOWN_LIMIT_PROBE_MS,
    message,
    scope,
  }
  file.providers[provider] = state
  write(file)
  return state
}

/** Clear a limit after an authoritative status refresh or a newer successful request. */
export function clearRateLimited(provider: AgentProvider, requestStartedAt?: number): void {
  const file = read()
  const state = file.providers[provider]
  if (!state) {
    write(file)
    return
  }
  if (requestStartedAt !== undefined && requestStartedAt < state.detectedAt) return
  delete file.providers[provider]
  write(file)
}
