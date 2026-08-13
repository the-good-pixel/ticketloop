# Agent instructions — working on ticketloop

Guidance for coding agents (and humans) editing **this** codebase. For what the tool
*does* and how to configure it, read `README.md` and open `docs/architecture.html`.

## What this is

A **local, subscription-powered agent** that watches a tracker (Linear) and runs a
configurable dev-cycle loop on tickets by spawning `claude -p` subprocesses (billed to
your Claude subscription, not the API). The harness owns sequencing, git plumbing, and
safety rails; the **model does the actual work of every step**, shaped by a per-step
instruction. One daemon, a vanilla dashboard, per-run JSON storage under `~/.ticketloop`.

## Stack & how to run

- **Node + TypeScript run via `tsx` — there is NO build step.** Don't add one.
- Runtime dep: `yaml`. Dashboard is **vanilla** HTML/CSS/JS (no framework, no bundler).
- Commands:
  - `npm run start -- <cmd>` or `npx tsx src/cli.ts <cmd>` — cli entry (`watch`, `run`,
    `demo`, `status`, `pause`, `resume`, `doctor`, `set-key`, `init`).
  - `npm run dev` — daemon with hot reload.
  - `npx tsx src/cli.ts demo` — full loop on built-in demo tickets, **mock runner, no
    quota spent, no network**. Best way to exercise changes.
  - `npm run typecheck` (`tsc --noEmit`) — **the** correctness gate before committing.

## Verifying changes (no test framework)

There is **no Jest/Vitest**. Verification = **`tsc --noEmit`** + **ad-hoc `tsx` scripts in
mock mode**. When you change loop/engine behavior, write a short throwaway script that:

1. Sets `process.env.TICKETLOOP_HOME` to a fresh temp dir (isolates state) and
   `process.chdir(tmp)` (so `loadConfig()` falls back to `DEFAULTS`).
2. Sets mock env **before** importing anything (use dynamic `import()` after setting env).
3. Builds a `Config` (mock tracker) + a project, `makeEngineCtx(cfg, true)`, and drives
   `processTicket(...)` or `watch(...)`, asserting on the returned `RunRecord` / store.

Mock injectors (env vars, read at module load in `src/runner/claude.ts`):
`TICKETLOOP_MOCK_DELAY_MS`, `TICKETLOOP_MOCK_ERROR_SHIP` (ship throws — tests
resume-after-crash), `TICKETLOOP_MOCK_FAIL_VERIFIES` / `_REVIEWS` / `_SHIPS` /
`_DEPLOYS` / `_VERIFYDEV` (emit `VERDICT: fail` N times), `TICKETLOOP_MOCK_REUSE_BRANCH`.
Mock stage text lives in `MOCK_TEXTS`; mock control flow in `MockRepo` / `MockTracker`.

## Architecture map (where things live)

- `src/types.ts` — **source of truth** for `StageName`, `STAGE_ORDER`, config & domain
  types, `RunRecord`/`StageRecord`. Adding/renaming a stage starts here.
- `src/config.ts` — `DEFAULTS` (global stage config), `DEFAULT_INSTRUCTIONS` (per-stage
  built-in instruction), `resolveStage` (global < project override), `resolveInstruction`
  (default combined with the user's `replace`/`append`), `loadConfig`/`saveConfig`.
- `src/loop/engine.ts` — the heart. `processTicket` runs the pipeline: triage → route to
  **question** (clarify), **data** (plan→prepare→export⇄verify→comment, throwaway
  worktree, read-only), or **change** (locate→plan→prepare→**fix ⇄ verify→review→ship→
  deploy-dev?→verify-dev?**→comment). `stage()` is the one place a `claude -p` runs; it
  also does checkpoint replay + pause boundary. `setupWorkspace`/`scanRepos` = git
  isolation + the off-limits guardrail.
- `src/loop/prompts.ts` — `buildStagePrompt` assembles the prompt; `CHECK_STAGES`,
  `VERDICT_STAGES`, `POST_STAGES` classify stages; `PriorOutputs`/`StageExtras`.
- `src/loop/checkpoint.ts` — per-ticket resume checkpoint (cached stage outputs +
  workspace descriptor). `src/loop/classify.ts` — fallback kind detection.
- `src/daemon/watch.ts` — the scheduler: `selectJob` (one candidate per project),
  `runJob`, `scanNow` (**launches one run per free project, in parallel**), retry hook.
  `src/daemon/server.ts` — dashboard HTTP + JSON API. `src/daemon/control.ts` — the
  cross-process pause switch (system + per-ticket).
- `src/runner/claude.ts` — spawns `claude -p`, parses usage, enforces auth-mode safety;
  holds the mock runner. `src/runner/children.ts` — orphan reaping.
- `src/adapters/tracker/*` — `Tracker` interface + `linear` / `mock`. `src/adapters/repo/
  github.ts` — `Repo` interface (`GitRepo` + `MockRepo`): worktrees, branches, diffs, gh.
- `src/store.ts` — per-run JSON files + usage log (atomic writes). `src/governor/` —
  quota meters. `src/web/` — dashboard (`app.js` is one file; served static).
- `src/catalog/` — **the step catalog + workflow manager** (the pipeline as DATA).
  `types.ts` = steps, contracts, capabilities, transitions, workflows, artifacts.
  `builtin-steps.ts` / `builtin-workflows.ts` = the seed — today's 14 stages and today's
  pipeline, expressed as catalog data (instruction text is imported from `config.ts`, so
  there is one source of truth). `store.ts` = YAML load/save + immutable versions.
  `compile.ts` = workflow + project policy → `ExecutionPlan`. `validate.ts` = the
  diagnostics that block an unsafe plan.
- `src/loop/interpreter.ts` — **executes** a compiled plan. Opt-in per project via
  `engine: workflow`; `processTicket` dispatches to it and shares the run record,
  checkpoint, marker and images so history/resume behave the same either way.
  Supporting parts: `verdict.ts` (pass/fail/**wait**/skip), `artifacts.ts` (typed PR /
  deployment / file state), `nodePrompt.ts` (prompt built from a step's contract +
  capabilities, NOT from its name), `workspace.ts` (git isolation + the off-limits
  guardrail, shared with the legacy engine — never fork this).

## Conventions & invariants (don't break these)

- **The harness provides framework, not method.** Never hard-code *how* a step is done —
  that's the model's instruction. The harness only sequences, does git, holds safety
  rails, and records history.
- **Every gating step emits `VERDICT: pass|fail`** (verify, review, ship, deploy-dev,
  verify-dev — see `VERDICT_STAGES`). The harness appends the contract; a failure routes
  back to `fix`. Missing verdict = fail-open (treated as pass). Parsing is last-wins.
- **The model posts to the tracker, not the harness.** Post steps (`POST_STAGES`) get the
  project's Linear key as `$LINEAR_API_KEY` (env, never in the prompt) and post via API —
  **never** the shared MCP (wrong workspace). There is no harness-side post fallback.
- **Isolation**: change work runs in a git **worktree off `origin/main`** (freshly
  fetched); the off-limits `exclude` guardrail (`scanRepos`) runs every fix iteration over
  all repos. **Never auto-merge** unless a project's own instruction explicitly says to.
- **Parallelism**: at most **one run per project**, many projects at once (`activeRuns`).
- **Resume = replay cached stages + reattach the same worktree**, continuing at the
  stage that stopped; already-completed stages keep their old output. A checkpoint is
  keyed by the ticket's latest-human-activity **marker** — new activity invalidates it.
- **`deploy-dev` / `verify-dev` are opt-in and DEV-only** — the prompt hard-pins them to
  dev regardless of the instruction.
- **Stage names are kebab-case** (`deploy-dev`). They're used as config keys, checkpoint
  ckKeys (`deploy-dev#<iter>`), and `MOCK_KIND`/`MOCK_TEXTS` keys — keep them consistent.
- Comments explain **non-obvious** decisions and invariants; match the surrounding
  density. Prefer clarity over cleverness; keep files focused.

## Adding a new stage (checklist)

Both engines are live, so a new stage must be added in BOTH places: the stage list
below (legacy), and the catalog (`src/catalog/builtin-steps.ts` + a node in
`builtin-workflows.ts`). Run `npx tsx src/cli.ts workflow validate` after, and compare
traces across both engines before committing.

A step's `contract` decides how its RESULT is read; `produces.type` decides what typed
artifact is recorded. They are independent — `ship` is a `verdict` step that produces a
`github-pr`. Getting this wrong silently disables a gate.


1. `types.ts`: add to `StageName` **and** `STAGE_ORDER` (in pipeline order).
2. `config.ts`: add to `DEFAULTS.stages` (set `enabled: false` if opt-in) and
   `DEFAULT_INSTRUCTIONS`.
3. `prompts.ts`: add to `VERDICT_STAGES` if it's a gate / `POST_STAGES` if it posts; add
   any prior-feeding + a safety/context note in `buildStagePrompt`; extend `PriorOutputs`.
4. `engine.ts`: wire the `stage(...)` call with a unique ckKey (`name#<iter>` inside the
   loop) at the right point; thread its output into `priors`; add to `MOCK_KIND`.
5. `runner/claude.ts`: add a `MOCK_TEXTS[name]` (with `VERDICT: pass` if gated) and, if
   useful, a `TICKETLOOP_MOCK_FAIL_<NAME>` injector.
6. `npm run typecheck`, then a mock `tsx` script exercising it.

## Safety context

Steps run with `--dangerously-skip-permissions` (headless can't answer prompts). Safety
comes from **worktree isolation + the exclude guardrail + PR review (never auto-merge)**,
not from prompts. Only run on tickets from sources you trust. Data-path work runs
read-only in a throwaway worktree.

## Git

Feature branches; conventional short commit subjects. Config file
(`ticketloop.config.yml`) and `~/.ticketloop` state are **gitignored / local** — never
commit secrets or a user's real config. Deployment is manual — never deploy.
