import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'ticketloop-support-smoke-'))
process.env.TICKETLOOP_HOME = join(root, 'home')
process.chdir(root)

try {
  const [{ loadConfig }, { setCredential }, { appendRun }, { supportBundleCmd }] = await Promise.all([
    import('../src/config.js'),
    import('../src/credentials.js'),
    import('../src/store.js'),
    import('../src/commands/support.js'),
  ])
  const { config } = loadConfig()
  const { buildCodexArgs } = await import('../src/runner/codex.js')
  const options = { prompt: 'Scoped posting test', cwd: root, stage: {}, runner: config.runner,
    authMode: 'subscription' as const, env: { LINEAR_API_KEY: 'private-key-canary', OPENAI_API_KEY: 'billing-key-canary' } }
  const scoped = buildCodexArgs(options)
  assert.ok(scoped.args.includes('shell_environment_policy.inherit="all"'))
  assert.ok(scoped.args.includes('shell_environment_policy.ignore_default_excludes=true'))
  const include = scoped.args.find(arg => arg.startsWith('shell_environment_policy.include_only='))!
  assert.ok(include.includes('LINEAR_API_KEY'))
  assert.ok(!include.includes('OPENAI_API_KEY'))
  assert.ok(!scoped.args.join(' ').includes('private-key-canary'))
  assert.ok(!scoped.args.join(' ').includes('billing-key-canary'))
  assert.ok(!buildCodexArgs({ ...options, env: undefined }).args.some(arg => arg.startsWith('shell_environment_policy.')))

  const privateName = 'private-project-canary'
  const privatePath = join(root, 'private-repository-canary')
  const privateTicket = 'SECRET-987'
  const privateTitle = 'Private customer failure details'
  const privateError = 'raw private stack and bearer-shaped diagnostic'
  mkdirSync(privatePath)
  config.projects = [{
    name: privateName,
    repoPath: privatePath,
    autonomy: 'propose',
    useWorktree: true,
    engine: 'workflow',
    workflow: `${privateName}@7`,
    tracker: { type: 'linear', team: 'PRIVATE', simpleLabel: 'private-label' },
    match: {},
    exclude: ['private/path/**'],
  }]
  const privateCredential = ['lin', 'api', 'private', 'canary'].join('_')
  setCredential(privateName, privateCredential)
  appendRun({
    id: 'private-run-id',
    ticket: privateTicket,
    ticketTitle: privateTitle,
    ticketUrl: 'https://linear.example/private-ticket',
    project: privateName,
    autonomy: 'propose',
    startedAt: Date.now() - 100,
    endedAt: Date.now(),
    outcome: 'failed',
    stages: [{ stage: 'triage', status: 'failed', startedAt: Date.now() - 100, endedAt: Date.now(), detail: privateError }],
    error: privateError,
    totalTokens: 0,
    costUsd: 0,
  })

  const output = join(root, 'support.json')
  supportBundleCmd(config, null, output)
  const text = readFileSync(output, 'utf8')
  const forbidden = [
    privateName,
    privatePath,
    privateTicket,
    privateTitle,
    privateError,
    privateCredential,
    'PRIVATE',
    'private-label',
    'private/path',
    'private-run-id',
  ]
  const leaked = forbidden.filter((value) => text.includes(value))
  if (leaked.length) throw new Error(`support bundle leaked ${leaked.length} private canaries`)
  const report = JSON.parse(text)
  if (!report.redaction?.safeToAttachPublicly) throw new Error('support bundle is missing its public-safe marker')
  if (report.config?.projects?.[0]?.alias !== 'project-1') throw new Error('project alias was not anonymized')
  if (report.recentRuns?.[0]?.errorKind !== 'other') throw new Error('raw error was not reduced to a category')
  console.log('support bundle smoke passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
