/** Optional upgrade check: pass the baseline repository's absolute src directory. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const baseline = process.argv[2]
if (!baseline) throw new Error('usage: tsx scripts/compare-workflow-traces.ts /absolute/baseline/src')
const current = fileURLToPath(new URL('../src/', import.meta.url))
const script = fileURLToPath(new URL('./workflow-scenario.ts', import.meta.url))
const repo = fileURLToPath(new URL('../', import.meta.url))
const scenarios = ['question','data','bug','change','no-action','ineligible','verify-repair','review-repair',
  'ship-repair','ship-wait','deploy-wait','no-progress','pause-resume','ship-error-resume','codex','multi-repo','forbidden-path']
for (const scenario of scenarios) {
  const traces = [resolve(baseline) + '/', current].map(source => {
    const result = spawnSync(process.execPath, ['--import','tsx',script,scenario], { cwd:repo,
      env: { ...process.env, TICKETLOOP_SCENARIO_SOURCE:source }, encoding:'utf8', timeout:30_000 })
    assert.equal(result.status,0,`${scenario}: ${result.stdout}\n${result.stderr}`)
    const line = result.stdout.split('\n').find(line => line.startsWith('SCENARIO_RESULT:'))
    assert.ok(line,scenario)
    const trace = JSON.parse(line.slice('SCENARIO_RESULT:'.length))
    // The new compiler records the effective provider explicitly. Check provider
    // selection separately; compare all other fields in the retained trace.
    for (const turn of trace.turns) for (const stage of turn.stages) delete stage.provider
    return trace.turns
  })
  assert.deepEqual(traces[1],traces[0],scenario)
}
console.log(JSON.stringify({ workflow:'standard@2', matching:scenarios,
  comparison:'order,status,replay,verdict,detail,artifacts,PRs,comments,outcomes',
  provider:'explicit metadata excluded; separate Codex selection check' },null,2))
