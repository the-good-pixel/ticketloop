import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const script = fileURLToPath(new URL('./workflow-scenario.ts', import.meta.url))
const scenarios = ['question','data','bug','change','no-action','ineligible','verify-repair','review-repair',
  'ship-repair','ship-wait','deploy-wait','no-progress','pause-resume','ship-error-resume','codex','multi-repo','forbidden-path']
for (const scenario of scenarios) {
  const result = spawnSync(process.execPath, ['--import','tsx',script,scenario], { encoding:'utf8', timeout:30_000 })
  assert.equal(result.status,0,`${scenario}: ${result.stdout}\n${result.stderr}`)
  const line = result.stdout.split('\n').find(line => line.startsWith('SCENARIO_RESULT:'))
  assert.ok(line,scenario)
  const trace = JSON.parse(line.slice('SCENARIO_RESULT:'.length))
  const first = trace.turns[0]
  if (scenario === 'ship-wait') assert.equal(first.outcome,'waiting')
  if (scenario === 'deploy-wait') assert.equal(first.outcome,'waiting')
  if (scenario === 'pause-resume') assert.equal(first.outcome,'paused')
  if (scenario === 'ship-error-resume') assert.equal(first.outcome,'failed')
  if (scenario === 'codex') assert.ok(first.stages.filter((stage: { invocation: boolean }) => stage.invocation).every((stage: { provider: string }) => stage.provider === 'codex'))
  if (scenario === 'multi-repo') assert.equal(trace.turns[0].prs.filter((pr: { status: string }) => pr.status === 'opened').length,2)
}
console.log(`workflow scenarios: ${scenarios.length} routes, repairs, waits and recovery cases passed`)
