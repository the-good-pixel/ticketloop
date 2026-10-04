import { spawn } from 'node:child_process'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const directory=fileURLToPath(new URL('.',import.meta.url))
export async function benchmarks(){
 const root=mkdtempSync(join(tmpdir(),'ticketloop-adk-bench-'))
 const samples:Record<string,{ms:number;rss:number}[]>={current:[],adk:[]}
 try{
  for(let trial=0;trial<5;trial++)for(const executor of ['current','adk']){
   const module=executor==='current'?fileURLToPath(new URL('../../src/loop/interpreter.ts',import.meta.url)):'@google/adk'
   const code=`process.chdir(process.env.TICKETLOOP_HOME); const start=performance.now(); import(${JSON.stringify(module)}).then(()=>console.log('BENCH:'+JSON.stringify({ms:performance.now()-start,rss:process.memoryUsage().rss})))`
   const result=await new Promise<{ms:number;rss:number}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','-e',code],{cwd:directory,env:{...process.env,TICKETLOOP_HOME:root,TICKETLOOP_MOCK_DELAY_MS:'1'}})
    let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject)
    child.on('close',exit=>{if(exit!==0)return reject(new Error(stderr));const line=stdout.split('\n').find(s=>s.startsWith('BENCH:'));if(!line)return reject(new Error(stdout));resolve(JSON.parse(line.slice(6)))})
   });samples[executor].push(result)
  }
  const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]
  return {scope:'five fresh Node processes per module; import only, not an end-to-end daemon benchmark',samples,
   medians:Object.fromEntries(Object.entries(samples).map(([name,list])=>[name,{ms:median(list.map(x=>x.ms)),rss:median(list.map(x=>x.rss))}]))}
 }finally{rmSync(root,{recursive:true,force:true})}
}
