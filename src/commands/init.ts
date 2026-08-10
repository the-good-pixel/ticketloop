import { copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export function initCmd(): void {
  const dest = resolve(process.cwd(), 'ticketloop.config.yml')
  if (existsSync(dest)) {
    console.log(`ticketloop.config.yml already exists at ${dest} — leaving it alone.`)
    return
  }
  const example = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'ticketloop.config.example.yml',
  )
  copyFileSync(example, dest)
  console.log(`Created ${dest}`)
  console.log(`
Next steps:
  1. Edit ticketloop.config.yml — set your project repoPath, exclude paths,
     and tracker (start with tracker.type: mock to try it offline).
  2. export LINEAR_API_KEY=...   (when you switch tracker.type to linear)
  3. ticketloop doctor           # sanity-check auth + creds + tools
  4. ticketloop demo             # run the loop on built-in demo tickets
  5. ticketloop watch            # start the daemon + dashboard for real
`)
}
