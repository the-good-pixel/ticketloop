import type { AgentProvider, Config } from '../types.js'
import { STAGE_ORDER } from '../types.js'
import { resolveStage } from '../config.js'
import { runClaude } from './claude.js'
import { runCodex } from './codex.js'
import type { AgentResult, RunAgentOpts } from './types.js'

export type { AgentResult, RunAgentOpts } from './types.js'

export function selectedProvider(o: Pick<RunAgentOpts, 'stage' | 'runner'>): AgentProvider {
  return o.stage.provider || o.runner.defaultProvider
}

export function runAgent(o: RunAgentOpts): Promise<AgentResult> {
  const provider = selectedProvider(o)
  const authMode = o.runner.providers[provider].authMode
  const opts = { ...o, authMode }
  return provider === 'codex' ? runCodex(opts) : runClaude(opts)
}

export function assertAuthSafe(cfg: Config): { warnings: string[] } {
  const warnings: string[] = []
  const enabled = new Set<AgentProvider>([cfg.runner.defaultProvider])
  for (const stage of STAGE_ORDER) enabled.add(resolveStage(cfg, stage).provider!)
  for (const p of cfg.projects) for (const stage of STAGE_ORDER) enabled.add(resolveStage(cfg, stage, p.stages).provider!)
  if (enabled.has('claude') && cfg.runner.providers.claude.authMode === 'subscription' && process.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY is set while Claude uses subscription auth. ticketloop unsets it for Claude stages.')
  }
  if (
    enabled.has('codex') &&
    cfg.runner.providers.codex.authMode === 'subscription' &&
    (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)
  ) {
    warnings.push('OPENAI_API_KEY or CODEX_API_KEY is set while Codex uses subscription auth. ticketloop unsets both for Codex stages.')
  }
  return { warnings }
}
