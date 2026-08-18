# Design — Step Catalog & Workflow Manager

> **Status: IMPLEMENTED (phases 1–7).** Phase 0 is the only outstanding item. The
> interpreter runs opt-in per project (`engine: workflow`); the legacy engine remains the
> default until the new path has been exercised against real repos. See §18 for what exists and §19 for the migration position.
> This document describes how
> ticketloop can move from one hard-coded pipeline to reusable catalog steps and
> user-defined workflows without weakening checkpoints, provider handling, git isolation,
> tracker isolation, or deployment safety.

## 1. Goal

Today users can configure the provider, model, effort, tools, skill, and instruction for
each stage, but `engine.ts` still owns the pipeline shape. The next version should provide:

1. **Step catalog** — reusable, versioned definitions for one unit of agent work.
2. **Workflow manager** — structured sequences, branches, bounded repair loops, waits,
   and final reporting composed from catalog steps.

The pipeline becomes data. The engine becomes an interpreter of a validated execution
plan. The harness continues to own scheduling, checkpoints, worktrees, guardrails,
credentials, provider waits, and durable run history. The model still owns how each step
does its work.

## 2. Design principles

- **Structured control flow, not a free graph.** Sequence, branch, and bounded loop cover
  the intended use cases and remain statically validatable.
- **A failed gate does not always mean repair the code.** Repair, stop, suspend, skip, and
  continue are separate transitions.
- **Side effects are explicit.** Git, PR, tracker, merge, and deployment actions declare
  their required project permissions.
- **Resume is deterministic.** A run normally resumes against its saved workflow snapshot.
- **Steps are reusable; nodes are unique.** A workflow can use the same catalog step more
  than once without checkpoint collisions.
- **External state must be revalidated.** PR and deployment results cannot be treated like
  immutable planning text.
- **Final reporting is dependable.** A workflow can report success, waiting, partial work,
  or failure without accidentally skipping the comment step.
- **Existing projects keep working.** No workflow assignment means the built-in standard
  workflow, with existing `stages` overrides honored during migration.

## 3. Core concepts

### 3.1 Catalog step

A catalog step is an immutable, versioned instruction and execution definition. Editing
a published version creates a new version.

```yaml
# ~/.ticketloop/catalog/steps/browser-verify/3.yml
id: browser-verify
version: 3
name: Browser verify
description: Exercise the affected flow in a real browser.

instruction: >-
  Start the application and verify the affected flow in a browser. Report concrete
  evidence and end with the required verdict.

defaults:
  executionProfile: quality
  effort: medium
  allowedTools: Read,Edit,Bash

contract:
  type: verdict                 # verdict | route | post | artifact | text

capabilities:
  workspace: change             # checkout | change | read-only | none
  mutatesRepo: false
  perRepo: false
  devOnly: false
  externalEffects: []

resumePolicy: rerun             # replay | rerun | revalidate | idempotent
consumes:
  - plan
  - fix
produces:
  key: browserVerification
  type: text
```

Step definitions should avoid hard-pinning a provider where possible. A project maps an
execution profile such as `fast`, `balanced`, or `quality` to a provider/model/effort.
A step or workflow node may still override the profile when a specific model is required.

Provider-specific skills can be mapped without duplicating the step:

```yaml
skills:
  claude: agent-browser
  codex: agent-browser
```

### 3.2 Contracts

Contracts describe the machine-readable result the harness expects:

| contract | harness behavior |
|---|---|
| `text` | Store plain model output. |
| `route` | Parse a named routing field such as `KIND`. |
| `verdict` | Append and parse `VERDICT: pass\|fail\|wait\|skip`. |
| `post` | Inject the project tracker key and parse `COMMENT_URL`. |
| `artifact` | Parse a typed external artifact such as a PR or deployment. |

Contracts replace name-based sets such as `VERDICT_STAGES` and `POST_STAGES`.

### 3.3 Capabilities and effects

One enumerated `role` is too restrictive because a ship step is simultaneously a gate,
a per-repository operation, and a producer of external artifacts. Composable fields are
clearer:

- `workspace`: where and how the step runs.
- `mutatesRepo`: whether changes are allowed.
- `perRepo`: once, every repo, or changed repos only.
- `devOnly`: hard-pin the operation to DEV/preview.
- `externalEffects`: tracker comment, create PR, merge PR, create release PR, deploy DEV.
- `resumePolicy`: how to handle a completed or interrupted node.

Imported steps may request capabilities, but only project policy can grant authority.

### 3.4 Workflow and nodes

A workflow is an immutable, versioned list of structured phases. Every node has a stable,
workflow-unique `id`, separate from its catalog step ID.

```yaml
id: standard-change
version: 6
name: Standard change workflow

phases:
  - id: triage-ticket
    step: triage@2

  - id: route-ticket
    branch:
      on: triage-ticket.KIND
      default: stop-unsupported
      cases:
        question:
          - { id: answer, step: clarify@2 }
        data:
          - { id: data-plan, step: plan@3 }
          - { id: data-export, step: export@2 }
        change:
          - { id: locate-pr, step: locate@2 }
          - { id: change-plan, step: plan@3 }
          - { id: prepare-workspace, step: prepare@2 }
          - loop:
              id: code-loop
              repair: { id: implement, step: fix@4 }
              gates:
                - id: local-verify
                  step: verify@4
                  on: { pass: next, fail: repair }
                - id: code-review
                  step: review@3
                  on: { pass: exit-loop, fail: repair }
              maxIterations: 5
              noProgress: stop
          - id: ship-pr
            step: ship@4
            on: { pass: next, fail: code-loop.repair, wait: suspend }
          - id: deploy-dev
            step: deploy-dev@3
            on: { pass: next, fail: stop, wait: suspend }
          - id: verify-live-dev
            step: browser-verify@3
            on: { pass: next, fail: stop, wait: suspend }

finally:
  - id: report-ticket
    step: comment@3
    runOn: [success, partial, waiting, failed]

outcomes:
  success: deployed
  waiting: waiting
  partial: pr-opened-with-findings
  failed: failed
```

Ship and deployment are intentionally outside the code repair loop. After a PR is opened
or merged, an external failure must not blindly send execution to a clean `fix` step.

## 4. Step results and transitions

A verdict node can return four model-level results:

- `pass` — the node succeeded.
- `fail` — the node completed and found a problem.
- `wait` — external or human action is required before the node can succeed.
- `skip` — the node is not applicable.

Each workflow node maps those results to transitions:

- `next`
- `repair`
- `<loop-id>.repair`
- `suspend`
- `stop`
- `continue`

Provider quota exhaustion is a harness event, not a model verdict. It always suspends the
current node with `outcome: waiting` and `blocker.kind: provider`, then keeps the checkpoint.

Typical policies:

| node | pass | fail | wait |
|---|---|---|---|
| local verify | next | repair | suspend |
| review | exit loop | repair | suspend |
| ship | next | repair or stop | suspend |
| deploy DEV | next | stop | suspend |
| verify DEV | next | stop or repair, explicitly chosen | suspend |
| comment | finish | retry/stop | suspend |

The validator rejects undefined transitions or `repair` transitions outside a loop.

## 5. Suspension and waiting

Waiting is neither failure nor pause. It means the workflow cannot proceed until a known
external condition changes.

There is one runtime outcome: `waiting`. The reason is structured separately:

```yaml
outcome: waiting
blocker:
  kind: provider | approval | deployment | external
  reason: GitHub Actions returned HTTP 429
  resume: automatic | manual
  resumeAt: 1787043600000 # optional epoch milliseconds
```

Model verdicts name the blocker explicitly (`VERDICT: wait[approval] — <reason>`,
`wait[deployment]`, or `wait[external]`). Provider waits come from the harness, never from
free-form model text. This keeps lifecycle state stable without guessing from prose.

A waiting run:

1. Saves the current node, resolved workflow snapshot, artifacts, and workspace.
2. Releases the project execution slot.
3. Stores the structured blocker, optional `resumeAt`, and the responsible provider or artifact.
4. May execute `finally` nodes configured for `waiting` to post an interim update.
5. Resumes at the waiting node and follows its `resumePolicy`.

The dashboard should show the required action and offer Resume and Restart Fresh. The
scheduler may automatically retry when a provider reset time or external polling time is
known.

## 6. Project permissions

Merge and deployment authority must be structured policy, not prompt wording alone.

```yaml
projects:
  - name: miles-loyalty
    permissions:
      createFeaturePr: true
      mergeFeaturePr: false
      createDevReleasePr: true
      mergeDevReleasePr: false
      deployDev: false
      deployProduction: false
```

A step declares the permissions it requires:

```yaml
requiresPermissions:
  - createDevReleasePr
  - mergeDevReleasePr
  - deployDev
```

Rules:

- Project policy is the maximum authority a workflow can use.
- Catalog imports cannot grant authority.
- DEV permission never implies staging or production permission.
- Production deployment remains unsupported unless a future explicit product decision
  adds it.
- Validation reports permission conflicts before a workflow is assigned.
- Runtime checks enforce permissions even if a model instruction asks for more.

## 7. Artifacts and typed outputs

Step outputs should not rely only on free text. Important external state is recorded as
typed artifacts:

```yaml
artifacts:
  featurePr:
    type: github-pr
    repo: the-good-pixel/miles-loyalty
    number: 602
    url: https://github.com/the-good-pixel/miles-loyalty/pull/602
    state: open
  devDeployment:
    type: deployment
    environment: dev
    status: pending
    approvalRequired: true
```

Artifacts are available to later nodes and final reporting. A `revalidate` step refreshes
artifact state from the external system before deciding whether to rerun model work.

## 8. Checkpoints, versioning, and resume

### 8.1 Stable checkpoint keys

Catalog step IDs are not unique inside a workflow. Checkpoint keys use node identity:

```text
<workflow-id>@<version>/<node-id>/<iteration>/<repo?>
```

### 8.2 Workflow snapshot

At run creation, ticketloop stores:

- Workflow ID, version, and digest.
- Fully resolved node definitions and step versions.
- Project execution profiles and permission policy relevant to the run.
- Current node and branch path.
- Typed outputs and artifacts.
- Loop counters and no-progress signatures.
- Workspace descriptor and downloaded attachments.

Normal **Resume** uses the saved snapshot. **Restart Fresh** uses the latest assigned
workflow. An optional advanced action, **Resume with Current Workflow**, may be added
later, but must validate compatibility and show the user what changed.

Provider/model execution overrides may be changed for an uncompleted node without
changing graph semantics, but the override is recorded in run history.

### 8.3 Resume policies

- `replay` — reuse cached output. Suitable for plan or classification.
- `rerun` — invoke the step again. Suitable for local verification.
- `revalidate` — refresh external artifacts, then return or rerun. Suitable for PR and
  deployment nodes.
- `idempotent` — rerun with a stable operation key. Suitable for tracker comments and
  external mutations that support deduplication.

## 9. Final reporting and outcome mapping

Workflows may define a `finally` sequence. A final node receives the terminal reason,
completed outputs, artifacts, waiting action, and failures.

`runOn` controls when it runs:

- `success`
- `partial`
- `waiting`
- `failed`

The workflow maps terminal paths to durable ticketloop outcomes. The interpreter should
not infer “deployed” merely because a step was enabled; it requires a successful typed
deployment artifact and, when configured, successful DEV verification.

Safety exceptions may bypass model reporting only when continuing would be unsafe. The
harness should still preserve a clear local run status.

## 10. Catalog scopes, storage, and sharing

Resolution order, with later scopes overriding earlier defaults:

1. Built-in catalog shipped with ticketloop.
2. Imported team bundle.
3. User catalog under `~/.ticketloop/catalog`.
4. Project node overrides.

Storage remains YAML-first:

```text
~/.ticketloop/catalog/
  steps/<id>/<version>.yml
  workflows/<id>/<version>.yml
  imports/<bundle-id>/manifest.yml
```

Start sharing with validated YAML bundle export/import. A git-backed registry can follow
after local semantics and signature/trust rules are stable.

## 11. Validation and compilation

Workflows are compiled into an immutable execution plan before assignment. Validation
must reject:

- Duplicate or missing node IDs.
- Missing or mutable step versions.
- Invalid provider/model/effort combinations.
- Undefined output or artifact references.
- Branches without a matching case or explicit default.
- Consumers whose producers are absent on a reachable path.
- Unbounded loops or invalid repair targets.
- Side-effecting steps in unsafe repair loops.
- `verify-dev` without a reachable deployment artifact.
- A post step without tracker credentials.
- Permission requirements not granted by project policy.
- DEV-only steps targeting another environment.
- Incompatible workspace requirements.
- Terminal paths without outcome mapping.
- A reachable path that unexpectedly bypasses required final reporting.

The compiler should also emit warnings for expensive or suspicious plans, such as repeated
full verification, the same side-effecting step used twice, or a model pinned to a provider
that is not authenticated.

## 12. Backward compatibility

- Ship a built-in `standard` workflow matching current behavior where current behavior is
  correct.
- Deliberately fix known bad behavior rather than preserving it for parity:
  - Provider quota suspends instead of failing.
  - Manual deployment waits instead of returning to fix.
  - A clean worktree after shipping is not treated as “fix produced no changes.”
  - Valid final output followed by an abnormal CLI exit is classified using a documented
    provider policy instead of automatically losing the result.
  - Final reporting can run on success, partial completion, waiting, and failure.
- Existing global and project `stages` blocks remain supported during a deprecation window.
  They compile to node overrides on the built-in workflow.
- No project-level `workflow` means `standard`.
- Migration writes no catalog files until the user explicitly saves or clones a workflow.

## 13. Testing strategy

There is no unit test framework today, so implementation should add focused `tsx` scenario
scripts or introduce a small test runner only if the project explicitly chooses to.

Required trace tests:

- Question, data, change, and bug paths.
- Every verdict transition: pass, fail, wait, skip.
- Failure and crash at every node boundary.
- Provider quota wait with mixed providers.
- Manual deployment wait and later resume.
- Resume after a PR is merged externally.
- Resume after the computer sleeps during a subprocess.
- Successful final output followed by abnormal CLI exit.
- Comment deduplication across retries.
- Multi-repository partial shipping.
- Workflow snapshot resume after the live catalog changes.
- Restart Fresh under a newer workflow version.
- Permission rejection for imported steps.
- Cleanup behavior for success, wait, failure, and blocked paths.

The standard workflow must have a golden trace for each route and failure point. Compare
node sequence, artifacts, outcomes, checkpoint state, and side effects—not only final text.

## 14. Implementation roadmap

### Phase 0 — Fix runtime semantics in the current engine

Before building the interpreter, add the concepts the new runtime will depend on:

- Waiting outcomes and checkpoint retention.
- Distinguish repairable gate failures from external waits.
- Prevent post-ship clean worktrees from becoming false failures.
- Reliable final-output versus process-exit classification.
- Final reporting for partial and waiting outcomes.

These changes improve the existing product immediately and prevent encoding current bugs
into the new standard workflow.

### Phase 1 — Runtime types and policy

- Result and transition types.
- Suspension records.
- Typed artifacts.
- Resume policies.
- Structured project permissions.
- Execution profiles.

No workflow interpreter yet.

### Phase 2 — Catalog schemas, compiler, and validator

- YAML schemas and immutable storage.
- Built-in steps and workflow definitions.
- Stable node IDs and digests.
- Workflow compiler and validation diagnostics.
- CLI commands to validate and inspect compiled plans.

### Phase 3 — Standard workflow expressed as data

- Compile the built-in standard workflow.
- Produce golden traces beside the existing engine.
- Resolve intended differences from Phase 0 explicitly.
- Do not switch production execution yet.

### Phase 4 — Interpreter behind a feature flag

- Execute one selected project through the new interpreter.
- Keep the legacy engine available.
- Exercise crash, resume, waiting, mixed-provider, and multi-repo cases.
- Expand only after trace parity and intended differences are verified.

### Phase 5 — Catalog CLI and dashboard

- Browse, clone, create, edit, validate, version, import, and export steps.
- Show effective provider profile and required permissions.
- Protect built-in and published versions from in-place edits.

### Phase 6 — Workflow builder

- Compose sequences, branches, bounded loops, transitions, and `finally` nodes.
- Validate continuously in the UI.
- Preview the compiled execution trace and required permissions.
- Assign a workflow version to a project.

### Phase 7 — Sharing

- Signed or checksummed export/import bundles.
- Trust warnings for external effects and skills.
- Optional git-backed registry after the local model is proven.

## 15. Product decisions

Recommended decisions:

- **A. Control flow:** structured phases—sequence, branch, bounded loop.
- **B. Step behavior:** composable contracts and capabilities, not one exclusive role.
- **C. Branch source:** typed output from any step.
- **D. Versioning:** immutable, pinned versions.
- **E. Sharing:** local bundle export/import first.
- **F. Storage:** YAML-first.
- **G. Transitions:** explicit pass/fail/wait/skip mapping per node.
- **H. Resume:** saved workflow snapshot by default.
- **I. Authority:** structured project permissions enforced by the harness.
- **J. Final reporting:** `finally` nodes with explicit `runOn` conditions.
- **K. External state:** typed artifacts plus revalidation.

## 16. Main risks

- **Interpreter correctness.** Mitigate with Phase 0 semantics, compilation, feature flags,
  and golden execution traces.
- **Unsafe authority through imported workflows.** Project policy must remain the hard
  runtime boundary.
- **Resume incompatibility.** Snapshot the resolved plan and use stable node IDs.
- **Duplicate external actions.** Use artifact revalidation and idempotency keys.
- **Builder complexity.** Expose the structured phase model, not arbitrary edges, and ship
  strong built-in templates.
- **Over-configuration.** Keep the standard workflow excellent and customization optional.
- **Catalog trust.** Show skills, tools, external effects, and permissions before import or
  assignment.

## 17. Definition of ready for implementation

Implementation should not start until:

1. Decisions A–K are accepted or revised.
2. The standard workflow and its terminal outcomes are written completely, without `…`.
3. Project permission defaults are agreed.
4. Waiting and resume behavior is specified for ship, deployment, verification, and post.
5. Golden traces cover the current routes and the MRM-187/MRM-190 failure cases.
6. Phase 0 has a separately approved implementation plan.

## 18. Implementation status

| Phase | State |
|---|---|
| 0 — runtime semantics in the current engine | not started (needs its own approved plan) |
| 1 — runtime types and policy | **done** — `src/catalog/types.ts`, plus `permissions` / `executionProfiles` / `workflow` on config |
| 2 — catalog schemas, compiler, validator | **done** — `store.ts`, `compile.ts`, `validate.ts`, and the `steps` / `workflows` / `workflow show` / `workflow validate` / `catalog clone` CLI |
| 3 — standard workflow expressed as data | **done** — `builtin-steps.ts` (15 steps) + `builtin-workflows.ts` (`standard@1`/`@2` retained for history; `standard@3` adds cleanup), compiling and validating clean |
| 4 — interpreter behind a feature flag | **done** — `src/loop/interpreter.ts`, opt-in per project via `engine: workflow` |
| 5 — catalog CLI and dashboard | **done** — Workflows view: browse steps/workflows, compiled-plan preview per project, effective profile + required permissions, built-ins protected |
| 6 — workflow builder | **done** — SVG diagram of the compiled plan (foldable branch cases, fit-to-pane zoom); clone to draft, then edit a node's step/transitions/instruction, a loop's bounds, and the structure itself (move, insert, remove, add gate); continuous validation; save as a new version; assign to a project |
| 7 — sharing | **done** — checksummed bundle export/import with a trust report; import is inspect-then-accept |

The interpreter is opt-in: a project sets `engine: workflow` to run its assigned workflow
as data. Everything else keeps using `engine.ts`. Both share one copy of the git
isolation and off-limits guardrail (`src/loop/workspace.ts`), the run record, the
checkpoint, the marker and the downloaded attachments.

Verified against the legacy engine on the demo tickets: all four routes (question, data,
change, bug) produce an identical step sequence and an identical outcome. Also verified:
the repair loop, a failed ship re-entering the loop from outside it, crash-and-resume on
the same run record, pause at a node boundary, and the off-limits guardrail blocking
before ship.

Two deliberate differences from today are already encoded in `standard@1`, per §12:

- A failed or pending **deploy-dev / verify-dev** stops or suspends instead of routing
  back to a clean `fix`. The PR is already open; a queued deployment is not a code defect.
- **Final reporting runs on waiting and failure**, not only on success, so a ticket is
  never left silent. The question path marks its terminal `reported` so `clarify` and the
  `finally` comment can never double-post.

Resume policy is now per step rather than "replay everything": `triage`/`plan`/`fix`
replay from cache, `verify`/`review`/`prepare` re-run (a cached pass is not evidence the
tree still builds), `locate`/`ship`/`deploy-dev` revalidate, and `comment` is idempotent —
keyed by terminal class, so a run that reported failure and then resumed to success
reports the success too.

Execution profiles deliberately resolve to today's effort levels (`quality` → `medium`)
so a compiled `standard@1` is a faithful trace of current behavior. Raise `quality` per
project once the interpreter lands and trace parity has been checked.

## 19. Migration position

The seeding answer: **what ticketloop does today IS the catalog.** Built-in steps import
their instruction text from `DEFAULT_INSTRUCTIONS` in `config.ts`, so the shipped catalog
and the running engine cannot drift, and a new user starts from a working pipeline rather
than a blank one.

What needs migrating, and what does not:

- **Config** — automatic (`version: 3 → 4`). `permissions.createFeaturePr` defaults to
  true because opening a PR is what the loop has always done. A project whose `stages`
  already enables `deploy-dev` is granted `deployDev: true`, so an existing deploying
  project keeps working instead of failing validation on an authority it implicitly had.
  Merge and production authority stay denied.
- **`stages` blocks** — no migration. They compile to node overrides on every node that
  uses that step, on every branch path, which is exactly what they meant when the pipeline
  was hard-coded. They stay supported through a deprecation window.
- **Run history (`runs.jsonl`)** — no migration. `StageRecord.stage` stays a stage name
  while the engine owns execution. When the interpreter lands, `StageRecord` gains an
  optional `nodeId`; old records simply lack it and the dashboard falls back to the stage
  name.
- **Checkpoints** — no migration, and none is wanted. Keys move from `fix#2` to
  `standard@1/change-implement/2`. An in-flight checkpoint written by the old engine will
  not match the new keys, so it replays nothing and the ticket re-runs from the start.
  That is the correct behavior for a cutover: cut over when no ticket is mid-run, or
  accept one re-run per in-flight ticket. Do **not** write a key translator — it would
  have to guess which branch path a stage name belonged to.
- **User catalog files** — nothing exists yet, so there is nothing to migrate. Built-in
  versions are immutable and a user file that shadows one is rejected at load time, which
  keeps every run snapshot meaningful for as long as the run lives.

## 20. Sharing and trust

Bundles are plain YAML with a sha256 over their canonical contents. Import is deliberately
two steps — inspect, then accept — because a step's instruction is handed to a coding agent
running with permissions skipped.

The trust report is built from the bundle's own declarations AND from the local steps a
bundled workflow references. A workflow made entirely of built-in steps still ships PRs and
deploys, so reporting "nothing beyond reading" because the bundle carried no step
definitions would be exactly the wrong answer.

Hard refusals: a checksum that does not match the contents, anything that would shadow a
built-in version, and a workflow whose steps are neither bundled nor already installed.

Importing never grants authority. A step may *request* `deployDev`; only the project's own
permissions block grants it, and validation still refuses to run a plan whose steps ask for
more than the project allows.

## 21. What is left

- **Phase 0** — the legacy engine still mis-handles `wait` (it fails open and can report a
  queued deployment as live). That matters only while `engine: legacy` is the default.
- **Real-world exercise.** Everything so far is verified against the mock runner. No ticket
  has run through the interpreter against a real repo and a real model.
- **`revalidate` is currently a re-run.** The `Repo` interface has no PR-state read, so a
  resumed ship re-runs the step (its instruction already handles "PR exists → push to it")
  instead of querying GitHub. Adding `prState()` to `Repo` would close the gap.
- **Branch cases are not editable in the builder.** Nodes can be moved, inserted and
  removed, and loops can gain gates, but adding or renaming a branch case still means
  editing the YAML under `~/.ticketloop/catalog/`.
