import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

// State/data live under ~/.ticketloop; config is looked up in CWD then there.
export const DATA_DIR =
  process.env.TICKETLOOP_HOME || join(homedir(), '.ticketloop')

export const USAGE_LOG = join(DATA_DIR, 'usage.jsonl')
export const RUNS_LOG = join(DATA_DIR, 'runs.jsonl')
export const DAEMON_STATE = join(DATA_DIR, 'daemon.json')

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
