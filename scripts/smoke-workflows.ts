/**
 * Release smoke test for the workflow interpreter.
 *
 * This intentionally uses the real compiler, interpreter, checkpoint store and
 * mock runner. It spends no quota, touches no real repository and needs no
 * tracker credentials.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'ticketloop-workflow-smoke-'))

async function main(): Promise<void> {
  // Runner mock counters are read when the module loads, so set every injector
  // before importing ticketloop modules.
  process.env.TICKETLOOP_HOME = root
  process.env.TICKETLOOP_MOCK_DELAY_MS = '1'
  process.env.TICKETLOOP_MOCK_FAIL_VERIFIES = '2' // data once, then bug once
  process.env.TICKETLOOP_MOCK_FAIL_REVIEWS = '1'
  process.env.TICKETLOOP_MOCK_ERROR_SHIP = '1'
  process.env.TICKETLOOP_MOCK_WAIT_SHIPS = '1'
  process.chdir(root)

  const { loadConfig } = await import('../src/config.js')
  const { makeEngineCtx, processTicket } = await import('../src/loop/engine.js')
  const { WORKTREE_SETUP_STEP, WORKTREE_CLEANUP_STEP, WORKTREE_SYSTEM_STEPS } = await import('../src/loop/workspace.js')
  const { MockTracker } = await import('../src/adapters/tracker/mock.js')
  const { getStep, loadCatalog } = await import('../src/catalog/store.js')

  const { config } = loadConfig()
  assert.equal(WORKTREE_SETUP_STEP.id, 'create-worktree')
  assert.equal(WORKTREE_CLEANUP_STEP.id, 'remove-worktree')
  assert.equal(WORKTREE_CLEANUP_STEP.locked, true)
  assert.ok(WORKTREE_CLEANUP_STEP.runOn.includes('pr-opened'))
  assert.deepEqual(WORKTREE_SYSTEM_STEPS.map((step) => step.id), ['create-worktree', 'remove-worktree'])
  const project = {
    name: 'smoke-project',
    repoPath: root,
    autonomy: 'propose' as const,
    match: {},
    exclude: [],
    engine: 'workflow' as const,
    workflow: 'standard@3',
    permissions: { createFeaturePr: true },
  }
  config.projects = [project]

  const tracker = new MockTracker(config.tracker)
  const ctx = makeEngineCtx(config, true)
  const removedWorktrees: string[] = []
  const deletedBranches: string[] = []
  const removeWorktree = ctx.repo.removeWorktree.bind(ctx.repo)
  const deleteBranch = ctx.repo.deleteBranch.bind(ctx.repo)
  ctx.repo.removeWorktree = (repoPath, worktreePath) => {
    removedWorktrees.push(worktreePath)
    removeWorktree(repoPath, worktreePath)
  }
  ctx.repo.deleteBranch = (repoPath, branch) => {
    deletedBranches.push(branch)
    deleteBranch(repoPath, branch)
  }
  const ticket = (identifier: string, title: string, description: string, labels: string[] = []) => ({
    id: identifier.toLowerCase(),
    identifier,
    title,
    description,
    url: `https://example.invalid/${identifier}`,
    state: 'Todo',
    labels,
    comments: [],
  })
  const run = (item: ReturnType<typeof ticket>) =>
    processTicket(ctx, item, project, tracker, { marker: 'release-smoke-v1' })
  const nodes = (record: Awaited<ReturnType<typeof run>>) => record.stages.map((stage) => stage.nodeId)

  const question = await run(ticket('SMOKE-QUESTION', 'Why does the session expire?', 'Please explain this behavior.', ['question']))
  assert.equal(question.outcome, 'answered')
  assert.deepEqual(nodes(question), ['triage', 'answer'])

  const data = await run(ticket('SMOKE-DATA', 'Export the customer list', 'Export active customers to CSV.', ['data']))
  assert.equal(data.outcome, 'exported')
  assert.ok(nodes(data).filter((id) => id === 'data-export').length >= 2, 'data verification failure should repair once')
  assert.ok(nodes(data).includes('report'))
  assert.ok(nodes(data).includes('data-cleanup'))
  assert.ok(removedWorktrees.some((p) => p.endsWith('/SMOKE-DATA')), 'delivered data worktree must be removed')
  assert.ok(deletedBranches.includes('ticketloop/smoke-data'), 'throwaway data branch must be removed')

  const bugTicket = ticket('SMOKE-BUG', 'Submit button is broken', 'It throws a 500 error.', ['bug'])
  const failedBug = await run(bugTicket)
  assert.equal(failedBug.outcome, 'failed')
  assert.match(failedBug.error || '', /Unable to connect/i)
  const runId = failedBug.id
  assert.ok(!removedWorktrees.some((p) => p.endsWith('/SMOKE-BUG')), 'failed worktree must remain resumable')

  const waitingBug = await run(bugTicket)
  assert.equal(waitingBug.id, runId, 'waiting must continue the same run record')
  assert.equal(waitingBug.resumes, 1)
  assert.equal(waitingBug.outcome, 'waiting')
  assert.ok(!removedWorktrees.some((p) => p.endsWith('/SMOKE-BUG')), 'waiting worktree must remain resumable')

  const resumedBug = await run(bugTicket)
  assert.equal(resumedBug.id, runId, 'resume must continue the same run record')
  assert.equal(resumedBug.resumes, 2)
  assert.equal(resumedBug.outcome, 'pr-opened')
  assert.ok(nodes(resumedBug).includes('bug-reproduce'))
  assert.ok(nodes(resumedBug).includes('bug-ship'))
  assert.ok(nodes(resumedBug).includes('bug-cleanup'))
  assert.ok(nodes(resumedBug).includes('report'))
  assert.ok(removedWorktrees.some((p) => p.endsWith('/SMOKE-BUG')), 'shipped worktree must be removed after resume')
  assert.ok(!deletedBranches.includes('ticketloop/smoke-bug'), 'branch with a PR must remain')

  const change = await run(ticket('SMOKE-CHANGE', 'Add an account label', 'Please add a label to the account page.'))
  assert.equal(change.outcome, 'pr-opened')
  assert.ok(nodes(change).includes('change-implement'))
  assert.ok(!nodes(change).includes('bug-reproduce'))
  assert.ok(nodes(change).includes('change-cleanup'))
  assert.ok(removedWorktrees.some((p) => p.endsWith('/SMOKE-CHANGE')), 'shipped change worktree must be removed')

  const cleanup = getStep(loadCatalog(), 'cleanup@1')
  assert.equal(cleanup.capabilities.mutatesRepo, true)

  process.env.TICKETLOOP_MOCK_TRIAGE_NOACTION = '1'
  const noAction = await run(ticket('SMOKE-NO-ACTION', 'UAT passed', 'Looks good, thanks.'))
  delete process.env.TICKETLOOP_MOCK_TRIAGE_NOACTION
  assert.equal(noAction.outcome, 'skipped')
  assert.deepEqual(nodes(noAction), ['triage'])

  console.log('workflow smoke: question, data repair, bug repair/resume, change, and no-action passed')
}

main()
  .finally(() => rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
