import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord, ProjectConfig } from '../src/types.js'
import type { Checkpoint } from '../src/loop/checkpoint.js'

const [scenario] = process.argv.slice(2)
const sourceRoot = process.env.TICKETLOOP_SCENARIO_SOURCE
  ? new URL(process.env.TICKETLOOP_SCENARIO_SOURCE, 'file://')
  : new URL('../src/', import.meta.url)
const root = realpathSync(mkdtempSync(join(tmpdir(),'ticketloop-workflow-scenario-')))
process.env.TICKETLOOP_HOME = root
process.env.TICKETLOOP_MOCK_DELAY_MS = '1'
const flags: Record<string, Record<string,string>> = {
  'verify-repair': {TICKETLOOP_MOCK_FAIL_VERIFIES:'1'},
  'review-repair': {TICKETLOOP_MOCK_FAIL_REVIEWS:'1'},
  'ship-repair': {TICKETLOOP_MOCK_FAIL_SHIPS:'1'},
  'ship-wait': {TICKETLOOP_MOCK_WAIT_SHIPS:'1'},
  'deploy-wait': {TICKETLOOP_MOCK_WAIT_DEPLOYS:'1'},
  'no-progress': {TICKETLOOP_MOCK_FAIL_VERIFIES:'10'},
  'ship-error-resume': {TICKETLOOP_MOCK_ERROR_SHIP:'1'},
  'no-action': {TICKETLOOP_MOCK_TRIAGE_NOACTION:'1'},
  'ineligible': {TICKETLOOP_MOCK_TRIAGE_INELIGIBLE:'1'},
}
Object.assign(process.env, flags[scenario] || {})
process.chdir(root)
const { loadConfig } = await import(new URL('config.js', sourceRoot).href) as typeof import('../src/config.js')
const { makeEngineCtx } = await import(new URL('loop/engine.js', sourceRoot).href) as typeof import('../src/loop/engine.js')
const { runWorkflow } = await import(new URL('loop/interpreter.js', sourceRoot).href) as typeof import('../src/loop/interpreter.js')
const { planForProject } = await import(new URL('commands/catalog.js', sourceRoot).href) as typeof import('../src/commands/catalog.js')
const { MockRepo } = await import(new URL('adapters/repo/github.js', sourceRoot).href) as typeof import('../src/adapters/repo/github.js')
const { loadCheckpoint } = await import(new URL('loop/checkpoint.js', sourceRoot).href) as typeof import('../src/loop/checkpoint.js')
const { config } = loadConfig()
class FixtureRepo extends MockRepo {
  createWorktree(repo: string, path: string, branch: string) {
    mkdirSync(path,{recursive:true}); super.createWorktree(repo,path,branch)
  }
  changedFilesVsBase(path: string) {
    return scenario === 'data' ? ['member-export.csv'] : super.changedFilesVsBase(path)
  }
}
const project: ProjectConfig = {
  name:'evaluation',repoPath:root,autonomy:'propose',match:{},exclude:[],engine:'workflow',workflow:'standard@2',permissions:{createFeaturePr:true},
}
if (scenario === 'codex') config.runner.defaultProvider = 'codex'
if (scenario === 'multi-repo') project.repos = [
  {name:'frontend',path:root}, {name:'backend',path:root}, {name:'infra',path:root},
]
if (scenario === 'forbidden-path') project.exclude = ['src/**']
if (scenario === 'deploy-wait') {
  project.permissions = {...project.permissions,deployDev:true}
  project.stages = {'deploy-dev':{enabled:true}}
}
config.projects = [project]
const ctx = makeEngineCtx(config,true)
ctx.repo = new FixtureRepo()
const plan = planForProject(config,project)
assert.equal(plan.diagnostics.filter(d => d.level === 'error').length,0,JSON.stringify(plan.diagnostics))
const ticket = {id:'fixture',identifier:'EVAL-1',title:'Add an account label',description:'Please add a label to the account page.',url:'https://example.invalid/EVAL-1',state:'Todo',labels:[] as string[],comments:[]}
if (scenario === 'question') {ticket.title='Why does the session expire?'; ticket.labels=['question']}
if (scenario === 'data') {ticket.title='Export the customer list'; ticket.labels=['data']}
if (scenario === 'bug') {ticket.title='Submit button is broken';ticket.labels=['bug']}
let record: RunRecord = {id:'eval-run',ticket:ticket.identifier,ticketTitle:ticket.title,ticketUrl:ticket.url,project:project.name,autonomy:project.autonomy,startedAt:Date.now(),outcome:'running',stages:[],totalTokens:0,costUsd:0}
let ck: Checkpoint = {runId:record.id,ticketKey:'evaluation:EVAL-1',marker:'fixture-v1',imagePaths:[],stageOutputs:{},updatedAt:0}
let boundaries = 0
const start = performance.now()
const turns: unknown[] = []
function trace(rec: RunRecord) {
  return {outcome:rec.outcome,stages:rec.stages.map(s=>({node:s.nodeId,status:s.status,provider:s.provider,
    invocation:!s.summary?.startsWith('⤿') && s.status !== 'skipped',
    result:s.detail?.match(/VERDICT:\s*(pass|fail|wait|skip)/i)?.[1],
    // Normalize fixture path and timing, retain the content deciding routes.
    detail:s.detail?.replaceAll(root,'<root>'),
  })),pr:rec.prUrl?.replaceAll('EVAL-1','<ticket>'),prs:rec.prs,comment:rec.commentUrl,
    artifacts:loadCheckpoint(ck.ticketKey)?.artifacts}
}
try {
  await runWorkflow(ctx,plan,ticket,project,record,ck,{isPaused:scenario==='pause-resume'?()=>++boundaries>4:()=>false})
  turns.push(JSON.parse(JSON.stringify(trace(record)).replaceAll(root,'<root>')))
  if (scenario === 'pause-resume' || scenario === 'ship-error-resume' || scenario === 'ship-wait' || scenario === 'deploy-wait') {
    record = {...record,stages:[],outcome:'running',error:undefined,endedAt:undefined}
    ck = loadCheckpoint(ck.ticketKey)!
    await runWorkflow(ctx,plan,ticket,project,record,ck,{})
    turns.push(JSON.parse(JSON.stringify(trace(record)).replaceAll(root,'<root>')))
  }
  const expected: Record<string,string> = {'question':'answered','data':'exported','no-action':'skipped','ineligible':'skipped','no-progress':'failed','forbidden-path':'blocked','deploy-wait':'deployed'}
  assert.equal(record.outcome,expected[scenario] || 'pr-opened')
  console.log('SCENARIO_RESULT:'+JSON.stringify({scenario,turns,ms:performance.now()-start,rss:process.memoryUsage().rss}))
} finally {rmSync(root,{recursive:true,force:true})}
