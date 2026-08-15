import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// Reading the Claude subscription's OAuth access token so we can poll usage the
// same way we poll Codex: an active request, not a file someone else happens to
// write. We mirror Claude Code's own resolution order so a machine that can run
// `claude` can also read its quota, with no extra setup.
//
// We only ever READ the token. Refreshing it is Claude Code's job: refresh
// tokens rotate, so a refresh from here could race Claude Code's own refresh and
// invalidate the pair, logging the user out. Every `claude -p` stage we spawn
// refreshes the stored credential as a side effect, so a running daemon keeps
// the token live without our help. A 401 means "fall back", never "re-auth".

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

export interface StoredOAuth {
  accessToken?: string
  expiresAt?: number
  subscriptionType?: string
}

function fromCredentialsFile(path: string): StoredOAuth | null {
  try {
    if (!existsSync(path)) return null
    const oauth = JSON.parse(readFileSync(path, 'utf8'))?.claudeAiOauth as StoredOAuth | undefined
    return oauth?.accessToken ? oauth : null
  } catch {
    return null
  }
}

function fromKeychain(): StoredOAuth | null {
  if (platform() !== 'darwin') return null
  try {
    // The `security` CLI is the process macOS checks against the item's ACL.
    // Claude Code uses the same binary, so the user's existing "always allow"
    // decision covers us and no prompt appears.
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const oauth = JSON.parse(out)?.claudeAiOauth as StoredOAuth | undefined
    return oauth?.accessToken ? oauth : null
  } catch {
    return null
  }
}

/**
 * Resolve the stored Claude subscription credential, in Claude Code's own priority:
 *   1. CLAUDE_CODE_OAUTH_TOKEN (a long-lived token from `claude setup-token`)
 *   2. CLAUDE_CODE_HOST_CREDS_FILE, when the user points Claude Code elsewhere
 *   3. the macOS keychain item Claude Code writes
 *   4. ~/.claude/.credentials.json (Linux/Windows, where there is no keychain)
 * Returns null when nothing resolves — the caller falls back rather than fails.
 */
export function resolveClaudeOAuth(): StoredOAuth | null {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  // A token supplied by env carries no plan metadata, only the credential.
  if (env) return { accessToken: env }
  const hostCreds = process.env.CLAUDE_CODE_HOST_CREDS_FILE?.trim()
  if (hostCreds) {
    const fromHost = fromCredentialsFile(hostCreds)
    if (fromHost) return fromHost
  }
  return fromKeychain() || fromCredentialsFile(join(homedir(), '.claude', '.credentials.json'))
}
