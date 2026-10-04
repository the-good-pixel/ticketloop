import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { FunctionNode, Workflow, Runner, RequestInput } from '@google/adk'
import { DatabaseSessionService } from '@google/adk/sessions/database'

const [root,mode,turn] = process.argv.slice(2)
const journal = join(root,'actions.jsonl')
const log = (action:string) => appendFileSync(journal,JSON.stringify({action,turn})+'\n')
const prepare = new FunctionNode('prepare', () => {log('prepare');return 'prepared'})
const action = new FunctionNode('action', async function* () {
  if (mode==='crash' && turn==='first') {
    log('blocked-before-action')
    await new Promise(() => {})
  }
  if (['side-effect','reconcile'].includes(mode) && turn==='first') {
    // Isolate a crash AFTER preparation is durably committed, BEFORE action completion.
    while (!existsSync(join(root,'prepare-committed'))) await delay(5)
  }
  if (mode === 'pause') {
    log('approval');yield new RequestInput({message:'continue?',interruptId:'approval'})
  } else if (mode === 'error' && turn === 'first') {
    log('error');throw new Error('injected transient failure')
  } else {
    const key=join(root,'remote-result.json')
    if (mode === 'reconcile' && existsSync(key)) {
      log('reconciled');yield JSON.parse(readFileSync(key,'utf8'));return
    }
    log('remote-action')
    writeFileSync(key,JSON.stringify({url:'https://example.invalid/pr/1'}))
    if ((mode==='side-effect' || mode==='reconcile') && turn==='first') process.kill(process.pid,'SIGKILL')
    yield {url:'https://example.invalid/pr/1'}
  }
})
const finish = new FunctionNode('finish', (_ctx,input) => {log('finish');return input})
const workflow = new Workflow({name:'recovery',edges:[['START',prepare,action,finish]]})
const sessions = new DatabaseSessionService(`sqlite://${join(root,'sessions.sqlite')}`)
await sessions.init()
if (turn==='first') await sessions.createSession({appName:'recovery',userId:'local',sessionId:'run'})
const runner = new Runner({appName:'recovery',agent:workflow,sessionService:sessions,resumabilityConfig:{isResumable:true}})
for await (const event of runner.runAsync({userId:'local',sessionId:'run',newMessage:{role:'user',parts:[{text:turn==='first'?'start':'approved'}]}})) {
  appendFileSync(join(root,'events.jsonl'),JSON.stringify({turn,event})+'\n')
  if (event.author==='prepare' && event.output==='prepared') writeFileSync(join(root,'prepare-committed'),'yes')
  // Runner persisted the event before yielding it to the caller.
  if (mode==='crash' && turn==='first' && event.author==='prepare' && event.output==='prepared') process.kill(process.pid,'SIGKILL')
}
console.log('RECOVERY_RESULT:'+JSON.stringify({mode,turn,actions:existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[]}))
process.exit(0)
