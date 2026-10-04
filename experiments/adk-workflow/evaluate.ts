import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { humanInputProbe } from './probes.js'
import { recoveryProbes } from './recovery.js'
import { benchmarks } from './benchmark.js'

const directory = fileURLToPath(new URL('.',import.meta.url))
const tsx = `${directory}node_modules/.bin/tsx`
export async function worker(file: string, args: string[]) {
  return new Promise<{stdout:string;stderr:string;code:number|null}>((resolve,reject)=>{
    const child = spawn(tsx,[`${directory}${file}`,...args],{cwd:directory,env:process.env})
    let stdout='',stderr=''
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s)
    child.on('error',reject)
    child.on('close',code=>resolve({stdout,stderr,code}))
    const deadline = setTimeout(()=>{child.kill('SIGKILL')},30000)
    child.on('close',()=>clearTimeout(deadline))
  })
}
const scenarios = ['question','data','bug','change','no-action','ineligible','verify-repair','review-repair','ship-repair','ship-wait','deploy-wait','no-progress','pause-resume','ship-error-resume','codex','multi-repo','forbidden-path']
const results: unknown[]=[]
for (const scenario of scenarios) {
  const [current,adk] = await Promise.all(['current','adk'].map(executor=>worker('scenario.ts',[executor,scenario])))
  const parse=(result:typeof current)=>{
    const line=result.stdout.split('\n').find(s=>s.startsWith('EVALUATION_RESULT:'))
    return line?JSON.parse(line.slice('EVALUATION_RESULT:'.length)):undefined
  }
  const a=parse(current),b=parse(adk)
  let difference:string|undefined
  try {
    assert.equal(current.code,0,current.stderr)
    assert.equal(adk.code,0,adk.stderr)
    assert.deepEqual(b?.turns,a?.turns)
  } catch(error) {difference=String(error)}
  results.push({scenario,passed:!difference,current:a,adk:b,difference,
    ...(!a?{currentLog:current.stdout,currentError:current.stderr}:{}),...(!b?{adkLog:adk.stdout,adkError:adk.stderr}:{})})
  console.log(`${difference?'FAIL':'PASS'} ${scenario}${difference?' '+difference.split('\n')[0]:''}`)
}
const humanInput = await humanInputProbe()
const recovery = await recoveryProbes()
const probeResults: Record<string, unknown> = {}
for (const [file,prefix] of [['node-probes.ts','NODE_PROBES_RESULT:'],['domain-probes.ts','DOMAIN_PROBES_RESULT:']]) {
  const result=await worker(file,[])
  assert.equal(result.code,0,result.stderr || result.stdout)
  const line=result.stdout.split('\n').find(s=>s.startsWith(prefix))
  assert.ok(line, result.stdout)
  probeResults[file]=JSON.parse(line.slice(prefix.length))
}
const benchmark = await benchmarks()
const lock = JSON.parse(readFileSync(`${directory}package-lock.json`,'utf8'))
writeFileSync(`${directory}results.json`,JSON.stringify({date:'2026-10-04',baseline:'68ebe6f',adk:'2.2.0',node:process.version,dependencies:Object.keys(lock.packages).length-1,results,humanInput,recovery,probeResults,benchmark},null,2)+'\n')
if (results.some((r:any)=>!r.passed)) process.exitCode=1
