import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ticketloop-dashboard-')))
process.env.TICKETLOOP_HOME = root
process.chdir(root)
let server: { close: () => void } | undefined
try {
  const { loadConfig } = await import('../src/config.js')
  const { startServer } = await import('../src/daemon/server.js')
  const { appendRun } = await import('../src/store.js')
  const { config } = loadConfig()
  config.projects = [{ name: 'dashboard', repoPath: root, autonomy: 'propose', match: {}, exclude: [] }]
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  config.server.port = address.port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  server = startServer(config, {
    status: () => ({ running: false }), scanNow: async () => ({ processed: 0 }),
    saveProject: project => { config.projects = [project]; return { ok: true } },
    removeProject: () => ({ ok: true }), setKey: () => ({ ok: true }), saveSettings: () => ({ ok: true }),
    retryTicket: () => ({ ok: true }), stopTicket: () => ({ stopped: false, killed: 0, ignored: false }),
  })
  const base = `http://127.0.0.1:${config.server.port}`
  const get = async (path: string) => {
    const response = await fetch(base + path)
    assert.equal(response.status, 200)
    return response.json() as Promise<any>
  }
  const catalog = await get('/api/catalog')
  assert.equal(catalog.projects[0].engine, 'workflow')
  assert.equal(catalog.projects[0].workflow, 'standard@3')
  const assignment = await fetch(base + '/api/catalog/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'dashboard', ref: 'standard@2' }) })
  const assigned = await assignment.json() as { ok: boolean; engine: string; warning?: string }
  assert.equal(assigned.ok, true)
  assert.equal(assigned.engine, 'workflow')
  assert.equal(assigned.warning, undefined)
  for (const [id, outcome] of [['old-record', 'answered'], ['review-record', 'waiting']] as const)
    appendRun({ id, ticket: 'DEMO', ticketTitle: 'Test', ticketUrl: 'https://example.invalid/DEMO', project: 'dashboard',
      autonomy: 'propose', outcome, startedAt: Date.now(), totalTokens: 0, costUsd: 0, stages: [] })
  const history = await get('/api/history?outcome=waiting')
  assert.equal(history.total, 1)
  assert.equal(history.runs[0].id, 'review-record')
  assert.equal((await get('/api/activity/old-record')).outcome, 'answered')
  assert.ok((await get('/api/history/facets')).outcomes.includes('waiting'))
  console.log('dashboard API smoke: workflow default, assignment, recovery filters and old run history passed')
} finally {
  server?.close()
  rmSync(root, { recursive: true, force: true })
}
