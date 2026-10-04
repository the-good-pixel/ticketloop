import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectConfig, Ticket } from '../src/types.js'
import type { Checkpoint } from '../src/loop/checkpoint.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ticketloop-recovery-')))
process.env.TICKETLOOP_HOME = root
process.env.TICKETLOOP_MOCK_DELAY_MS = '1'
process.chdir(root)
try {
  const { loadConfig } = await import('../src/config.js')
  const { makeEngineCtx, processTicket } = await import('../src/loop/engine.js')
  const { loadCheckpoint, saveCheckpoint } = await import('../src/loop/checkpoint.js')
  const { MockTracker } = await import('../src/adapters/tracker/mock.js')
  const { planForProject } = await import('../src/commands/catalog.js')
  const { selectPlan, restorePlan } = await import('../src/loop/planSnapshot.js')
  const { prepareOperations, completeOperations, uncertainOperations, operationId, loadOperation, resolveOperation } = await import('../src/loop/operations.js')
  const { config } = loadConfig()
  const project: ProjectConfig = { name: 'recovery', repoPath: root, autonomy: 'propose', match: {}, exclude: [], permissions: { createFeaturePr: true } }
  config.projects = [project]
  const ctx = makeEngineCtx(config, true)
  const create = ctx.repo.createWorktree.bind(ctx.repo)
  ctx.repo.createWorktree = (repo, path, branch, base) => { mkdirSync(path, { recursive: true }); create(repo, path, branch, base) }
  const tracker = new MockTracker(config.tracker)
  const ticket = (identifier: string, labels: string[] = []): Ticket => ({ id: identifier, identifier,
    title: 'Add a label', description: 'Please add a label.', url: `https://example.invalid/${identifier}`, state: 'Todo', labels, comments: [] })
  let boundaries = 0
  const first = await processTicket(ctx, ticket('PLAN'), project, tracker, { marker: 'same', isPaused: () => ++boundaries > 3 })
  assert.equal(first.outcome, 'paused')
  const ck = loadCheckpoint('recovery:PLAN')!
  assert.equal(ck.executor, 'workflow')
  assert.ok(ck.snapshot)
  const originalDigest = ck.plan!.digest
  project.stages = { plan: { instruction: 'Changed instruction after pause.' } }
  assert.notEqual(planForProject(config, project).digest, originalDigest)
  const pinned = selectPlan(ck, () => { throw new Error('should not compile live catalog') }, config, project)
  assert.equal(pinned.digest, originalDigest)
  assert.notEqual(pinned.nodes.get('change-plan')!.settings.instruction, project.stages.plan!.instruction)
  const resumed = await processTicket(ctx, ticket('PLAN'), project, tracker, { marker: 'same' })
  assert.equal(resumed.id, first.id)
  assert.equal(resumed.outcome, 'pr-opened')
  assert.equal(loadCheckpoint('recovery:PLAN'), null)

  const old: Checkpoint = { ...ck, snapshot: undefined }
  assert.throws(() => selectPlan(old, () => planForProject(config, project), config, project), /Workflow changed/)
  const damaged = structuredClone(ck.snapshot!)
  damaged.plan.phases = []
  assert.throws(() => restorePlan(damaged, config, project), /invalid/)
  project.permissions = { createFeaturePr: false }
  assert.throws(() => restorePlan(ck.snapshot!, config, project), /no longer allowed/)
  project.permissions = { createFeaturePr: true }
  const originalPath = project.repoPath
  project.repoPath = `${root}/different`
  assert.throws(() => restorePlan(ck.snapshot!, config, project), /configuration changed/)
  project.repoPath = originalPath

  // Refusal preserves stage history and saved checkpoint identity.
  saveCheckpoint({ ...ck, ticketKey: 'recovery:PLAN', snapshot: damaged })
  const refused = await processTicket(ctx, ticket('PLAN'), project, tracker, { marker: 'same' })
  assert.equal(refused.outcome, 'waiting')
  assert.equal(refused.blocker?.kind, 'approval')
  assert.ok(refused.stages.length)
  assert.equal(loadCheckpoint('recovery:PLAN')!.plan!.digest, originalDigest)
  const fresh = await processTicket(ctx, ticket('PLAN'), project, tracker, { marker: 'new-activity' })
  assert.notEqual(fresh.id, refused.id)
  assert.equal(fresh.outcome, 'pr-opened')

  const corruptFile = join(root, 'checkpoints', encodeURIComponent('recovery:PLAN') + '.json')
  writeFileSync(corruptFile, '{broken JSON')
  const corruptRefusal = await processTicket(ctx, ticket('PLAN'), project, tracker, { marker: 'new-activity' })
  assert.equal(corruptRefusal.outcome, 'waiting')
  assert.equal(readFileSync(corruptFile, 'utf8'), '{broken JSON', 'execution must not overwrite a corrupt checkpoint')
  assert.equal(corruptRefusal.id, fresh.id)

  const clarifyProject = { ...project, autonomy: 'clarify' as const }
  assert.equal((await processTicket(ctx, ticket('CLARIFY'), clarifyProject, tracker)).outcome, 'answered')
  const limited = structuredClone(config)
  limited.loop.enabled = false
  const disabledLoopPlan = planForProject(limited, project)
  function loops(phases: typeof disabledLoopPlan.phases): number[] {
    return phases.flatMap(p => p.kind === 'loop' ? [p.maxIterations] : p.kind === 'branch' ?
      [...Object.values(p.cases).flatMap(loops), ...(Array.isArray(p.default) ? loops(p.default) : [])] : [])
  }
  assert.ok(loops(disabledLoopPlan.phases).every(n => n === 1))

  const providerConfig = structuredClone(config)
  providerConfig.runner.providers.claude.defaultEffort = 'high'
  const providerProject = { ...project, stages: { fix: { model: 'gpt-5.6-sol' }, plan: { instruction: 'Plan' } } }
  const providerPlan = planForProject(providerConfig, providerProject)
  assert.equal(providerPlan.nodes.get('change-implement')!.settings.provider, 'codex', 'a model-only override must retain provider inference')
  assert.equal(planForProject(providerConfig, { ...project, stages: {} }).nodes.get('change-implement')!.settings.effort, 'high', 'unconfigured quality tiers retain runner effort')
  providerConfig.executionProfiles = { quality: { effort: 'xhigh' } }
  const qualityPlan = planForProject(providerConfig, project)
  assert.equal(qualityPlan.nodes.get('change-implement')!.settings.effort, 'xhigh')

  // Old engine configuration cannot create another legacy run.
  const legacyProject = { ...project, engine: 'legacy' as const }
  assert.equal((await processTicket(ctx, ticket('NEW-LEGACY'), legacyProject, tracker)).outcome, 'waiting')
  saveCheckpoint({ runId: 'old-legacy', ticketKey: 'recovery:OLD-LEGACY', marker: 'old', imagePaths: [],
    stageOutputs: { triage: 'DECISION: eligible\nKIND: question' }, updatedAt: 0 })
  const drained = await processTicket(ctx, ticket('OLD-LEGACY', ['question']), project, tracker, { marker: 'old' })
  assert.equal(drained.outcome, 'answered')
  assert.ok(drained.stages.every(stage => !stage.nodeId))
  assert.equal(loadCheckpoint('recovery:OLD-LEGACY'), null)
  saveCheckpoint({ runId: 'old-empty', ticketKey: 'recovery:EMPTY-LEGACY', marker: 'empty', imagePaths: [], stageOutputs: {}, updatedAt: 0 })
  const emptyLegacy = await processTicket(ctx, { ...ticket('EMPTY-LEGACY', ['question']), title: 'Why does the session expire?' }, project, tracker, { marker: 'empty' })
  assert.equal(emptyLegacy.outcome, 'answered')
  assert.ok(emptyLegacy.stages.every(stage => !stage.nodeId))

  for (const [identifier, kind] of [['LEGACY-CHANGE', 'change'], ['LEGACY-BUG', 'bug'], ['LEGACY-DATA', 'data']] as const) {
    saveCheckpoint({ runId: identifier, ticketKey: `recovery:${identifier}`, marker: 'old', imagePaths: [],
      stageOutputs: { triage: `DECISION: eligible\nKIND: ${kind}` }, updatedAt: 0 })
    const oldRun = await processTicket(ctx, ticket(identifier), project, tracker, { marker: 'old' })
    assert.equal(oldRun.id, identifier, 'missing history must not change the checkpoint operation identity')
    assert.equal(oldRun.outcome, kind === 'data' ? 'exported' : 'pr-opened')
    assert.ok(oldRun.stages.every(stage => !stage.nodeId))
  }

  const input = { runId: 'external-run', ticketKey: 'recovery:REMOTE', ticketId: 'remote-id', nodeKey: 'report/success',
    effects: ['tracker-comment'], cwd: root }
  let lookups = 0
  const lookup = async () => { lookups++; return { state: 'found' as const, url: 'https://linear.app/demo/issue/REMOTE#comment-one' } }
  const intent = await prepareOperations(input, lookup)
  assert.ok(!('wait' in intent))
  assert.equal(lookups, 0)
  const recovered = await prepareOperations(input, lookup)
  assert.ok(!('wait' in recovered) && recovered.recoveredOutput?.includes('COMMENT_URL'))
  if ('wait' in recovered) throw new Error(String(recovered.wait))
  completeOperations(recovered.operations, recovered.recoveredOutput!)
  assert.equal(uncertainOperations(input.ticketKey).length, 0)
  assert.ok((await prepareOperations(input, lookup) as typeof recovered).recoveredOutput)
  for (const state of ['absent', 'unknown'] as const) {
    const item = { ...input, runId: state }
    await prepareOperations(item, lookup)
    assert.ok('wait' in await prepareOperations(item, async () => ({ state })))
    assert.equal(uncertainOperations(input.ticketKey).filter(op => op.runId === state).length, 1)
  }
  const pr = { ...input, runId: 'pr-run', effects: ['create-pr'], branch: 'ticketloop/remote', base: 'origin/main' }
  await prepareOperations(pr, lookup)
  const adopted = await prepareOperations(pr, async () => ({ state: 'found', url: 'https://github.com/demo/repo/pull/1' }))
  assert.ok(!('wait' in adopted) && !adopted.recoveredOutput && adopted.prompt.includes('Continue the shipping checks'))
  if ('wait' in adopted) throw new Error(String(adopted.wait))
  completeOperations(adopted.operations, 'https://github.com/demo/repo/pull/1\nVERDICT: wait — CI unavailable')
  assert.equal(loadOperation(operationId(pr.runId, pr.nodeKey, 'create-pr'))!.status, 'completed')
  const changedRepo = { ...pr, cwd: `${root}/other` }
  assert.ok('wait' in await prepareOperations(changedRepo, lookup))
  const deployment = { ...input, runId: 'unsupported', effects: ['deploy-dev'] }
  await prepareOperations(deployment, lookup)
  assert.ok('wait' in await prepareOperations(deployment, lookup))
  const anotherClass = { ...input, nodeKey: 'report/failed' }
  assert.notEqual(operationId(input.runId, input.nodeKey, 'tracker-comment'), operationId(input.runId, anotherClass.nodeKey, 'tracker-comment'))
  assert.notEqual(operationId(pr.runId, 'ship/backend', 'create-pr'), operationId(pr.runId, 'ship/frontend', 'create-pr'))

  const { setTicketPaused } = await import('../src/daemon/control.js')
  const manualId = operationId('absent', input.nodeKey, 'tracker-comment')
  assert.throws(() => resolveOperation(manualId, 'not-performed', 'Checked remote issue'), /Pause/)
  setTicketPaused(input.ticketKey, true)
  assert.throws(() => resolveOperation(manualId, 'not-performed', ''), /reason/)
  resolveOperation(manualId, 'not-performed', 'Operator verified the request never reached the service')
  assert.equal(loadOperation(manualId)!.status, 'not-performed')
  const retryAfterReview = await prepareOperations({ ...input, runId: 'absent' }, async () => { throw new Error('reviewed absence does not need another lookup') })
  assert.ok(!('wait' in retryAfterReview))
  assert.equal(loadOperation(manualId)!.status, 'pending', 'intent must be saved before the reviewed attempt')
  resolveOperation(manualId, 'https://linear.app/demo/issue/REMOTE#comment-verified', 'Operator verified the delivered comment')
  assert.equal(loadOperation(manualId)!.status, 'completed')
  const deployId = operationId(deployment.runId, deployment.nodeKey, 'deploy-dev')
  resolveOperation(deployId, 'performed', 'Verified DEV deployment completed in the provider history')
  const recoveredDeploy = await prepareOperations(deployment, async () => { throw new Error('must not repeat confirmed deployment') })
  assert.ok(!('wait' in recoveredDeploy))
  assert.match(recoveredDeploy.recoveredOutput!, /VERDICT: pass/)
  const cleanDeploy = { ...deployment, runId: 'clean-deployment', ticketKey: 'pilot:CLEAN' }
  const cleanPrepared = await prepareOperations(cleanDeploy, lookup)
  assert.ok(!('wait' in cleanPrepared))
  completeOperations(cleanPrepared.operations, 'Deployment completed.\nVERDICT: pass')
  assert.equal(uncertainOperations(cleanDeploy.ticketKey, 'later-run').length, 0)
  for (const verdict of ['fail', 'wait', 'skip', '']) {
    const attempt = { ...cleanDeploy, runId: `deploy-${verdict || 'missing'}`, ticketKey: `pilot:${verdict || 'missing'}` }
    const prepared = await prepareOperations(attempt, lookup)
    assert.ok(!('wait' in prepared))
    completeOperations(prepared.operations, verdict ? `VERDICT: ${verdict}` : 'No verdict')
    assert.equal(uncertainOperations(attempt.ticketKey, 'later-run').length, 1)
    assert.ok('wait' in await prepareOperations(attempt, lookup))
  }
  const corruptId = operationId(cleanDeploy.runId, cleanDeploy.nodeKey, 'deploy-dev')
  const corruptPath = join(root, 'operations', corruptId + '.json')
  writeFileSync(corruptPath, '{broken')
  assert.equal(uncertainOperations('other:UNRELATED').length, 0)
  assert.throws(() => uncertainOperations(cleanDeploy.ticketKey), /Unreadable external-operation record/)
  assert.equal(readFileSync(corruptPath, 'utf8'), '{broken', 'preserve corrupt evidence')
  rmSync(corruptPath)
  rmSync(join(root, 'operations', corruptId + '.owner.json'))
  const legacyId = operationId('old-unknown', 'deploy', 'deploy-dev')
  const legacyPath = join(root, 'operations', legacyId + '.json')
  writeFileSync(legacyPath, '{broken')
  assert.throws(() => uncertainOperations('other:UNRELATED'), /Unreadable external-operation record/, 'unknown ownership must fail safely')
  rmSync(legacyPath)
  setTicketPaused(input.ticketKey, false)

  // Real interpreter path with fake runner and fake remote reads; no model/network.
  const crashCtx = makeEngineCtx(config, false)
  crashCtx.repo = ctx.repo
  crashCtx.governor.canRun = () => ({ ok: true })
  let quotaCalls = 0
  crashCtx.invokeAgent = async () => { quotaCalls++; throw new Error('quota should prevent invocation') }
  crashCtx.governor.canRun = () => ({ ok: false })
  const quotaWait = await processTicket(crashCtx, ticket('QUOTA', ['question']), project, tracker, { marker: 'quota' })
  assert.equal(quotaWait.outcome, 'waiting')
  assert.equal(quotaWait.blocker?.kind, 'provider')
  assert.equal(quotaWait.blocker?.resume, 'automatic')
  assert.equal(quotaCalls, 0)
  crashCtx.governor.canRun = () => ({ ok: true })
  crashCtx.invokeAgent = async options => ({ provider: 'claude', model: 'mock', inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, isError: false,
    text: options.mockKind === 'triage' ? 'DECISION: eligible\nKIND: question' : 'COMMENT_URL: https://linear.app/demo/issue/QUOTA#comment-one' })
  const afterQuota = await processTicket(crashCtx, ticket('QUOTA', ['question']), project, tracker, { marker: 'quota' })
  assert.equal(afterQuota.id, quotaWait.id)
  assert.equal(afterQuota.outcome, 'answered')

  const oldActionBlocked = await processTicket(crashCtx, ticket('REMOTE'), project, tracker, { marker: 'new-marker' })
  assert.equal(oldActionBlocked.outcome, 'waiting')
  assert.match(oldActionBlocked.error!, /earlier run has uncertain/)
  let posts = 0
  let remote = false
  crashCtx.invokeAgent = async options => {
    const kind = options.mockKind
    const result = { provider: 'claude' as const, model: 'mock', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, isError: false, text: 'DECISION: eligible\nKIND: question' }
    if (kind === 'clarify') {
      assert.match(options.prompt, /<!-- tlk:[a-f0-9]{64} -->/)
      posts++; remote = true
      throw new Error('simulated loss after remote delivery')
    }
    if (kind === 'comment') return { ...result, text: 'COMMENT_URL: https://linear.app/demo/issue/FAILURE#comment-one' }
    return result
  }
  crashCtx.reconcileOperation = async op => remote && op.effect === 'tracker-comment' ?
    { state: 'found', url: 'https://linear.app/demo/issue/DELIVERY#comment-one' } : { state: 'unknown' }
  const failed = await processTicket(crashCtx, ticket('DELIVERY', ['question']), project, tracker, { marker: 'delivery' })
  assert.equal(failed.outcome, 'failed')
  const delivered = await processTicket(crashCtx, ticket('DELIVERY', ['question']), project, tracker, { marker: 'delivery' })
  assert.equal(delivered.outcome, 'answered')
  assert.equal(posts, 1)
  assert.match(delivered.commentUrl!, /DELIVERY/)
  console.log('recovery smoke: saved plans, restrictions, history, markers, legacy drain and uncertain actions passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
