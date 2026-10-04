import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory=fileURLToPath(new URL('.',import.meta.url))
async function turn(root:string,mode:string,which:string) {
  return new Promise<{code:number|null;signal:string|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',`${directory}recovery-worker.ts`,root,mode,which],{cwd:directory})
    let stdout='',stderr=''
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s)
    child.on('error',reject)
    const deadline=setTimeout(()=>child.kill('SIGKILL'),30000)
    child.on('close',(code,signal)=>{clearTimeout(deadline);resolve({code,signal,stdout,stderr})})
  })
}
export async function recoveryProbes() {
  const results=[]
  for (const mode of ['pause','crash','error','side-effect','reconcile']) {
    const root=realpathSync(mkdtempSync(join(tmpdir(),'ticketloop-adk-recovery-')))
    try {
      const first=await turn(root,mode,'first')
      const second=await turn(root,mode,'second')
      assert.equal(second.code,0,second.stderr)
      if (['crash','side-effect','reconcile'].includes(mode)) assert.equal(first.signal,'SIGKILL',first.stderr)
      else if (mode==='error') { assert.equal(first.code,1); assert.match(first.stderr,/injected transient failure/) }
      else assert.equal(first.code,0,first.stderr)
      const actions=readFileSync(join(root,'actions.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
      const count=(name:string)=>actions.filter(a=>a.action===name).length
      const prepared=count('prepare'),remote=count('remote-action')
      // Pin observations so upstream fixes change the evaluation rather than going unnoticed.
      assert.equal(prepared,mode==='pause'?1:2,JSON.stringify(actions))
      assert.equal(remote,mode==='pause'?0:mode==='side-effect'?2:1,JSON.stringify(actions))
      assert.equal(count('finish'),1)
      const events=readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
      results.push({mode,probePassed:true,compatible:mode==='pause',prepared,remote,actions,
        eventCount:events.length,sqliteBytes:readFileSync(join(root,'sessions.sqlite')).byteLength,
        observed:mode==='pause'?'Persisted human-input pause resumes across processes without repeating preparation.':
          mode==='side-effect'?'Hard crash repeats both preparation and the simulated remote action.':
          mode==='reconcile'?'ADK repeats preparation; custom external-result reconciliation prevents repeating the remote action.':
          'Fresh Runner invocation repeats completed preparation after an unplanned interruption.'})
      console.log(`RECOVERY ${mode}: prepare=${prepared}, remote=${remote}`)
    } finally {rmSync(root,{recursive:true,force:true})}
  }
  return results
}
