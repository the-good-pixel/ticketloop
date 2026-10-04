# ADK workflow evaluation and migration plan

Date: 2026-10-03
Status: evaluated on 2026-10-04; migration deferred. See [evaluation report](adk-workflow-evaluation.md).
Source baseline: Ticketloop `68ebe6f`

## Decision

Evaluate ADK TypeScript as a replacement for workflow execution. Keep the catalog, project policy, scheduler, provider runners, repository controls, and dashboard. Adopt ADK only after a working comparison demonstrates compatible behaviour and a meaningful reduction in custom execution logic.

The long-term target is one executor. A prototype must not become a permanently supported third engine alongside the legacy engine and workflow interpreter.

ADK 2.2.0 is the candidate identified in the research. Pin and verify the exact package version in the prototype. Keep the existing Node/TypeScript/tsx setup; no build step, Python service, cloud service, or change to subscription authentication is planned.

## Proposed boundary

```text
Scheduler / CLI / dashboard
          |
Catalog + project policy -> validated, versioned ExecutionPlan
          |
ADK adapter -> graph routing and execution
          |
Shared Ticketloop step execution
          |
Claude / Codex CLI runners
```

The catalog remains the editable source of truth. Generate ADK graphs from validated plans; do not maintain a second set of hand-authored workflow definitions. Keep the existing tree-based editor and diagram during evaluation.

ADK nodes should call `runAgent` through shared Ticketloop step execution. Do not wrap the entire existing interpreter in one ADK node: that would retain the engine and add a framework without replacing execution logic.

Ticketloop continues to own:

- Workflow versions, immutable plan snapshots, permission validation, and bundle trust reports.
- Worktree creation and reattachment, excluded-path checks, read-only data work, and multi-repository operations.
- Provider selection, subscription authentication, CLI process groups, usage records, and quota suspension.
- Ticket activity markers, scheduler eligibility, never-process marks, and project concurrency limits.
- Result parsing, external-artifact validation, bounded repair attempts, and no-progress detection.
- Dashboard-facing run records, stage records, logs, and outcome meanings.

## Phase 1: Establish the comparison contract

Work in an isolated feature worktree. Read the current repository instructions and rerun the baseline checks before changing runtime code. Do not read or modify the user's real configuration or run state for this phase.

Inspect `engine.ts`, `interpreter.ts`, `checkpoint.ts`, catalog compilation and validation, and daemon cancellation. Record which semantics are shared and which are specific to each engine. The workflow interpreter is the primary comparison target; separately record intentional differences from the legacy engine.

Extend the existing mock smoke approach with reusable scenarios and normalized execution traces. Each trace should include workflow/node identity, iteration, repository, provider invocation count, result, artifact, terminal outcome, and resume behaviour. Normalize timestamps and random IDs without discarding meaningful ordering or identity relationships.

Extract a small shared step-execution interface only where the prototype needs it. Keep prompt construction, runner invocation, workspace checks, quota checks, result parsing, and history recording reusable. Avoid moving graph traversal or repair routing into that interface, because those are the functions ADK is being evaluated to replace.

Deliverable: passing baseline, scenario fixtures, and a documented execution boundary. Existing interpreter behaviour must remain unchanged by any extraction.

## Phase 2: Prove the ADK runtime in isolation

Start with a standalone prototype under `experiments/adk-workflow/`, using its own package manifest and lockfile. Do not add ADK to the shipped runtime dependency set until the adoption gate passes.

Implement a compiler adapter for the subset needed by one representative change workflow: sequence, route selection, repair loop, verification and review gates, simulated shipping, reporting, and terminal outcome. Unsupported constructs must produce explicit diagnostics rather than silently changing behaviour.

Run ordinary function nodes around mock Ticketloop steps. No model API key should be required. A verification failure must follow an explicit repair edge. Keep transient execution retries separate from failed verification and provider quota waits; do not let ADK retries multiply Ticketloop's repair or scheduler retry budgets.

Use fresh temporary `TICKETLOOP_HOME` directories and set mock variables before dynamic imports, as the current smoke scripts do. Both executors must receive independent, equivalent fixtures and reset mock counters. Do not shadow-execute real tickets or duplicate external actions.

Deliverable: the same supported mock workflow running through both executors, with a trace comparison and a list of actual ADK limitations found.

## Phase 3: Prove recovery and safety

Persistence ownership must be settled before adding a selectable ADK engine. Prefer ADK for graph progress and Ticketloop for domain state. Define which record is authoritative at each recovery boundary. Avoid two independently advancing checkpoints that can disagree about whether a step completed.

Test a persistent session implementation through actual process termination and restart. An in-memory pause/resume demonstration is insufficient. Session persistence, state schema versions, storage dependencies, and compatibility with local installation must be included in the evaluation.

Required scenarios:

| Scenario | Required outcome |
| --- | --- |
| Question, data, bug, change, and no-action routes | Same intended stages and terminal results as the current interpreter |
| Verification, review, or shipping failure | Correct repair route; bounded attempts and no-progress handling preserved |
| Pause while a step runs | Current step finishes; subsequent work waits; completed output survives |
| Stop during a step or between steps | Relevant child processes terminate; no subsequent step runs; cancelled work is not automatically retried |
| Daemon process dies | Fresh process recovers completed work and reattaches the correct worktree |
| Provider quota exhausted | Suspends without consuming the repair budget; resumes when eligible |
| New human activity | Old checkpoint cannot silently continue against the changed request |
| Catalog changes during suspension | Resume uses the pinned plan or explicitly refuses; never switches silently |
| Worktree disappears | Cached edits are not treated as present in an empty workspace |
| Replay, rerun, revalidate, idempotent policies | Each policy retains its intended behaviour |
| PR/comment succeeds before completion is persisted | Recovery reconciles external state or stops for review; does not blindly repeat the action |
| Multiple repositories or projects | Correct isolation, artifact aggregation, and configured concurrency limits |
| Missing permission, forbidden path, or production deployment request | Rejected before the prohibited action |
| Imported workflow with untrusted capabilities | Existing trust inspection and explicit acceptance remain effective |

Use mock external systems with durable action journals to simulate a remote action succeeding before the local process crashes. Do not claim exactly-once execution from cached outputs. Any gap in the current interpreter should be recorded separately from ADK regressions and resolved before a live pilot relies on that behaviour.

Deliverable: compatibility report with passing cases, failures, workarounds, and unresolved questions. Any unresolved recovery or safety requirement blocks live adoption.

## Phase 4: Decide whether to adopt

Adopt only when all of the following are demonstrated:

1. The scenario suite passes, including fresh-process recovery and external-action reconciliation.
2. The same CLI runners and subscription authentication work through the adapter without model API calls for orchestration.
3. ADK replaces graph traversal and execution machinery instead of duplicating the interpreter underneath it.
4. A concrete deletion list shows a worthwhile reduction in custom runtime responsibilities after accounting for adapter and persistence code.
5. Installation, startup time, memory use, event volume, and debugging remain acceptable for a local daemon.
6. Workflow edits still use the existing catalog, permissions, preview, and versioning model.

Compare custom runtime code removed versus added, dependency and storage changes, and the work required to diagnose one failed and one resumed run. Code size is evidence, not the sole decision criterion. A smaller adapter that hides fragile recovery behaviour is not a successful result.

If the evaluation fails, keep the existing interpreter and use the new scenario suite to support consolidation away from the legacy engine. Retain the evaluation findings; remove prototype runtime integration rather than carrying an unused third backend.

## Phase 5: Controlled integration, only after adoption

Add an explicit opt-in executor setting, with ADK behind the same validated-plan entry point. Keep the default unchanged during the pilot. Expose executor identity and version in run history and persist them with each run, so configuration changes cannot move an in-flight run between engines.

Pilot in order: mocks, an isolated local fixture repository with a real CLI runner, then a specifically selected project. A live pilot requires explicit scope for tickets and permitted external actions. This plan does not authorize daemon restarts, real tracker writes, deployments, or bulk reprocessing.

Keep existing checkpoints on their original executor until those runs finish. Do not attempt automatic checkpoint conversion in the first migration. Rollback changes the executor for new runs; in-flight ADK runs must remain recoverable on ADK or be explicitly stopped and reconciled before a fresh run starts elsewhere.

Once compatibility and pilot results are accepted, move new runs to the chosen executor, drain older runs, and remove obsolete execution paths. Preserve the scheduler, catalog contracts, safety controls, and history compatibility throughout consolidation.

## Verification and deliverables

- Run `npm run check` after extraction and runtime changes; it includes type checking, dashboard syntax checks, and existing smoke scripts.
- Add focused ad-hoc TypeScript scenarios using Node assertions; no new test framework or build step.
- Keep all mock state isolated and clean up temporary fixtures.
- Deliver the prototype, reproducible scenario commands, comparison report, adoption decision, and a concrete deletion/rollback plan.

The first implementation milestone is Phases 1–3. Broad migration should not start before the Phase 4 decision.

## Research references

Checked during the initial assessment on 2026-10-03:

- [ADK 2.0 and language availability](https://adk.dev/2.0/)
- [TypeScript release history](https://github.com/google/adk-js/releases)
- [Graph workflows](https://adk.dev/graphs/) and [routing](https://adk.dev/graphs/routes/)
- [TypeScript node configuration at 2.2.0](https://github.com/google/adk-js/blob/adk-v2.2.0/core/src/workflow/base_node.ts)
- [Database session implementation at 2.2.0](https://github.com/google/adk-js/blob/adk-v2.2.0/core/src/sessions/database_session_service.ts)
- [Human-input suspension](https://adk.dev/graphs/human-input/) and [cancellation](https://adk.dev/runtime/cancel/)
- [Claude integration](https://adk.dev/agents/models/anthropic/): documented model access is not a replacement for Ticketloop's subscription CLI runner.
- [Visual Builder](https://adk.dev/visual-builder/): documented as experimental and Python-specific; replacing Ticketloop's editor is outside this plan.
