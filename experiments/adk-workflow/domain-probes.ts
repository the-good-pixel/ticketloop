import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectConfig, RunRecord } from '../../src/types.js'
import type { Checkpoint } from '../../src/loop/checkpoint.js'
const root=realpathSync(mkdtempSync(join(tmpdir(),'ticketloop-adk-domain-')))
process.env.TICKETLOOP_HOME=root;process.env.TICKETLOOP_MOCK_DELAY_MS='1';process.chdir(root)
const {loadConfig}=await import('../../src/config.js')
const {makeEngineCtx,processTicket}=await import('../../src/loop/engine.js')
const {MockTracker}=await import('../../src/adapters/tracker/mock.js')
const {MockRepo}=await import('../../src/adapters/repo/github.js')
const {planForProject}=await import('../../src/commands/catalog.js')
const {runWorkflow}=await import('../../src/loop/interpreter.js')
const {loadCheckpoint}=await import('../../src/loop/checkpoint.js')
const {reattachWorkspace}=await import('../../src/loop/workspace.js')
const {loadCatalog}=await import('../../src/catalog/store.js')
const {exportBundle,inspectBundle}=await import('../../src/catalog/bundle.js')
const {adkDriver}=await import('./adapter.js')
const {config}=loadConfig()
const project:ProjectConfig={name:'domain',repoPath:root,autonomy:'propose',match:{},exclude:[],engine:'workflow',workflow:'standard@2',permissions:{createFeaturePr:true}}
config.projects=[project]
const ctx=makeEngineCtx(config,true)
class FixtureRepo extends MockRepo {createWorktree(repo:string,path:string,branch:string){mkdirSync(path,{recursive:true});super.createWorktree(repo,path,branch)}}
ctx.repo=new FixtureRepo()
const tracker=new MockTracker(config.tracker)
const ticket=(id:string)=>({id,identifier:id,title:'Add an account label',description:'Please add a label to the account page.',url:`https://example.invalid/${id}`,state:'Todo',labels:[],comments:[]})
const results:unknown[]=[]
try {
  let calls=0
  const paused=await processTicket(ctx,ticket('MARKER'),project,tracker,{marker:'first',isPaused:()=>++calls>4})
  assert.equal(paused.outcome,'paused')
  const fresh=await processTicket(ctx,ticket('MARKER'),project,tracker,{marker:'second'})
  assert.notEqual(fresh.id,paused.id);assert.ok(!fresh.stages[0].summary?.startsWith('⤿'))
  results.push({name:'new activity invalidates checkpoint at shared engine entry',passed:true})

  calls=0
  await processTicket(ctx,ticket('PLAN'),project,tracker,{marker:'same',isPaused:()=>++calls>4})
  const before=loadCheckpoint('domain:PLAN')!.plan!.digest
  project.stages={triage:{instruction:'Changed instruction during pause.'}}
  const after=planForProject(config,project).digest
  assert.notEqual(before,after)
  const resumed=await processTicket(ctx,ticket('PLAN'),project,tracker,{marker:'same'})
  assert.ok(resumed.stages[0].summary?.startsWith('⤿'))
  results.push({name:'plan changes during suspension',probePassed:true,compatible:false,existingGap:true,
    observed:'Current engine accepts a changed plan digest while replaying cached outputs; snapshot enforcement is not implemented at this entry.'})
  project.stages={}

  const denied={...project,permissions:{createFeaturePr:false}}
  const invalid=planForProject(config,denied)
  assert.ok(invalid.diagnostics.some(d=>d.code==='permission-denied' && d.level==='error'))
  assert.throws(()=>adkDriver(invalid,{events:0,nodes:0}),/granted/)
  const blocked=await processTicket(ctx,ticket('DENIED'),denied,tracker,{marker:'new'})
  assert.equal(blocked.outcome,'blocked');assert.equal(blocked.stages.length,0)
  results.push({name:'missing permissions rejected before execution',passed:true})

  for (const executor of ['current','adk']) {
    const plan=planForProject(config,project)
    const rec:RunRecord={id:`quota-${executor}`,ticket:`QUOTA-${executor}`,ticketTitle:'quota',ticketUrl:'https://example.invalid/quota',project:'domain',autonomy:'propose',startedAt:Date.now(),outcome:'running',stages:[],totalTokens:0,costUsd:0}
    const ck:Checkpoint={runId:rec.id,ticketKey:`domain:${rec.ticket}`,marker:'quota',imagePaths:[],stageOutputs:{},updatedAt:0}
    const limited={...ctx,mock:false,governor:{...ctx.governor,canRun:()=>({ok:false,resetAt:Date.now()+60000})} as typeof ctx.governor}
    const driver=executor==='adk'?adkDriver(plan,{nodes:0,events:0}):undefined
    // Deny every invocation, including final reporting, before any runner is reached.
    await runWorkflow(limited,plan,ticket(rec.ticket),project,rec,ck,{},driver)
    assert.equal(rec.outcome,'waiting-provider');assert.equal(rec.stages.length,0)
    await runWorkflow(ctx,plan,ticket(rec.ticket),project,rec,ck,{},driver)
    assert.equal(rec.outcome,'pr-opened')
  }
  results.push({name:'quota suspension and resume through both executors',passed:true})

  const path=join(root,'workspace');mkdirSync(path);writeFileSync(join(path,'.git'),'gitdir: fixture')
  const workspace={repos:[{name:'fixture',srcPath:root,workdir:path,base:'main',branch:'feature',exclude:[],shipDisabled:false}],cwd:path,multi:false,useWorktree:true}
  assert.ok(reattachWorkspace(workspace));rmSync(path,{recursive:true});assert.equal(reattachWorkspace(workspace),null)
  results.push({name:'shared workspace reattachment detects missing worktree',passed:true,note:'helper check; complete real-run recovery was not exercised'})

  const catalog=loadCatalog()
  const ownWorkflow=structuredClone(catalog.workflows.get('standard@2')!.item)
  ownWorkflow.id='evaluation-custom';ownWorkflow.builtin=false
  catalog.workflows.set('evaluation-custom@2',{item:ownWorkflow,scope:'user'})
  const bundle=exportBundle(catalog,{id:'trust-eval',workflowRefs:['evaluation-custom@2'],includeDependencies:true})
  const report=inspectBundle(catalog,bundle)
  assert.ok(report.checksumOk)
  assert.ok(report.externalEffects.some(e=>e.effects.includes('create-pr')))
  assert.ok(report.requestedPermissions.some(p=>p.permissions.includes('createFeaturePr')))
  bundle.workflows[0].description+='tampered'
  assert.equal(inspectBundle(catalog,bundle).checksumOk,false)
  results.push({name:'bundle trust declarations and checksum refusal retained',passed:true})
  const deployments=[...catalog.steps.values()].map(s=>s.item).filter(s=>s.capabilities.externalEffects.includes('deploy-dev'))
  assert.ok(deployments.length>0 && deployments.every(s=>s.capabilities.devOnly))
  results.push({name:'built-in deployment steps declare DEV-only capability',passed:true,note:'catalog inspection; no deployment was invoked'})
  console.log('DOMAIN_PROBES_RESULT:'+JSON.stringify(results))
} finally {rmSync(root,{recursive:true,force:true})}
