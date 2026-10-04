import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ticketloop-lookups-')))
process.env.TICKETLOOP_HOME = root
process.chdir(root)
const originalFetch = globalThis.fetch
const originalPath = process.env.PATH
try {
  const { lookupOperation, marker } = await import('../src/loop/operations.js')
  const op = { schema: 1 as const, id: 'operation', runId: 'run', ticketKey: 'project:TICKET', ticketId: 'uuid-ticket',
    nodeKey: 'report', effect: 'tracker-comment', cwd: root, status: 'pending' as const }
  let pages = 0
  const comment = { body: marker(op), url: 'https://linear.app/demo/issue/TICKET#comment-one', user: { id: 'viewer' } }
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options!.body as string)
    assert.ok(!request.query.includes('mutation'), 'reconciliation is read only')
    assert.equal((options!.headers as Record<string, string>).Authorization, 'fake-project-key')
    assert.equal(request.variables.id, 'uuid-ticket')
    pages++
    assert.equal(request.variables.after, pages === 1 ? null : 'page-one')
    return Response.json({ data: { viewer: { id: 'viewer' }, issue: { id: 'uuid-ticket', comments: {
      nodes: pages === 1 ? [] : [comment], pageInfo: { hasNextPage: pages === 1, endCursor: pages === 1 ? 'page-one' : null },
    } } } })
  }
  assert.deepEqual(await lookupOperation(op, 'fake-project-key'), { state: 'found', url: comment.url })
  assert.equal(pages, 2)
  for (const [nodes, expected] of [[[{ ...comment, user: { id: 'other-author' } }], 'absent'], [[comment, comment], 'unknown'], [[], 'absent']] as const) {
    globalThis.fetch = async () => Response.json({ data: { viewer: { id: 'viewer' }, issue: { id: 'uuid-ticket', comments: {
      nodes, pageInfo: { hasNextPage: false, endCursor: null },
    } } } })
    assert.equal((await lookupOperation(op, 'fake-project-key')).state, expected)
  }
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.equal((await lookupOperation(op, 'fake-project-key')).state, 'unknown')
  assert.equal((await lookupOperation(op)).state, 'unknown')
  process.env.PATH = `${root}:${originalPath}`
  const pr = { ...op, effect: 'create-pr', branch: 'ticketloop/ticket', base: 'origin/main' }
  const gh = join(root, 'gh')
  const rows = [{ url: 'https://github.com/demo/repo/pull/1', headRefName: pr.branch, baseRefName: 'main', body: '' }]
  writeFileSync(gh, `#!${process.execPath}\nif(process.argv.includes('create')) process.exit(1); console.log(${JSON.stringify(JSON.stringify(rows))});\n`, { mode: 0o755 })
  assert.deepEqual(await lookupOperation(pr), { state: 'found', url: rows[0].url })
  writeFileSync(gh, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify([...rows, ...rows]))});\n`, { mode: 0o755 })
  assert.equal((await lookupOperation(pr)).state, 'unknown')
  writeFileSync(gh, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 })
  assert.equal((await lookupOperation(pr)).state, 'unknown')
  console.log('operation lookup smoke: project credentials, issue/author scope, pagination, ambiguity and read-only failure handling passed')
} finally {
  globalThis.fetch = originalFetch
  process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}
