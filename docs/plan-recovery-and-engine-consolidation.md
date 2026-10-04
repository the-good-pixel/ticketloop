# Recovery fixes and one workflow executor

Date: 2026-10-04
Status: recovery fixes and workflow-default consolidation implemented locally; legacy deletion awaits checkpoint drain
Baseline reviewed: `68ebe6f`

Implementation results and checks: [recovery-consolidation-results.md](recovery-consolidation-results.md).

## Goal

Make interrupted runs safe to continue, then remove the duplicated legacy pipeline. Keep the existing workflow interpreter; do not add ADK.

The ADK evaluation reproduced two recovery gaps: a resumed workflow accepts a changed plan while replaying old outputs, and a remote action can succeed before its output reaches the local checkpoint. The repository also has a broken data-export smoke fixture. Fix recovery before changing the default executor.

## 1. Establish recovery checks

Work in a separate feature worktree, preserving the shared checkout and ADK experiment. Carry over only the smoke-fixture correction: create the mock worktree directory, use a canonical temporary path, and report the declared CSV for the data scenario. Leave production workspace guards intact.

Add focused `tsx` checks using fresh temporary `TICKETLOOP_HOME` directories and mocks configured before dynamic imports. Retain the useful evaluation scenarios as ordinary repository checks without ADK dependencies. Record existing differences between engines before changing defaults.

Acceptance: `npm run check` passes, and the changed-plan reproduction fails safely rather than silently replaying incompatible outputs.

## 2. Enforce the plan used by a run

First add a guard before checkpoint metadata or prior run history is overwritten. A checkpoint with a different compiled-plan digest must suspend with a clear reason, preserving its outputs and workspace. Use an outcome the scheduler does not automatically retry; verify that behaviour explicitly.

Then store a versioned, serializable snapshot of the resolved execution plan before the first step. Include resolved instructions, contracts, profiles, transitions, and plan identity; encode and rebuild `Map`/`Set` fields explicitly. Resume from the stored snapshot instead of recompiling current catalog definitions. Validate snapshot schema and integrity before execution. Review which effective settings are currently read outside the plan so configuration changes cannot silently alter a resumed step.

Snapshot semantics do not preserve revoked authority. Apply current permission restrictions and workspace exclusions to the saved plan; block when a run no longer has required permission. Treat changed repository identity or incompatible workspace settings as a reason to stop for review.

For older workflow checkpoints without a snapshot, allow continuation only when the current plan matches the saved identity. Save the matching snapshot before continuing. Missing identity, invalid snapshots, or mismatched plans require an explicit fresh-run decision; never discard uncertain external-action state automatically.

Acceptance checks:

- Unchanged resume reuses the same run, outputs, and worktree.
- Catalog/instruction changes do not mix new instructions with cached old outputs.
- Revoked permissions prevent further actions even with an older snapshot.
- Invalid snapshots and older incompatible checkpoints preserve recoverable state and give a clear explanation.
- New human activity still follows the existing marker rule; already-created remote objects remain discoverable.

## 3. Reconcile interrupted PR and comment actions

Add durable operation records separate from replayed model output. Save an operation intent before invoking an external-effect step. Use stable identities scoped to the run, node, iteration or reporting class, repository, and effect as appropriate. Retain records across checkpoint deletion long enough to reconcile later attempts; define retention separately from run cancellation.

Start with PR creation and tracker comments. Keep model-owned posting and the existing subscription CLI runners. Give the model a stable operation marker and an explicit find-before-create contract. Add read-only reconciliation through the correct project's GitHub/Linear credentials; never use a shared tracker workspace or print keys.

For PRs, identify the repository and head/base branch and verify the matching PR. For comments, use a stable marker in the delivered comment and verify its ticket and author scope. Decide marker format during implementation and keep internal provider/retry details out of customer-facing text.

On recovery, distinguish confirmed completion, confirmed absence, and uncertain completion. Confirmed completion adopts the remote artifact and resumes the remaining step work. Confirmed absence permits an attempt only when the integration can safely establish absence; delayed visibility, lookup failure, or ambiguity keeps the operation suspended. A pending record must not trigger a blind retry. An already-created PR alone does not prove the entire shipping gate passed.

Arbitrary user steps can declare several external effects. Track supported effects individually and suspend unsupported uncertain effects rather than treating a whole step as safely repeatable. The first release covers PRs and comments; deployments and other effects need their own reconciliation rules.

Acceptance checks inject interruption before the request, after simulated remote success but before local save, and after local completion. Also cover failed/ambiguous lookup, multiple repositories, multiple reporting classes, new ticket activity, and no duplicate action on repeated resume. Use durable fake remote state and fresh processes. Do not claim exactly-once delivery from a prompt or operation log alone.

## 4. Make the workflow interpreter the default

Move shared run setup and lifecycle out of the legacy pipeline: record creation, marker handling, images, checkpoint selection, pause/stop handling, finalization, and workspace integration. Keep a small stable `processTicket` entry used by CLI and scheduler. Avoid circular imports between the shared context and interpreter.

Use the compiled built-in workflow for new runs. Preserve existing stage instruction overrides, enabled flags, provider/model choices, repair limits, autonomy, repository settings, and DEV opt-in behaviour through compilation. Preserve support for old run-history records and stage names; removing the legacy executor does not justify removing those formats.

Record executor identity on new checkpoints. Route old legacy checkpoints to the legacy executor until they finish or the user explicitly abandons them. Never convert legacy `stageOutputs` into workflow `nodeOutputs` by guessing. Test changing a project's engine while a checkpoint exists.

Acceptance requires trace comparisons for question/data/change routes, early exits, repair and wait paths, no progress, crash/pause resume, provider selection, multiple repositories, and forbidden paths. Add scheduler checks for stop killing only the target child, checkpoint deletion and no retry, never-process filtering, quota suspension, and configured concurrency. Check dashboard history and workflow assignment in mock mode.

## 5. Remove the legacy pipeline

Remove the hard-coded pipeline and legacy-only prompt/control helpers after supported active legacy checkpoints have drained. Keep shared workspace, provider, quota, permission, artifact, and lifecycle code. Audit references before deleting helpers; some legacy-named stage settings still configure workflow steps.

Update CLI, dashboard, config validation, examples, README, architecture documentation, and AGENTS.md to describe one executor. Accept old configuration with no engine setting as the workflow default. Give explicit `engine: legacy` settings a clear migration message. Preserve historical run readability. If a remaining legacy checkpoint is encountered after removal, refuse safely with recovery guidance rather than rerunning it under a different executor.

Acceptance: one executable pipeline, no legacy routing option for new runs, old configuration and history handled as documented, and all required checks pass. Retain checkpoint migration safeguards until a separately documented format retirement.

## Delivery order

Use separate reviewable changes:

1. Smoke fixture and recovery reproductions.
2. Plan identity guard and saved-plan recovery.
3. Operation records and PR/comment reconciliation.
4. Shared lifecycle extraction and workflow default with legacy checkpoint compatibility.
5. Legacy executor removal and documentation updates after the drain condition is met.

Run type checking and relevant mock checks for each change; run the full `npm run check` before each completed change. No test framework or build step is needed.

Local implementation and mock verification do not change running projects. Switching the live daemon, retiring actual legacy checkpoints, or performing live PR/comment tests requires a separate operational decision. No production deployment is part of this plan.
