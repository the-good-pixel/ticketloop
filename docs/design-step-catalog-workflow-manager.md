# Design — Step Catalog & Workflow Manager

> **Status: DESIGN ONLY — no implementation.** This proposes how to evolve ticketloop
> from a single hard-coded pipeline into a system where users curate **reusable steps**
> and compose their **own workflows**. It lays out the data model, the engine changes,
> backward-compat, a phased roadmap, and the open decisions that need your call.

## 1. Goal

Today the loop's *parameters* are configurable (per-stage model / effort / instruction /
enabled), but the **pipeline shape and control flow are hard-coded** in `engine.ts`: a
fixed `StageName` list, three fixed branches (question / data / change), and one fixed
fix-loop. Two capabilities we want:

1. **Step catalog** — a library of reusable "steps" (a step = one unit of model work:
   instruction + model + effort + tools + skill + how the harness treats it). Curate your
   own steps and reuse them across workflows and projects.
2. **Workflow manager** — build your own workflows (ordered, branching, looping sequences
   of steps) instead of only the pre-built one.

The north star: **the pipeline becomes data, and the engine becomes an interpreter of
that data** — while keeping every safety rail, the checkpoint/resume model, parallelism,
and pause we already have.

## 2. Core concepts

### 2.1 Step (a catalog item)

A named, versioned definition of one model-driven unit of work. It is exactly today's
per-stage config **plus a declared role**, decoupled from any fixed position/name.

```yaml
# ~/.ticketloop/catalog/steps/browser-verify.yml
id: browser-verify            # stable, unique
version: 3                    # bumped on edit; workflows pin a version (see §7)
name: Browser verify
description: Run the change in a real browser and gate on it.
role: gate                    # ← what the harness does around it (see roles below)
readOnly: false
model: claude-opus-4-8
effort: medium
allowedTools: Read,Edit,Bash
skill: null
instruction: >-
  Use /agent-browser to exercise the affected flow live … end with VERDICT.
consumes: [plan, fix]         # which prior step outputs to inject as context
produces: verify              # name its output is stored under (for `consumes`)
```

**Roles** are the crucial abstraction. Today the harness classifies behavior by
hard-coded name sets (`CHECK_STAGES`, `VERDICT_STAGES`, `POST_STAGES`, the read-only data
path, the ship/deploy special-casing). In the new model each step **declares** its role
and the harness reacts to the role, so an *arbitrary user step* gets the right treatment:

| role | harness behavior |
|---|---|
| `plain` | just run the model at the workspace |
| `triage` | run, then parse a routing value (`KIND: …`) used by a `branch` phase |
| `gate` | append the `VERDICT: pass\|fail` contract; a fail routes back to the loop's repair step |
| `repair` | the step a failed gate loops back to (today's `fix`) |
| `post` | inject the project's tracker key as `$LINEAR_API_KEY`; expect a `COMMENT_URL:` |
| `ship` | run per-changed-repo; parse a PR URL; never merge |
| `locate` | read-only PR discovery; may emit a branch to reuse (`REUSE:`) |

Plus orthogonal flags: `readOnly` (run in a throwaway worktree, never push), `perRepo`
(run once per changed repo, like ship), `devOnly` (harness pins "DEV only" — for
deploy-dev/verify-dev). This replaces name-based special-casing with capability flags.

**Scopes** (resolution order, later overrides earlier): built-in (shipped in code) →
team/shared (imported bundle) → user (`~/.ticketloop/catalog`) → project (inline).

### 2.2 Workflow (a graph of steps)

A workflow references steps by id and arranges them with **structured control flow**. To
stay expressive-but-safe we model a workflow as an ordered list of **phases**, each phase
being one of three shapes (see §4 for why not a free DAG):

```yaml
# ~/.ticketloop/catalog/workflows/standard-change.yml
id: standard
version: 5
name: Standard dev cycle
triggers: { states: [Todo, In Review] }     # optional per-workflow trigger hints
phases:
  - step: triage                              # a single step (role: triage)
  - branch:                                   # pick a lane by the triage routing value
      on: triage.KIND
      cases:
        question: [{ step: clarify }]
        data:     [{ step: plan }, { step: prepare }, { loop: { … } }, { step: comment } ]
        change:
          - { step: locate }
          - { step: plan }
          - { step: prepare }
          - loop:                             # the fix ⇄ gates loop
              repair: fix
              gates:  [verify, review, ship, deploy-dev, verify-dev]
              maxIterations: 5                # + built-in no-progress + quota backstops
          - { step: comment }
```

- **`step`** — run one step (optionally with inline param overrides).
- **`branch`** — choose a sub-sequence of phases by a routing value a prior step emitted
  (the common case is `triage.KIND`, but any `triage`/classifier step can feed it).
- **`loop`** — a bounded repair loop: run `repair`, then the `gates` in sequence; the
  first `VERDICT: fail` sends its findings back to `repair`; repeat until all gates pass
  or a bound trips (`maxIterations`, no-progress, quota). This is exactly today's fix-loop,
  generalized to any ordered set of gate steps.

Everything is composed from **catalog step ids** — reorder, drop, or add gates, swap in
your own steps, without touching code.

### 2.3 Step Catalog & Workflow Manager (the surfaces)

- **Catalog** = the set of steps (built-in + curated). Browse / create / clone / edit /
  import / export via a dashboard "Catalog" tab and CLI.
- **Workflow Manager** = list / clone / edit / validate / assign workflows. A project
  picks a workflow by id (`project.workflow: standard`); unset → the built-in default.

## 3. Engine evolution (the interpreter)

`processTicket` stops being hard-coded control flow and becomes a **phase interpreter**:

- Load the project's workflow; walk its phases.
- `step` → resolve the step (catalog + overrides) and call the **existing `stage()`
  primitive** (which already gives us checkpoint replay + pause boundary + mock). The
  ckKey becomes `${stepId}#${iteration}` — derived from the workflow node, not a fixed
  name — so **checkpoint/resume keeps working unchanged**.
- `branch` → read the routing value the `triage`/classifier step produced; run the chosen
  sub-phases.
- `loop` → run `repair`, then `gates` sequentially, route back on first fail, bounded.
- Harness responsibilities (worktree setup, the off-limits guardrail, per-repo ship,
  tracker-key injection, cleanup, dev-only pinning) fire **based on step roles/flags**,
  not names.

The whole "question / data / change" trichotomy disappears from code: **data path = a
workflow whose steps are `readOnly`; question path = a short workflow ending in a `post`
step.** They become *default workflows built from data*, not branches in the engine.

## 4. Why structured phases, not a free node graph

Three modeled shapes (sequence / branch / bounded-loop) capture the entire current
pipeline and virtually every realistic dev cycle, while remaining **statically
analyzable**: we can guarantee termination (loops are always bounded), detect unreachable
steps, and require invariants (e.g. a workflow that ships must contain a `ship` step). A
free DAG with arbitrary conditional edges is more powerful but invites infinite loops,
unreachable nodes, and an un-validatable builder UI — more power than the problem needs.
If a real workflow ever can't be expressed as phases, we revisit. (**Decision A**, §9.)

## 5. Backward compatibility & migration

- Express the **current pipeline as the built-in `standard` workflow** built from
  **built-in steps** (triage, clarify, export, locate, plan, prepare, fix, verify, review,
  ship, deploy-dev, verify-dev, comment). A project with no `workflow` set runs it →
  **zero behavior change**.
- Today's per-project `stages` overrides map onto **per-node step overrides** in the
  default workflow. Ship a one-time migration that reads existing `stages` and materializes
  them as node overrides; keep honoring the old `stages` block for a deprecation window.
- **Parity gate**: before switching the engine over (Phase 2), a mock test asserts the
  `standard` workflow reproduces today's behavior exactly (same stage sequence, same
  gating, same outcomes) on the demo tickets.

## 6. Interaction with features we already have

- **Checkpoint / resume**: unchanged in spirit — cached nodes replay, uncached nodes run.
  Editing a *workflow* mid-flight behaves exactly like editing a stage instruction does
  today (see the resume-vs-restart-fresh semantics): already-completed nodes replay their
  old output; the stopped node onward + any newly-added nodes follow the **new** workflow;
  **Restart fresh** re-runs the whole ticket under the new workflow. This makes the
  existing Resume / Restart-fresh buttons even more important.
- **Parallelism / pause**: untouched — they operate at the run/scheduler level, above the
  workflow interpreter.
- **Guardrail / worktree / never-merge**: unchanged; now triggered by step roles.

## 7. Versioning & sharing

- Steps and workflows are **versioned**; a workflow **pins** the step version it was built
  against (floating-to-latest would silently change a curated workflow). An explicit
  "update step to vN" action re-pins — same philosophy as resume's old-vs-new-workflow
  handling. (**Decision D**, §9.)
- **Sharing**: start with **export/import bundles** (a `.yml` or a small tarball of
  steps + workflows) so a colleague can drop in your curated set. Later: a shared
  **git-backed registry** (a repo of steps/workflows referenced by URL) for team reuse.
  (**Decision E**, §9.)

## 8. Phased roadmap (build order — for a later, separate go-ahead)

1. **Data model & storage** — Step + Workflow schemas, catalog dir, built-in steps, the
   `standard` workflow expressed as data. No engine change yet; validate the schema
   round-trips.
2. **Interpreter** — replace hard-coded control flow with the phase interpreter + role-
   based harness behavior. Prove parity with today on the demo tickets.
3. **Catalog CRUD** — dashboard "Catalog" tab + CLI: browse / create / edit / import /
   export steps.
4. **Workflow builder** — dashboard "Workflows" tab: compose phases from catalog steps,
   validate, assign to a project.
5. **Sharing** — export/import bundles, then an optional shared registry.

Each phase is independently shippable; 1–2 are the foundation (and the riskiest — they
touch the engine), 3–5 are additive surfaces.

## 9. Decisions I need from you

- **A. Control-flow model** — structured phases (sequence / branch / bounded-loop)
  **[recommended]** vs a full conditional node-graph. Recommend phases.
- **B. Step roles** — a small enumerated capability set the harness understands (§2.1),
  extended only when a new harness behavior is genuinely needed. Recommend yes.
- **C. Branching source** — only the `triage` `KIND`, or any step may emit a routing
  value a `branch` consumes. Recommend the general form (triage is just the common case).
- **D. Step versioning** — pin-by-default with an explicit update action **[recommended]**
  vs always-latest.
- **E. Sharing** — local files + export/import first, shared registry later
  **[recommended]** vs build the registry up front.
- **F. Config surface** — YAML-first (steps/workflows are files, dashboard edits them) vs
  DB-backed. Recommend files (consistent with today; diffable, shareable).

## 10. Risks

- **Engine rewrite (Phase 2)** is the real risk — it replaces the most load-bearing code.
  Mitigation: build the data model first, keep the interpreter calling the unchanged
  `stage()` primitive, and gate the switch on a strict parity test.
- **Validation UX** — a builder that lets users create broken workflows (no ship on a
  change lane, a gate with no repair) is worse than none. The phase model makes validation
  tractable; invest in it.
- **Over-configuration** — infinite knobs can paralyze users. Ship strong built-in steps
  and the `standard` workflow as the default so the tool is great out of the box and
  curation is opt-in.
