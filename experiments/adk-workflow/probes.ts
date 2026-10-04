import assert from 'node:assert/strict'
import { FunctionNode, Workflow, Runner, RequestInput, InMemorySessionService } from '@google/adk'

export async function humanInputProbe() {
  const calls: string[] = []
  const prepare = new FunctionNode('prepare', () => { calls.push('prepare'); return 'prepared' })
  const approval = new FunctionNode('approval', async function* () {
    calls.push('approval'); yield new RequestInput({ message: 'continue?', interruptId: 'approval-id' })
  })
  const finish = new FunctionNode('finish', (_ctx, input) => { calls.push('finish'); return input })
  const workflow = new Workflow({name: 'probe', edges: [['START', prepare, approval, finish]]})
  const store = new InMemorySessionService()
  await store.createSession({appName: 'probe', userId: 'local', sessionId: 'test'})
  const runner = new Runner({appName: 'probe', agent: workflow, sessionService: store, resumabilityConfig: {isResumable: true}})
  const turns = []
  for (const message of ['start', 'approved']) {
    const events = []
    for await (const e of runner.runAsync({userId:'local', sessionId:'test', newMessage: {role:'user', parts:[{text:message}]}}))
      events.push({invocationId:e.invocationId, author:e.author, output:e.output, nodeInfo:e.nodeInfo})
    turns.push({message, calls:[...calls], events})
  }
  assert.deepEqual(calls, ['prepare','approval','finish'])
  return {name:'human input resumes without repeating completed nodes',passed:true,turns}
}
