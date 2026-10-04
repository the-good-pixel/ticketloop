import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { FunctionNode, Workflow, Runner, RequestInput, InMemorySessionService } from '@google/adk'

const findings: unknown[]=[]
async function runnerFor(graph: Workflow) {
  const sessions=new InMemorySessionService()
  await sessions.createSession({appName:'nodes',userId:'local',sessionId:'run'})
  return new Runner({appName:'nodes',agent:graph,sessionService:sessions,resumabilityConfig:{isResumable:true}})
}
async function consume(runner:Runner,message='start',abortSignal?:AbortSignal) {
  const events=[]
  for await (const event of runner.runAsync({userId:'local',sessionId:'run',newMessage:{role:'user',parts:[{text:message}]},abortSignal})) events.push(event)
  return events
}
const counts:Record<string,number>={replay:0,rerun:0,revalidate:0,idempotent:0}
const nodes=Object.keys(counts).map(name=>new FunctionNode(name,()=>{counts[name]++;return name},{rerunOnResume:name==='rerun'||name==='revalidate'}))
const pause=new FunctionNode('pause',async function*(){yield new RequestInput({message:'continue?'})})
const done=new FunctionNode('done',()=>true)
const policyRunner=await runnerFor(new Workflow({name:'policies',edges:[['START',...nodes,pause,done]]}))
await consume(policyRunner); await consume(policyRunner,'yes')
assert.deepEqual(counts,{replay:1,rerun:1,revalidate:1,idempotent:1})
findings.push({name:'resume policies',probePassed:true,compatible:false,counts,note:'Completed graph nodes were skipped even with rerunOnResume true. Ticketloop rerun/revalidate semantics require additional handling.'})
let attempts=0
const flaky=new FunctionNode('flaky',()=>{if(++attempts<3)throw new Error('transient');return 'ok'}, {retryConfig:{maxAttempts:3,initialDelay:0,jitter:0}})
await consume(await runnerFor(new Workflow({name:'retries',edges:[['START',flaky]]})))
assert.equal(attempts,3);findings.push({name:'transient retries',passed:true,attempts})
let downstream=0
const slow=new FunctionNode('slow',async ctx=>{await delay(500,undefined,{signal:ctx.abortSignal});return 'late'},{timeout:0.02})
const after=new FunctionNode('after',()=>{downstream++;return true})
let timedOut=false
try{const events=await consume(await runnerFor(new Workflow({name:'timeouts',edges:[['START',slow,after]]})));timedOut=events.some(e=>Boolean(e.errorCode))}
catch(error){timedOut=/timeout|timed out/i.test(String(error))}
assert.ok(timedOut);assert.equal(downstream,0);findings.push({name:'timeout prevents downstream execution',passed:true})

// Use disposable ordinary Node children; no coding-agent account or CLI is invoked.
const root=mkdtempSync(join(tmpdir(),'ticketloop-adk-children-'))
process.env.TICKETLOOP_HOME=root
const {registerChild,unregisterChild,killChildrenFor}=await import('../../src/runner/children.js')
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
try {
  for (const bridge of [false,true]) {
    const children: {pid:number;key:string;closed:Promise<unknown>}[]=[]
    let started!:()=>void
    const ready=new Promise<void>(resolve=>started=resolve)
    const launch=(ticketKey:string)=>{
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
      const pid=child.pid!
      const key=registerChild(pid,{ticketKey})
      const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})))
      children.push({pid,key,closed});return {pid,closed}
    }
    const peer=launch('evaluation:OTHER')
    let targetPid=0
    const running=new FunctionNode('running',async ctx=>{
      const target=launch('evaluation:TARGET');targetPid=target.pid
      if(bridge)ctx.abortSignal?.addEventListener('abort',()=>killChildrenFor('evaluation:TARGET'),{once:true})
      started();await target.closed;return 'completed'
    })
    const forbidden=new FunctionNode('forbidden',()=>{throw new Error('ran after cancellation')})
    const controller=new AbortController()
    const invocation=consume(await runnerFor(new Workflow({name:'cancel',edges:[['START',running,forbidden]]})),'start',controller.signal)
    try {
      await ready;controller.abort();await delay(100)
      const targetAlive=alive(targetPid),peerAlive=alive(peer.pid)
      assert.equal(targetAlive,!bridge);assert.equal(peerAlive,true)
      findings.push({name:bridge?'cancellation with Ticketloop process-group bridge':'cancellation without process-group bridge',passed:true,targetAlive,peerAlive})
    } finally {
      killChildrenFor('evaluation:TARGET','SIGKILL');killChildrenFor('evaluation:OTHER','SIGKILL')
      await Promise.all(children.map(async child=>{await child.closed;unregisterChild(child.pid,child.key)}))
      await invocation
    }
  }
} finally{rmSync(root,{recursive:true,force:true})}
console.log('NODE_PROBES_RESULT:'+JSON.stringify(findings))
