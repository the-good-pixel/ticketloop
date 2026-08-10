import { createInterface } from 'node:readline'
import type { Config } from '../types.js'
import { setCredential, hasCredential } from '../credentials.js'
import { resolveTracker } from '../config.js'
import { log } from '../logger.js'

/** Read a secret from the TTY without echoing it. */
function readSecret(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = process.stdout as any
    // Mute echo: intercept the readline output writer.
    const orig = out.write.bind(out)
    let muted = false
    ;(rl as any)._writeToOutput = (s: string) => {
      if (!muted) orig(s)
    }
    process.stdout.write(promptText)
    muted = true
    rl.question('', (answer) => {
      muted = false
      process.stdout.write('\n')
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * `ticketloop set-key <project> [key]` — store a project's tracker API key in
 * the daemon's credential file (~/.ticketloop/credentials.json, chmod 600).
 * With no key argument it prompts (hidden). Stored under the project name.
 */
export async function setKeyCmd(cfg: Config, projectName?: string, keyArg?: string): Promise<void> {
  if (!projectName) {
    console.log('Usage: ticketloop set-key <project> [key]')
    console.log('\nConfigured projects:')
    for (const p of cfg.projects) {
      const tc = resolveTracker(cfg, p)
      const stored = hasCredential(p.name) ? '✓ key stored' : 'no key stored'
      console.log(`  ${p.name}  (tracker: ${tc.type}, ${stored})`)
    }
    return
  }
  const project = cfg.projects.find((p) => p.name === projectName)
  if (!project) {
    log.error(`no project named "${projectName}" in config`)
    process.exit(1)
  }
  const key = keyArg || (await readSecret(`Paste the Linear API key for "${projectName}": `))
  if (!key) {
    log.error('empty key — nothing saved')
    process.exit(1)
  }
  setCredential(projectName, key)
  console.log(`Saved key for "${projectName}" to the daemon credential store (chmod 600).`)
  console.log('It will be used automatically — no env var needed.')
}
