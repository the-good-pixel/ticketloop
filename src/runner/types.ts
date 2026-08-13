import type { AgentProvider, AuthMode, Config, McpServerConfig, ProviderFailure, StageConfig } from '../types.js'

export interface RunAgentOpts {
  prompt: string
  cwd: string
  stage: StageConfig
  runner: Config['runner']
  authMode: AuthMode
  mcp?: Record<string, McpServerConfig>
  mock?: boolean
  mockKind?: string
  env?: Record<string, string>
}

export interface AgentResult {
  text: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number
  provider: AgentProvider
  model: string
  isError: boolean
  failure?: ProviderFailure
  raw?: string
}
