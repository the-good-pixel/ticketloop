import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STARTER_CONFIG = `# Ticketloop starts with no projects and cannot process tickets yet.
# Run "ticketloop watch", then finish setup at http://127.0.0.1:4317/#setup.
version: 5

tracker:
  type: linear
  simpleLabel: ai-loop
  states: [Todo, Backlog]
  pollIntervalSec: 300

projects: []
`

export function initCmd(): void {
  const dest = resolve(process.cwd(), 'ticketloop.config.yml')
  if (existsSync(dest)) {
    console.log(`ticketloop.config.yml already exists at ${dest} — leaving it alone.`)
    return
  }
  writeFileSync(dest, STARTER_CONFIG)
  console.log(`Created ${dest}`)
  console.log(`
Next steps:
  1. ticketloop doctor   # check Claude/Codex, Git, and GitHub CLI
  2. ticketloop demo     # optional: safe offline demo, no quota or network
  3. ticketloop watch    # start the local dashboard
  4. Open http://127.0.0.1:4317/#setup and connect your first project.

The first project is saved PAUSED. Review it, then resume from Activity.
Advanced settings remain available in ticketloop.config.yml.
`)
}
