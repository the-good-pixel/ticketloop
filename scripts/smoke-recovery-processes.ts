import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const worker = fileURLToPath(new URL('./recovery-worker.ts', import.meta.url))
for (const [mode, effect] of [['crash-before', 'tracker-comment'], ['crash-after', 'tracker-comment'], ['complete', 'tracker-comment'], ['crash-after', 'create-pr']]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ticketloop-process-recovery-')))
  try {
    const run = (stage: string) => spawnSync(process.execPath, ['--import', 'tsx', worker, root, stage, effect], { encoding: 'utf8', timeout: 10_000 })
    const first = run(mode)
    if (mode.startsWith('crash')) assert.equal(first.signal, 'SIGKILL', first.stderr)
    else assert.equal(first.status, 0, first.stderr)
    for (let i = 0; i < 2; i++) {
      const resumed = run('resume')
      assert.equal(resumed.status, 0, resumed.stderr)
      const result = JSON.parse(resumed.stdout.trim())
      assert.equal(result.calls, mode === 'crash-before' ? 0 : 1)
      assert.equal(mode === 'crash-before' ? result.waiting : effect === 'create-pr' ? result.checksRequired : result.recovered, true)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
console.log('process recovery smoke: durable intents survive hard crashes without duplicate actions')
