// The BUILT-IN step catalog — ticketloop's current pipeline, expressed as data.
//
// This is the seed: every step here is exactly the stage the engine runs today,
// with the same instruction text (imported from config.ts, so there is ONE
// source of truth and the two can never drift). Users get these as version 1 of
// the shared catalog and clone them to customize — nobody starts from scratch.
//
// Built-ins are immutable: cloning bumps a step into the user catalog under the
// same id at a higher version, or under a new id.

import { DEFAULT_INSTRUCTIONS } from '../config.js'
import type { CatalogStep, StepCapabilities } from './types.js'

type StepSeed = Omit<CatalogStep, 'version' | 'builtin' | 'instruction'> & { instruction?: string }

function step(s: StepSeed): CatalogStep {
  return {
    ...s,
    version: 1,
    builtin: true,
    instruction: s.instruction ?? DEFAULT_INSTRUCTIONS[s.id as never],
  }
}

// Shorthands for the capability blocks that repeat.
const caps = (
  workspace: StepCapabilities['workspace'],
  mutatesRepo: boolean,
): StepCapabilities => ({ workspace, mutatesRepo, perRepo: 'once', devOnly: false, externalEffects: [] })
const readOnlyCheckout = caps('checkout', false)
const readOnlyWorktree = caps('change', false)
const editsWorktree = caps('change', true)

export const BUILTIN_STEPS: CatalogStep[] = [
  step({
    id: 'triage',
    name: 'Triage',
    description: 'Decide whether the ticket needs action, and what kind of work it is.',
    defaults: { executionProfile: 'fast', effort: 'low', allowedTools: 'Read,Bash', enabled: true },
    contract: 'route',
    routeFields: ['DECISION', 'KIND'],
    capabilities: readOnlyCheckout,
    resumePolicy: 'replay',
    produces: { key: 'triage', type: 'text' },
  }),
  step({
    id: 'clarify',
    name: 'Clarify',
    description: 'Answer a client question from the code, and post the answer to the ticket.',
    defaults: { executionProfile: 'balanced', effort: 'medium', allowedTools: 'Read,Bash', enabled: true },
    contract: 'post',
    capabilities: { ...readOnlyCheckout, externalEffects: ['tracker-comment'] },
    resumePolicy: 'idempotent',
    produces: { key: 'answer', type: 'text' },
  }),
  step({
    id: 'export',
    name: 'Data export',
    description: 'Read-only data pull producing an export file. Never writes to the source.',
    // Not a gate — the data loop's gate is `verify`, which judges the exported
    // data. Export just produces the file.
    defaults: { executionProfile: 'balanced', effort: 'medium', allowedTools: 'Read,Bash', enabled: true },
    contract: 'text',
    capabilities: { workspace: 'read-only', mutatesRepo: false, perRepo: 'once', devOnly: false, externalEffects: [] },
    resumePolicy: 'rerun',
    consumes: ['plan'],
    produces: { key: 'exportFile', type: 'file' },
  }),
  step({
    id: 'locate',
    name: 'Locate existing PR',
    description: 'Find an open PR for this ticket to refresh instead of opening a new one.',
    defaults: { executionProfile: 'fast', effort: 'low', allowedTools: 'Read,Bash', enabled: true },
    contract: 'route',
    routeFields: ['REUSE'],
    capabilities: readOnlyCheckout,
    resumePolicy: 'revalidate', // the PR may have been merged since the last attempt
    produces: { key: 'reuseBranch', type: 'branch' },
  }),
  step({
    id: 'reproduce',
    name: 'Reproduce bug',
    description: 'Reproduce the reported bug and find its root cause before any fix is planned.',
    defaults: { executionProfile: 'balanced', effort: 'medium', allowedTools: 'Read,Edit,Bash', enabled: true },
    contract: 'text',
    capabilities: editsWorktree, // may write a failing test to prove the bug
    resumePolicy: 'replay',
    produces: { key: 'reproduce', type: 'text' },
  }),
  step({
    id: 'plan',
    name: 'Plan',
    description: 'Plan the smallest correct change and how it will be verified.',
    defaults: { executionProfile: 'balanced', effort: 'medium', allowedTools: 'Read,Bash', enabled: true },
    contract: 'text',
    capabilities: readOnlyWorktree,
    resumePolicy: 'replay',
    consumes: ['reproduce'],
    produces: { key: 'plan', type: 'text' },
  }),
  step({
    id: 'prepare',
    name: 'Prepare workspace',
    description: 'Read the relevant code and get the tree ready to build/test. No product edits.',
    defaults: { executionProfile: 'fast', effort: 'low', allowedTools: 'Read,Bash', enabled: true },
    contract: 'text',
    capabilities: editsWorktree, // may install dependencies
    resumePolicy: 'rerun',
    consumes: ['plan'],
    produces: { key: 'prepare', type: 'text' },
  }),
  step({
    id: 'fix',
    name: 'Implement',
    description: 'Implement the plan with the smallest possible diff.',
    defaults: { executionProfile: 'quality', allowedTools: 'Read,Edit,Bash', enabled: true },
    contract: 'text',
    capabilities: editsWorktree,
    resumePolicy: 'replay',
    consumes: ['plan', 'reproduce', 'openFindings'],
    produces: { key: 'fix', type: 'text' },
  }),
  step({
    id: 'verify',
    name: 'Verify locally',
    description: 'Run the project’s checks and judge whether the change actually works. Judge only.',
    defaults: { executionProfile: 'quality', allowedTools: 'Read,Edit,Bash', enabled: true },
    contract: 'verdict',
    capabilities: editsWorktree, // running tests may write build artifacts
    resumePolicy: 'rerun', // local state may have moved; never trust a cached pass
    consumes: ['plan', 'fix'],
    produces: { key: 'verify', type: 'text' },
  }),
  step({
    id: 'review',
    name: 'Code review',
    description: 'Critically review the uncommitted diff for correctness and scope creep.',
    defaults: { executionProfile: 'quality', skill: 'code-review', allowedTools: 'Read,Bash', enabled: true },
    skills: { claude: 'code-review', codex: 'code-review' },
    contract: 'verdict',
    capabilities: readOnlyWorktree,
    resumePolicy: 'rerun',
    consumes: ['plan', 'fix', 'verify'],
    produces: { key: 'review', type: 'text' },
  }),
  step({
    id: 'ship',
    name: 'Ship',
    description: 'Commit, push, and open (or update) a pull request. Never merges.',
    // A gate AND an artifact producer: `contract` decides how the RESULT is
    // read, `produces.type` decides what typed state is recorded. Ship needs
    // both — a red CI run must route back for repair, and the PR it opened must
    // still be remembered.
    defaults: { executionProfile: 'quality', allowedTools: 'Read,Bash', enabled: true },
    contract: 'verdict',
    capabilities: { workspace: 'change', mutatesRepo: true, perRepo: 'changed', devOnly: false, externalEffects: ['create-pr'] },
    requiresPermissions: ['createFeaturePr'],
    resumePolicy: 'revalidate', // the PR may already exist from the interrupted attempt
    consumes: ['plan', 'fix', 'verify', 'review'],
    produces: { key: 'featurePr', type: 'github-pr' },
  }),
  step({
    id: 'deploy-dev',
    name: 'Deploy to DEV',
    description: 'Deploy the shipped change to the DEV environment only. Opt-in per project.',
    // Opt-in: deploying needs a real per-project mechanism, so it stays off
    // until a project enables it AND grants the deployDev permission.
    defaults: { executionProfile: 'quality', allowedTools: 'Read,Bash', enabled: false },
    contract: 'verdict',
    capabilities: { workspace: 'change', mutatesRepo: false, perRepo: 'once', devOnly: true, externalEffects: ['deploy-dev'] },
    requiresPermissions: ['deployDev'],
    resumePolicy: 'revalidate', // a deploy may have landed while we were away
    requires: ['featurePr'],
    produces: { key: 'devDeployment', type: 'deployment' },
  }),
  step({
    id: 'verify-dev',
    name: 'Verify on DEV',
    description: 'Verify the change works in the DEV environment, not just the local build.',
    defaults: { executionProfile: 'quality', allowedTools: 'Read,Bash', enabled: false },
    contract: 'verdict',
    capabilities: { workspace: 'change', mutatesRepo: false, perRepo: 'once', devOnly: true, externalEffects: [] },
    resumePolicy: 'rerun',
    requires: ['devDeployment'],
    consumes: ['featurePr'],
    produces: { key: 'verifyDev', type: 'text' },
  }),
  step({
    id: 'comment',
    name: 'Report to ticket',
    description: 'Post the outcome back to the ticket.',
    defaults: { executionProfile: 'balanced', allowedTools: 'Read,Bash', enabled: true },
    contract: 'post',
    capabilities: { workspace: 'checkout', mutatesRepo: false, perRepo: 'once', devOnly: false, externalEffects: ['tracker-comment'] },
    resumePolicy: 'idempotent', // a retry must not double-post
    consumes: ['plan', 'fix', 'featurePr', 'exportFile', 'devDeployment', 'verifyDev'],
    produces: { key: 'comment', type: 'text' },
  }),
  step({
    id: 'cleanup',
    name: 'Clean up workspace',
    description: 'Run optional project-specific cleanup before the harness removes a completed worktree.',
    instruction:
      'Clean up temporary files, generated artifacts, background processes, containers, or other local resources ' +
      'created by this ticket run, following the project instructions. Stay inside the isolated workspace. Never ' +
      'remove the Git worktree itself, delete its branch, reset or discard tracked changes, or touch another checkout. ' +
      'Keep any requested export or other deliverable needed by the final report. Report what you cleaned. If there ' +
      'is nothing to clean, pass without making changes.',
    defaults: { executionProfile: 'fast', effort: 'low', allowedTools: 'Read,Edit,Bash', enabled: true },
    contract: 'verdict',
    capabilities: { workspace: 'change', mutatesRepo: true, perRepo: 'once', devOnly: false, externalEffects: [] },
    resumePolicy: 'rerun',
    consumes: ['fix', 'verify', 'featurePr', 'exportFile'],
    produces: { key: 'cleanup', type: 'text' },
  }),
]

export const BUILTIN_STEP_REFS = Object.fromEntries(
  BUILTIN_STEPS.map((s) => [s.id, `${s.id}@${s.version}`]),
) as Record<string, string>
