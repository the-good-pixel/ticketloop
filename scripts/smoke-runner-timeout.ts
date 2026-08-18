import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'ticketloop-runner-timeout-'))
process.env.TICKETLOOP_HOME = home

const fixture = fileURLToPath(new URL('./fixtures/hanging-agent.mjs', import.meta.url))
chmodSync(fixture, 0o755)

const [{ DEFAULTS }, { runClaude }, { runCodex }] = await Promise.all([
  import('../src/config.js'),
  import('../src/runner/claude.js'),
  import('../src/runner/codex.js'),
])

try {
  for (const [provider, run] of [['claude', runClaude], ['codex', runCodex]] as const) {
    const runner = structuredClone(DEFAULTS.runner)
    runner.stageTimeoutSec = 0
    runner.stageIdleTimeoutSec = 0.08
    runner.providers[provider].bin = fixture
    const result = await run({
      prompt: 'hang',
      cwd: home,
      stage: { enabled: true, provider },
      runner,
      authMode: 'subscription',
      ticketKey: `smoke:${provider}`,
    })
    assert.equal(result.isError, true)
    assert.match(result.text, /produced no output/)
    assert.match(result.text, /saved checkpoint/)
  }
  console.log('runner idle timeout smoke passed')
} finally {
  rmSync(home, { recursive: true, force: true })
}
