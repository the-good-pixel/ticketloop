import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ticketloop-scheduler-')))
process.env.TICKETLOOP_HOME = root
process.env.TICKETLOOP_MOCK_DELAY_MS = '15'
process.chdir(root)
try {
  const { loadConfig } = await import('../src/config.js')
  const { watch } = await import('../src/daemon/watch.js')
  const { setTicketIgnored, requestCancel } = await import('../src/daemon/control.js')
  const { readRuns, readJson } = await import('../src/store.js')
  const { DAEMON_STATE } = await import('../src/paths.js')
  const { loadCheckpoint } = await import('../src/loop/checkpoint.js')
  const { registerChild, unregisterChild, killChildrenFor } = await import('../src/runner/children.js')
  const { config } = loadConfig()
  const project = { name: 'scheduler', repoPath: root, match: {}, exclude: [], autonomy: 'propose' as const, maxParallel: 2 }
  config.projects = [project]
  setTicketIgnored('scheduler:DEMO-104', true) // no data filesystem fixture needed
  setTicketIgnored('scheduler:DEMO-103', true)
  const timer = setInterval(() => {
    const running = readRuns().find(r => r.ticket === 'DEMO-102' && r.outcome === 'running')
    if (running) requestCancel('scheduler:DEMO-102')
  }, 2)
  try { await watch(config, { mock: true, once: true }) } finally { clearInterval(timer) }
  const runs = readRuns()
  assert.equal(runs.filter(r => r.ticket === 'DEMO-102').length, 1)
  assert.equal(runs.find(r => r.ticket === 'DEMO-102')!.outcome, 'cancelled')
  assert.equal(loadCheckpoint('scheduler:DEMO-102'), null)
  assert.ok(!runs.some(r => r.ticket === 'DEMO-103' || r.ticket === 'DEMO-104'))
  const question = runs.find(r => r.ticket === 'DEMO-101')!
  const stopped = runs.find(r => r.ticket === 'DEMO-102')!
  assert.ok(Math.max(question.startedAt, stopped.startedAt) < Math.min(question.endedAt!, stopped.endedAt!), 'two configured slots should overlap')
  const state = readJson<{ tickets: Record<string, { lastOutcome: string }> }>(DAEMON_STATE)!
  assert.equal(state.tickets['scheduler:DEMO-102'].lastOutcome, 'cancelled')
  await watch(config, { mock: true, once: true })
  assert.equal(readRuns().length, runs.length, 'cancelled and ignored tickets must not retry')

  const children: { child: ReturnType<typeof spawn>; key: string }[] = []
  try {
    for (const key of ['target:TICKET', 'other:TICKET']) {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
      await once(child, 'spawn')
      children.push({ child, key: registerChild(child.pid!, { ticketKey: key }) })
    }
    const exit = once(children[0].child, 'exit')
    assert.equal(killChildrenFor('target:TICKET'), 1)
    await exit
    process.kill(children[1].child.pid!, 0)
  } finally {
    for (const { child, key } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        process.kill(-child.pid!, 'SIGKILL')
        await exit
      }
      unregisterChild(child.pid!, key)
    }
  }
  console.log('scheduler smoke: configured concurrency, stop/checkpoint/no-retry, ignore and targeted child termination passed')
} finally { rmSync(root, { recursive: true, force: true }) }
