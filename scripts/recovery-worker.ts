// Disposable process used by smoke-recovery-processes; never invokes a provider.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [home, mode, effect] = process.argv.slice(2)
process.env.TICKETLOOP_HOME = home
process.chdir(home)
const { prepareOperations, completeOperations } = await import('../src/loop/operations.js')
const remoteFile = join(home, 'fake-remote.json')
const remote = existsSync(remoteFile) ? JSON.parse(readFileSync(remoteFile, 'utf8')) as { calls: number; url: string } : { calls: 0, url: '' }
const input = { runId: 'durable-run', ticketKey: 'project:TICKET', ticketId: 'ticket-id', nodeKey: 'effect', effects: [effect],
  cwd: home, branch: effect === 'create-pr' ? 'ticketloop/ticket' : undefined }
const prepared = await prepareOperations(input, async () => remote.calls ? { state: 'found', url: remote.url } : { state: 'absent' })
if ('wait' in prepared) {
  console.log(JSON.stringify({ waiting: true, calls: remote.calls }))
} else if (prepared.recoveredOutput) {
  completeOperations(prepared.operations, prepared.recoveredOutput)
  console.log(JSON.stringify({ recovered: true, calls: remote.calls }))
} else if (mode === 'resume' && effect === 'create-pr') {
  if (!prepared.prompt.includes('Do not create another PR')) throw new Error('recovered PR must forbid creation')
  console.log(JSON.stringify({ checksRequired: true, calls: remote.calls }))
} else {
  if (mode === 'crash-before') process.kill(process.pid, 'SIGKILL')
  remote.calls++
  remote.url = effect === 'create-pr' ? 'https://github.com/demo/repo/pull/1' : 'https://linear.app/demo/issue/TICKET#comment-one'
  writeFileSync(remoteFile, JSON.stringify(remote))
  if (mode === 'crash-after') process.kill(process.pid, 'SIGKILL')
  completeOperations(prepared.operations, effect === 'create-pr' ? `${remote.url}\nVERDICT: wait — CI pending` : `COMMENT_URL: ${remote.url}`)
  console.log(JSON.stringify({ completed: true, calls: remote.calls }))
}
