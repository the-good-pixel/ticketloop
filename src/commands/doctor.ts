import { spawnSync } from 'node:child_process'
import type { Config } from '../types.js'
import { resolveTracker } from '../config.js'
import { hasCredential, resolveTrackerKey } from '../credentials.js'

function has(bin: string, args: string[] = ['--version']): string | null {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  if ((r.status ?? 1) !== 0) return null
  return (r.stdout || r.stderr || '').trim().split('\n')[0]
}

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`)
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)

export function doctorCmd(cfg: Config, configPath: string | null): void {
  console.log('ticketloop doctor\n')

  console.log('Config')
  if (configPath) ok(`loaded ${configPath}`)
  else warn('no config file found — using defaults (mock tracker). Run `ticketloop init`.')

  console.log('\nTooling')
  const claude = has(cfg.runner.claudeBin)
  claude ? ok(`claude CLI: ${claude}`) : bad(`claude CLI ("${cfg.runner.claudeBin}") not found on PATH`)
  const gh = has('gh', ['--version'])
  gh ? ok(`gh CLI: ${gh}`) : warn('gh CLI not found — PRs cannot be opened (fine for clarify-only)')
  const git = has('git', ['--version'])
  git ? ok(`git: ${git}`) : bad('git not found')

  console.log('\nAuth / billing')
  ok(`auth.mode = ${cfg.auth.mode}`)
  if (cfg.auth.mode === 'subscription') {
    if (process.env.ANTHROPIC_API_KEY) {
      warn(
        'ANTHROPIC_API_KEY is set. In subscription mode ticketloop unsets it for ' +
          'the claude child so you are NOT billed the metered API — but consider ' +
          'unsetting it in your shell to avoid surprises elsewhere.',
      )
    } else {
      ok('ANTHROPIC_API_KEY not set — good; claude will use your subscription login')
    }
  } else {
    process.env.ANTHROPIC_API_KEY
      ? ok('ANTHROPIC_API_KEY is set (api mode)')
      : bad('auth.mode=api but ANTHROPIC_API_KEY is not set')
  }

  console.log('\nProjects (each with its own tracker + workspace key)')
  if (!cfg.projects.length) warn('no projects configured')
  for (const p of cfg.projects) {
    const tc = resolveTracker(cfg, p)
    const exists = has('test', ['-d', p.repoPath]) !== null
    exists
      ? ok(`${p.name} → ${p.repoPath} (${p.autonomy})`)
      : bad(`${p.name}: repoPath not found: ${p.repoPath}`)
    if (tc.type === 'linear') {
      const src = hasCredential(p.name)
        ? 'stored in daemon'
        : process.env[tc.apiKeyEnv]
          ? `env ${tc.apiKeyEnv}`
          : null
      const meta = `label "${tc.simpleLabel}"${tc.team ? ` · team ${tc.team}` : ''}`
      resolveTrackerKey(p, tc)
        ? ok(`   tracker: linear · key ${src} · ${meta}`)
        : bad(`   tracker: linear · NO key — run \`ticketloop set-key ${p.name}\` · ${meta}`)
    } else {
      warn(`   tracker: mock (demo tickets, no creds)`)
    }
  }
  console.log('')
}
