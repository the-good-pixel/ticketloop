import type { WaitKind } from './types.js'

// Read compatibility for runs and daemon state written before `waiting` became
// one outcome with a structured blocker. New writes never use these strings.
export const LEGACY_WAIT_KINDS: Readonly<Record<string, WaitKind>> = {
  'waiting-provider': 'provider',
  'waiting-approval': 'approval',
  'waiting-deployment': 'deployment',
  'waiting-external': 'external',
}

export function legacyWaitKind(outcome: string): WaitKind | undefined {
  return LEGACY_WAIT_KINDS[outcome]
}
