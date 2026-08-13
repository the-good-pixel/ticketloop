import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

// State/data live under ~/.ticketloop; config is looked up in CWD then there.
export const DATA_DIR =
  process.env.TICKETLOOP_HOME || join(homedir(), '.ticketloop')

export const USAGE_LOG = join(DATA_DIR, 'usage.jsonl')
export const RUNS_LOG = join(DATA_DIR, 'runs.jsonl')
export const DAEMON_STATE = join(DATA_DIR, 'daemon.json')
// Per-ticket resume checkpoints (one file per in-flight ticket).
export const CHECKPOINTS_DIR = join(DATA_DIR, 'checkpoints')
// Cross-process pause switch: the `pause`/`resume` CLI commands (and the
// dashboard) write it; the running daemon reads it before each stage.
export const CONTROL_FILE = join(DATA_DIR, 'control.json')
// Provider-specific hold state, set only from provider status or a confirmed
// quota-exhausted response.
export const COOLDOWN_FILE = join(DATA_DIR, 'cooldown.json')
// User-owned step catalog + workflows (YAML). Built-ins live in the code and
// are never written here; this holds only what the user creates or imports.
export const CATALOG_DIR = join(DATA_DIR, 'catalog')
export const CATALOG_STEPS_DIR = join(CATALOG_DIR, 'steps')
export const CATALOG_WORKFLOWS_DIR = join(CATALOG_DIR, 'workflows')
export const CATALOG_IMPORTS_DIR = join(CATALOG_DIR, 'imports')
// Last percentages and reset times read directly from provider status APIs.
export const PROVIDER_QUOTA_FILE = join(DATA_DIR, 'provider-quota.json')

const CONFIG_NAMES = ['ticketloop.config.yml', 'ticketloop.config.yaml']

export function findConfigPath(explicit?: string): string | null {
  if (explicit) return resolve(explicit)
  for (const name of CONFIG_NAMES) {
    const p = resolve(process.cwd(), name)
    if (existsSyncSafe(p)) return p
  }
  const home = join(DATA_DIR, 'config.yml')
  if (existsSyncSafe(home)) return home
  return null
}

import { existsSync } from 'node:fs'
function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}
