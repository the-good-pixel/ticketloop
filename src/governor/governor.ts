import type { AgentProvider, Config, ProviderQuotaSnapshot } from '../types.js'
import { readProviderQuotaSnapshots } from '../providerQuota.js'
import { activeProviderLimit } from './cooldown.js'

export class Governor {
  constructor(private cfg: Config, private ignoreLimits = false) {}

  summary(): ProviderQuotaSnapshot[] {
    return readProviderQuotaSnapshots(this.cfg)
  }

  canRun(provider: AgentProvider = this.cfg.runner.defaultProvider, now = Date.now()): {
    ok: boolean
    reason?: string
    resetAt?: number
  } {
    if (this.ignoreLimits) return { ok: true }
    const knownLimit = activeProviderLimit(provider, now)
    if (knownLimit) {
      return {
        ok: false,
        reason: knownLimit.message || `${provider} usage limit reached`,
        resetAt: knownLimit.retryAt || knownLimit.nextProbeAt,
      }
    }
    const snapshot = this.summary().find((item) => item.provider === provider)
    if (!snapshot) return { ok: true }
    const exhausted = snapshot.windows.find((window) => window.usedPercent >= 100 && (!window.resetsAt || window.resetsAt > now))
    if (exhausted || (snapshot.limitReached && !!snapshot.reachedType)) {
      return {
        ok: false,
        reason: snapshot.reachedType || `${provider} ${exhausted?.name || 'usage'} limit reached`,
        resetAt: exhausted?.resetsAt,
      }
    }
    return { ok: true }
  }
}
