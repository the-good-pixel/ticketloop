// The BUILT-IN `standard` workflow — today's engine pipeline, expressed as data.
//
// This is the second half of the seed: a new user gets a working, opinionated
// workflow on day one and only customizes what they care about. It is the
// default for any project that does not name a workflow.
//
// Where this deliberately differs from the engine as it stands today, the node
// carries a comment saying so — those are the design's Phase 0 fixes (an
// external wait must suspend, not route back to a clean `fix`).

import { BUILTIN_STEP_REFS as S } from './builtin-steps.js'
import { isBranchNode, type Phase, type StepNode, type Workflow } from './types.js'

// The change path is shared by KIND=change and KIND=bug (bug just reproduces
// first). Node ids must be workflow-unique, so each variant gets a prefix.
function changePhases(prefix: string, withReproduce: boolean): Phase[] {
  const n = (id: string) => `${prefix}-${id}`
  const phases: Phase[] = []

  // Read-only: is there already an open PR for this ticket to refresh?
  phases.push({ id: n('locate'), step: S.locate, on: { pass: 'next', skip: 'next' } } as StepNode)

  if (withReproduce)
    phases.push({ id: n('reproduce'), step: S.reproduce, on: { pass: 'next' } } as StepNode)

  phases.push({ id: n('plan'), step: S.plan, on: { pass: 'next' } } as StepNode)
  phases.push({ id: n('prepare'), step: S.prepare, on: { pass: 'next' } } as StepNode)

  // The bounded repair loop: implement → verify → review, back to implement on
  // any failing gate, with a hard iteration cap and a no-progress backstop.
  phases.push({
    loop: {
      id: n('code-loop'),
      repair: { id: n('implement'), step: S.fix, on: { pass: 'next' } },
      gates: [
        { id: n('verify'), step: S.verify, on: { pass: 'next', fail: 'repair', wait: 'suspend', skip: 'next' } },
        { id: n('review'), step: S.review, on: { pass: 'exit-loop', fail: 'repair', wait: 'suspend', skip: 'exit-loop' } },
      ],
      maxIterations: 3,
      noProgress: 'stop',
    },
  })

  // Ship sits OUTSIDE the loop: once a PR exists, an external failure must not
  // blindly send execution back to a clean `fix` step.
  phases.push({
    id: n('ship'),
    step: S.ship,
    on: { pass: 'next', fail: `${n('code-loop')}.repair`, wait: 'suspend', skip: 'next' },
  } as StepNode)

  // Opt-in dev steps. DIFFERENCE FROM TODAY: a failed or pending deploy stops
  // (or suspends) instead of routing back to fix — the PR is already open, and
  // "deploy is queued for approval" is not a code defect.
  phases.push({
    id: n('deploy-dev'),
    step: S['deploy-dev'],
    on: { pass: 'next', fail: 'stop', wait: 'suspend', skip: 'next' },
  } as StepNode)
  phases.push({
    id: n('verify-dev'),
    step: S['verify-dev'],
    on: { pass: 'next', fail: 'stop', wait: 'suspend', skip: 'next' },
  } as StepNode)

  phases.push({ id: n('done'), stop: 'success' })
  return phases
}

export const STANDARD_WORKFLOW: Workflow = {
  id: 'standard',
  version: 1,
  name: 'Standard dev cycle',
  description:
    'Triage the ticket, then answer it, export data, or implement a change with a bounded ' +
    'verify/review repair loop, ship a PR, and report back on the ticket.',
  builtin: true,
  phases: [
    { id: 'triage', step: S.triage, on: { pass: 'next' } },

    // Does this ticket need any action at all? A sign-off or an ask the loop
    // cannot do stops here, before any pipeline work is spent.
    {
      id: 'route-decision',
      branch: {
        on: 'triage.DECISION',
        default: 'continue', // eligible (and anything unparsed) carries on
        cases: {
          'no-action': [
            {
              id: 'stop-no-action',
              stop: 'skipped',
              reported: true, // nothing was asked; do not post a comment
              note: 'Triage: the latest activity is a sign-off / not a request.',
            },
          ],
          ineligible: [
            {
              id: 'stop-ineligible',
              stop: 'skipped',
              reported: true,
              note: 'Triage: ineligible for the automated loop.',
            },
          ],
        },
      },
    },

    // What kind of work is it?
    {
      id: 'route-kind',
      branch: {
        on: 'triage.KIND',
        // An unrecognized kind is treated as a change — the same fail-safe the
        // engine uses today via its keyword classifier. Spelling it out as a
        // case (rather than falling through) keeps the paths provably exclusive.
        default: changePhases('default', false),
        cases: {
          question: [
            // clarify posts the answer itself, so this terminal is `reported`
            // and the `finally` comment step must not run.
            { id: 'answer', step: S.clarify, on: { pass: 'next' } },
            { id: 'answered', stop: 'success', outcome: 'answered', reported: true, note: 'Posted an answer comment.' },
          ],
          data: [
            { id: 'data-plan', step: S.plan, on: { pass: 'next' } },
            { id: 'data-prepare', step: S.prepare, on: { pass: 'next' } },
            {
              loop: {
                id: 'data-loop',
                repair: { id: 'data-export', step: S.export, on: { pass: 'next' } },
                gates: [
                  {
                    id: 'data-verify',
                    step: S.verify,
                    on: { pass: 'exit-loop', fail: 'repair', wait: 'suspend', skip: 'exit-loop' },
                  },
                ],
                maxIterations: 3,
                noProgress: 'exit-loop', // deliver what we have; the report says so
              },
            },
            { id: 'data-done', stop: 'success', outcome: 'exported', note: 'Data export posted to the ticket.' },
          ],
          bug: changePhases('bug', true),
          change: changePhases('change', false),
        },
      },
    },
  ],

  // The dependable final report. It runs on every terminal class — including
  // waiting and failure — so a ticket is never left silent, and it is skipped
  // only where the path already replied (`reported: true`).
  finally: [
    {
      id: 'report',
      step: S.comment,
      runOn: ['success', 'partial', 'waiting', 'failed'],
      on: { pass: 'next', fail: 'continue', wait: 'continue' },
    },
  ],

  outcomes: {
    // Reaching a dev deployment is what earns "deployed" — not merely having
    // the deploy step enabled.
    success: { default: 'pr-opened', whenArtifact: { devDeployment: 'deployed' } },
    partial: { default: 'partial' },
    waiting: { default: 'waiting' },
    failed: { default: 'failed' },
    skipped: { default: 'skipped' },
    blocked: { default: 'blocked' },
  },
}

// Published workflows are immutable. Version 2 closes both triage fail-open
// paths without changing runs already pinned to standard@1.
export const STANDARD_WORKFLOW_V2: Workflow = structuredClone(STANDARD_WORKFLOW)
STANDARD_WORKFLOW_V2.version = 2

const v2Decision = STANDARD_WORKFLOW_V2.phases.find((phase) => isBranchNode(phase) && phase.id === 'route-decision')
const v2Kind = STANDARD_WORKFLOW_V2.phases.find((phase) => isBranchNode(phase) && phase.id === 'route-kind')
if (!v2Decision || !isBranchNode(v2Decision) || !v2Kind || !isBranchNode(v2Kind)) {
  throw new Error('standard workflow triage branches are missing')
}

v2Decision.branch.default = [
  {
    id: 'stop-triage-failed-decision',
    stop: 'skipped',
    reported: true,
    note: 'Triage failed: DECISION was missing or invalid.',
  },
]
// `eligible` is the normal happy path. Keep the default fail-closed for a
// missing or unknown DECISION, while letting a valid eligible result continue
// to the KIND branch.
v2Decision.branch.cases.eligible = []
v2Kind.branch.default = [
  {
    id: 'stop-triage-failed-kind',
    stop: 'skipped',
    reported: true,
    note: 'Triage failed: KIND was missing or invalid.',
  },
]

export const BUILTIN_WORKFLOWS: Workflow[] = [STANDARD_WORKFLOW, STANDARD_WORKFLOW_V2]
