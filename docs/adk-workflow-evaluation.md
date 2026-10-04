# ADK TypeScript evaluation

Date: 2026-10-04
Ticketloop baseline: `68ebe6f`
Candidate: `@google/adk` 2.2.0, SQLite driver `@mikro-orm/sqlite` 7.2.0
Environment: macOS, Node 26.8.1
Decision: defer migration; keep the current workflow interpreter.

## Historical context

This report records the tested release and source baseline above. The recovery
findings later led to the fixes and live pilots documented in
[live-pilot-results.md](live-pilot-results.md); those fixes are now merged into main.
The executable prototype is archived at commit `79fa460` on
`experiment/adk-evaluation`. Its runtime changes and ADK dependencies are not part
of main. The original evaluation worktree has been removed.

## Result

ADK can execute Ticketloop's deterministic workflows through ordinary function nodes and the existing provider runner. The prototype matched the current interpreter in 17 mock scenarios. However, native TypeScript recovery did not meet Ticketloop's required behaviour, and the prototype has not demonstrated enough code reduction to justify the added framework and persistence dependencies.

The plan's adoption gate failed. No live pilot or runtime integration is recommended. The next maintenance work should strengthen the existing workflow executor and then consolidate execution onto one engine.

This evaluation is evidence for the tested TypeScript release and API path. It is not a claim that every ADK language or lower-level execution API has the same limitations.

## What was built

The archived experiment branch contains the private prototype with its own pinned dependency lockfile. The shipped package's dependencies and configuration are unchanged.

`adapter.ts` translates a validated `ExecutionPlan` into actual ADK nodes and conditional edges. It implements branches, bounded repair iterations, later shipping failures returning to repair, no-progress handling, and terminal signals. Repair iterations are expanded into graph nodes; the adapter targets the built-in `standard@2` workflow used by the comparison scenarios, not unrestricted user-defined workflows.

A small callback seam in `runWorkflow` allows the experiment to reuse step execution, prompt construction, result parsing, workspace controls, quota handling, artifact validation, reporting, and run records. ADK does not call the current tree walker. The experiment is not exposed as a configurable engine, and no existing project is switched to ADK.

The graph comparison intentionally retains Ticketloop checkpoints as authoritative and starts a new in-memory ADK session on each attempt. Native ADK persistent recovery is evaluated separately with SQLite. Passing comparison scenarios therefore does not mean ADK has replaced Ticketloop's checkpoint machinery.

All coding-agent runs used mocks. The quota-denial probe stopped before any runner invocation. Cancellation probes used disposable ordinary Node child processes. No model API calls, subscription inference, real tracker writes, PR writes, daemon restarts, or deployments were performed.

## Execution comparison

Each scenario ran in independent temporary state and a separate process for each executor. Traces compare stage ordering, status, invocation versus replay, verdict text, normalized output, artifacts, PR/comment references, and terminal outcomes. Temporary paths are normalized; meaningful output and order are retained.

All 17 scenarios matched:

| Scenarios | Result |
| --- | --- |
| Question, data export, bug, change | Matching traces and outcomes |
| No action, ineligible | Matching early exits |
| Verification, review, shipping failure | Matching repair and gate ordering |
| Shipping wait, DEV deployment wait | Matching suspension and resumed outcomes |
| Repeated identical findings | Matching no-progress termination |
| Pause/resume, shipping error/resume | Matching Ticketloop checkpoint replay |
| Codex selection | Same mock provider path |
| Multiple repositories | Matching per-repository shipping and artifacts |
| Forbidden path | Matching blocked outcome |

The DEV scenario used simulated deployment text only. Claude/Codex parity here proves mock runner integration; real subscription authentication and live CLI performance were not exercised.

A separate quota probe passed through both executors: denied work suspended before any runner call and resumed in mock mode without changing the repair budget.

## Native persistent recovery

Each probe opens ADK's SQLite session service in one process and reopens the same database in a fresh process. Crash probes use SIGKILL on the disposable worker. The test ensures preparation has been persisted before killing the process, and records simulated external actions in a separate durable journal.

| Interruption | Preparation calls across both processes | Simulated external-action calls | Finding |
| --- | ---: | ---: | --- |
| Explicit human-input pause | 1 | 0 | Correctly resumes after the approval node |
| Hard crash after committed preparation | 2 | 1 | Completed preparation repeats |
| Unhandled node error after preparation | 2 | 1 | Completed preparation repeats |
| Hard crash after external action, before action output | 2 | 2 | External action repeats |
| Same crash with custom reconciliation | 2 | 1 | Ticketloop-style reconciliation prevents the duplicate action |

These use the public TypeScript `Runner.runAsync` path with `resumabilityConfig.isResumable: true`. The runner creates a new invocation; graph rehydration includes prior turns recognized as paused. The tested unplanned interruptions did not resume from completed graph outputs through that API path. The runner does not expose an invocation ID parameter in this release's TypeScript interface.

The remote-action journal is a controlled reproduction of an uncertain-completion window, not a real tracker or GitHub integration. It demonstrates the need for domain-level reconciliation; it does not establish exactly-once guarantees for either framework.

Source pointers: [Runner](https://github.com/google/adk-js/blob/adk-v2.2.0/core/src/runner/runner.ts), [graph rehydration](https://github.com/google/adk-js/blob/adk-v2.2.0/core/src/workflow/utils/rehydration_utils.ts).

## Other native node probes

Five observations were reproduced:

- Completed static-graph nodes marked `rerunOnResume: true` did not re-execute after human-input resume. Replay, rerun, revalidate, and idempotent counters were all 1. Ticketloop's rerun/revalidate policies need explicit handling. This finding concerns completed nodes in the tested static graph; it does not establish how every dynamic workflow behaves.
- Configured transient retries completed on the third attempt, as requested.
- A cooperative node timeout prevented the downstream step from running.
- Aborting a workflow left an ordinary spawned child alive when the node did not bridge cancellation to child termination. The test cleaned up the child itself; uncooperative work also delayed completion of the cancelled invocation.
- Bridging the node's abort signal to Ticketloop's `killChildrenFor` stopped the target child process group and left another ticket's child alive.

In the released static workflow implementation, completed prior outputs are fast-forwarded before checking `rerunOnResume`. The class also emits an experimental warning at runtime. Those details warrant caution even though ADK 2.x itself is released.

Source pointer: [Workflow](https://github.com/google/adk-js/blob/adk-v2.2.0/core/src/workflow/workflow.ts).

## Existing Ticketloop findings

These findings are separate from ADK incompatibilities:

1. The original `npm run check` failed during data export because MockRepo did not create the worktree directory needed by the file-writing mock. The isolated smoke fixture now creates the directory, reports the declared CSV as the mock change, and uses a canonical temporary path on macOS. The full check passes after that test-fixture correction. No production MockRepo or file guard was changed.
2. A paused workflow accepted a changed compiled-plan digest while replaying outputs from the previous plan. The current entry recompiles the live plan and the interpreter overwrites checkpoint plan metadata without enforcing the prior digest. The comments describe stronger snapshot behaviour than the tested implementation provides. Fix plan snapshot enforcement or explicitly block changed plans before relying on the documented recovery rule.
3. The external-action crash window also remains a Ticketloop responsibility. The existing idempotent path skips already-cached outputs, which does not cover a remote action succeeding before its output is saved. A durable operation record and external-state reconciliation are needed before claiming duplicate prevention across that window.

Other retained controls passed focused checks: new human activity invalidates a checkpoint at the shared engine entry; explicitly denied PR permission blocks before execution; bundle inspection includes permissions and effects of locally referenced steps; checksum tampering is detected; workspace reattachment detects a missing `.git` worktree marker; built-in deployment steps declare DEV-only capability.

The workspace result is a helper check, not a full real-repository recovery test. Scheduler concurrency, never-process eligibility, dashboard operation, and a full stop/delete-checkpoint/no-retry daemon sequence were not changed or exercised by the prototype. Their complete compatibility remains unproven. Broader live testing was stopped after the adoption gate failed.

## Maintenance and runtime cost

The existing graph traversal and repair-loop section is approximately 145 lines. The prototype graph adapter is 123 lines, and the shared execution seam adds 29 net lines. That leaves little demonstrated reduction before adding durable recovery, external-action reconciliation, configuration, history adaptation, and an ADK upgrade policy. The adapter still contains Ticketloop-specific repair budgets and no-progress semantics.

Most of the 886-line interpreter handles domain execution and recovery responsibilities that the prototype reuses. ADK does not remove the catalog/compiler, scheduler, CLI runners, quota governor, worktrees, permission/trust validation, or dashboard. No net maintenance reduction has been demonstrated.

Measured on this machine:

| Measurement | Current project / executor | ADK experiment / SDK |
| --- | ---: | ---: |
| Package-lock entries, excluding root | 33 | 201 |
| Installed `node_modules` size, including development tools | 38 MiB approximately | 188 MiB approximately |
| Median module import time, 5 fresh processes | 40.1 ms | 610.0 ms |
| Median process resident memory after import | 63.5 MiB | 156.9 MiB |

The import comparison loads the current interpreter versus the ADK SDK alone. An integrated executor would load Ticketloop and ADK together, so these are not full daemon overhead measurements. Filesystem cache, Node version, optional packages, and development tools affect the measurements. Package-lock counts include optional platform packages rather than only packages installed on this machine.

The extra startup time is small compared with a coding-agent task. Dependency maintenance and retained recovery code matter more to the decision. The pinned SQLite driver also requires Node >=22.17, above Ticketloop's declared >=22.0 floor.

## Recommendation and next work

Keep the existing workflow interpreter. Do not add ADK to the shipped runtime or introduce an ADK engine setting from this experiment.

The next useful work is:

1. Enforce the saved plan identity during resume, either by loading an immutable snapshot or refusing changed plans.
2. Add durable records and reconciliation for uncertain external-action completion, starting with PR creation and tracker comments.
3. Extend the regression suite around those recovery boundaries, then move projects to the workflow interpreter and drain legacy runs before removing the legacy engine.

Reconsider ADK when a tested TypeScript release supports the required crash-resume and completed-node rerun behaviour through a supported API, or when Ticketloop needs capabilities such as broad parallel agent orchestration that justify the additional framework. Re-run the pinned reproductions rather than assuming an upstream upgrade fixes the observed cases.

## Reproduction and evidence

Recreate an isolated checkout of the archived prototype:

```sh
git fetch origin
git worktree add --detach ../ticketloop-adk-repro 79fa460
cd ../ticketloop-adk-repro
npm ci
npm run check
cd experiments/adk-workflow
npm ci
npm run typecheck
npm run evaluate
```

`npm run evaluate` runs the 17 paired scenarios, in-memory human-input check, five persistent recovery probes, five node probes, seven domain observations, and import measurements. An exit code of zero means the assertions reproduced the documented observations, including known incompatibilities. It does not mean the migration gate passed.

The suite writes full normalized traces to `experiments/adk-workflow/results.json` (generated and ignored). A compact retained snapshot is [adk-evaluation-evidence.json](adk-evaluation-evidence.json). Review the executable probes alongside that snapshot.

Checks completed: project `npm run check`, experiment type checking, the complete evaluation command, and whitespace validation. All disposable child processes and temporary state used by the final runs were cleaned up.
