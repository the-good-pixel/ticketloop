import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig, TrackerConfig } from './types.js'
import { DATA_DIR } from './paths.js'

// Daemon-level secret store: ~/.ticketloop/credentials.json (chmod 600).
// Keys are stored here so users don't have to juggle env vars per workspace.
// This is a plaintext file readable only by the user — fine for a local tool;
// env vars remain a fallback for CI/headless setups.
const CRED_FILE = join(DATA_DIR, 'credentials.json')

type CredMap = Record<string, string>

function read(): CredMap {
  if (!existsSync(CRED_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8')) as CredMap
  } catch {
    return {}
  }
}

export function setCredential(ref: string, value: string): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const map = read()
  map[ref] = value
  writeFileSync(CRED_FILE, JSON.stringify(map, null, 2))
  try {
    chmodSync(CRED_FILE, 0o600)
  } catch {
    /* best effort on non-POSIX */
  }
}

export function getCredential(ref: string): string | null {
  return read()[ref] ?? null
}

export function hasCredential(ref: string): boolean {
  return getCredential(ref) != null
}

/**
 * Resolve a project's tracker API key. Priority:
 *   1. stored credential under the project name
 *   2. stored credential under an explicit keyRef
 *   3. env var named by tracker.apiKeyEnv (fallback for CI/headless)
 */
export function resolveTrackerKey(project: ProjectConfig, tc: TrackerConfig): string {
  return (
    getCredential(project.name) ||
    (tc.keyRef ? getCredential(tc.keyRef) : null) ||
    (tc.apiKeyEnv ? process.env[tc.apiKeyEnv] : null) ||
    ''
  )
}
