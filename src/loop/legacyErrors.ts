import type { AgentProvider, StageName } from '../types.js'

// Thrown by a stage when a pause was requested at its boundary. It carries the
// run up to the outer handler, which marks the run 'paused' (not failed), keeps
// the worktree + checkpoint, and returns — a later `resume` continues from here.
export class PausedError extends Error {
  constructor(public stage: StageName) {
    super(`paused before "${stage}"`)
    this.name = 'PausedError'
  }
}

export class ProviderUnavailableError extends Error {
  constructor(
    public provider: AgentProvider,
    public stage: StageName,
    public resumeAt?: number,
  ) {
    super(`${provider} usage limit reached before "${stage}"`)
    this.name = 'ProviderUnavailableError'
  }
}

