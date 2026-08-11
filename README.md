# ticketloop

A **local, subscription-powered agent** that watches your tracker (Linear) and runs a
configurable dev-cycle loop on tickets — so client questions, small changes, and
one-off data exports stop eating your dev time.

It runs on **your machine** and shells out to **your own `claude` CLI**, so it uses your
Claude Pro/Max subscription instead of metered API tokens. A built-in web **dashboard**
shows quota usage and a full history of what the loop did.

```
                       ┌─ (question) → clarify ─────────────────────────────────→ 💬 comment
triage ─ decides kind ─┼─ (data)     → plan → prepare → export → verify ──────────→ 💬 comment + file
                       └─ (change)   → locate → plan → prepare → fix ⇄ verify → review → ship → 💬 comment
                                                              └───────── loop until every gate passes ┘
```

**Model-driven by design.** ticketloop provides the *framework* (the sequence of steps)
and a sensible default instruction for each step — then the **model** does the actual
work of each step using whatever skills, tools, MCP servers, and CLIs the project has.
The harness never dictates *how* a step is done; it sequences the steps, does the
deterministic git plumbing, enforces a few safety rails, drives the loops by parsing
each step's machine-readable result, and records history. **You customize any step by
giving it your own instruction.**

Three jobs, one loop:

1. **Clarification bot** — a client asks "why does X work this way?" → the agent reads
   your code and posts an answer. Read-only.
2. **Data export** — "export the member list with opt-in status" → the agent pulls the
   data (using creds the ticket provides), verifies it, and posts a file to the ticket.
   Read-only.
3. **Simple-fix loop** — a small change → the agent plans, edits, runs your checks,
   self-reviews, ships a PR, and drives its CI green — or **refreshes an existing PR**
   when a client leaves feedback on one.

---

## Contents
- [Why local](#why-local) · [Install](#install) · [Quick start](#quick-start-no-credentials)
- [Setup for real use](#setup-for-real-use) · [Commands](#commands)
- [Architecture](#architecture) — the loop, the three kinds, isolation, per-project keys
- [Configuring the steps](#configuring-the-steps) — **the main knob**
- [What each step must output](#what-each-step-must-output) — the contracts
- [Safety rails](#safety-rails) · [Quota / governor](#quota--the-governor)

---

## Why local

Claude Pro/Max subscriptions authenticate through the **local `claude` CLI login**.
Running the loop on your machine draws from the subscription you already pay for.
ticketloop defaults to **subscription mode** and protects that billing path: it never
uses `--bare`, and it **unsets `ANTHROPIC_API_KEY`** for the `claude` child so a stray
env var can't silently flip you to metered billing. Switch `auth.mode: api` for
unattended/heavy use on a metered key.

## Install

```bash
git clone git@github.com:the-good-pixel/ticketloop.git && cd ticketloop
npm install
npm link            # optional: puts `ticketloop` on your PATH
```

Requires **Node ≥ 20**, the **`claude` CLI** (logged in), **`git`**, and **`gh`** (for PRs).
Run `ticketloop doctor` to check all of the above at once.

## Quick start (no credentials)

```bash
ticketloop demo
```

Runs the loop against built-in demo tickets with a **simulated** agent (no quota spent)
and opens the dashboard at http://127.0.0.1:4317. You'll see a question answered, two
changes taken to a (mock) PR, and a data export — end to end.

## Setup for real use

```bash
ticketloop init                    # writes ticketloop.config.yml
# edit the config: add your project(s), tracker team/states, exclude paths, steps
ticketloop set-key <project>       # store that project's Linear API key (chmod 600)
ticketloop doctor                  # verify auth, keys, tooling
ticketloop watch                   # start the daemon + dashboard
```

Or run a single ticket without the daemon:

```bash
ticketloop run --ticket MRM-182
```

Start from **[`ticketloop.config.example.yml`](./ticketloop.config.example.yml)** — it's a
fully commented template. Full walkthrough (incl. running as a background service) in
**[SETUP.md](./SETUP.md)**.

## Commands

| command | what it does |
|---|---|
| `ticketloop init` | scaffold `ticketloop.config.yml` |
| `ticketloop doctor` | check auth / per-project keys / tooling |
| `ticketloop demo` | run the loop on built-in demo tickets + dashboard (no creds, no quota) |
| `ticketloop set-key <project>` | store a project's Linear API key |
| `ticketloop watch` | start the daemon: poll tracker → run loop → serve dashboard |
| `ticketloop run [--ticket ID]` | scan once (or one ticket by id, any state) then exit |
| `ticketloop pause` | pause the running daemon at the next stage boundary (in-flight work is checkpointed) |
| `ticketloop resume` | resume — paused/failed runs continue **from where they stopped**, not from scratch |
| `ticketloop status` | print quota meters + recent runs (shows ⏸ when paused) |

Flags: `--config <path>`, `--mock`/`--demo`, `--ticket <ID>`, `--port <n>`, `--debug`.

---

## Architecture

> 📊 **Visual overview:** open [`docs/architecture.html`](docs/architecture.html) in a browser — a one-page diagram of the loop, the three kinds, the fix loop, multi-repo, and who drives each step.

### The three triage kinds

Every ticket first goes through **`triage`** (a model call). It decides *eligibility* and
a *kind*, and the harness routes accordingly:

| kind | path | side effects |
|---|---|---|
| **question** | `clarify → comment` | posts an answer on the ticket. Read-only. |
| **data** | `plan → prepare → export → verify → comment` | posts a data file on the ticket. Read-only; runs in a throwaway worktree. |
| **change** | `locate → plan → prepare → (fix ⇄ verify → review → ship) → comment` | opens/updates a PR (never merges) + posts a comment. |

### The fix loop (change path)

After the first `fix`, the gates run **in sequence — `verify` → `review` → `ship`** — and
**each must pass before the next runs**. Every gate returns a machine-readable
`VERDICT: pass` / `VERDICT: fail — <reason>`; the first failure sends its findings
straight back to `fix`, and the loop repeats up to `loop.maxFixIterations` (with
no-progress and quota backstops). `ship` is the last gate: its instruction opens/updates
the PR and drives its **CI to green**. It ends by shipping a PR — clean, or flagged
`pr-opened-with-findings`.

> There is **no** separate test/lint command. Put any build/test/lint you want gated
> inside the **`verify`** step's instruction (e.g. "run `deno task check`; fail if it
> doesn't pass") and it becomes part of that step's verdict.

### PR refresh (the `locate` step)

On the change path, `locate` runs first (read-only) and looks for an **open PR** already
attached to this ticket — even one opened by a human or another agent, on any branch. If
it finds one, the harness checks out that branch and the loop **refreshes the same PR**
(pushing to it) instead of opening a new one; the guardrail then polices only the
**model's new delta**, not the PR's already-made (possibly approved) changes. No open PR
→ a fresh branch off `origin/main`.

### Parallel runs — one per project

The daemon works **multiple tickets at once, but at most one per project**. Each scan
launches a run for every *free* project concurrently; a project with a run already in
flight is skipped until it finishes. This keeps several clients moving in parallel while
never letting two runs fight over the same repo's worktree, branches, or dev server.
Quota is shared — the global governor gates all of them.

### Resume & pause

A run **checkpoints after every completed stage** (`~/.ticketloop/checkpoints/`),
recording each stage's output plus the worktree/branch it's using. So when a run stops
part-way — a dropped connection at `ship`, a rate limit, a daemon restart, or an explicit
`ticketloop pause` — the next attempt **resumes from the exact stage that stopped**
instead of starting over:

- **On resume**, completed stages *replay from cache* (no model call, 0 tokens) and the
  engine reattaches the **same worktree + branch** (the fix's edits are still there). The
  run fast-forwards to the first stage that didn't finish and continues from there.
  A ship that dropped its connection after 45 min of `plan`/`prepare`/`fix`/`verify`/`review`
  simply re-runs `ship` — the rest is reused.
- **`ticketloop pause`** stops the loop at the next stage boundary: the in-flight run
  checkpoints and ends `paused`, and no new tickets are picked up. **`ticketloop resume`**
  (or the dashboard's ⏸/▶ button) continues each paused run from its checkpoint.
- **Ticket-level**: `ticketloop pause <ID>` / `resume <ID>` (or the ⏸/▶ on a run's row)
  pauses just that ticket — the other projects keep running. Because of one-per-project,
  resuming a ticket whose project is busy with another one **warns** and queues it: it
  resumes automatically once that project's current run finishes.
- A checkpoint is **kept** only for `failed` / `blocked` / `paused` outcomes; success or
  give-up deletes it. It's also **invalidated by new human activity** — if the client
  comments again, the ask changed, so the run starts fresh rather than resuming stale work.

### Isolation & the git base

- Each change runs in a **git worktree** off your repo, so the loop never touches your
  working tree. No clone needed — point `repoPath` at your normal checkout.
- The worktree branches off **`origin/main`** (freshly fetched), and the off-limits
  guardrail diffs against that same ref — so a stale local `main` can never make
  pulled-in upstream commits look like this branch's changes.
- The **guardrail** re-runs every loop iteration over **all** repos: if a change touches
  an `exclude` path (or a read-only repo), the run is **blocked** before shipping.

### Multi-account tracker, per project

Each project points at its **own Linear workspace with its own API key** (`ticketloop
set-key <project>`). One Linear MCP can only be logged into one account — so **the model
never uses the Linear MCP.** Instead the harness passes the project's key into the
posting steps as **`$LINEAR_API_KEY`** (env, never in the prompt) and they post via the
API to the *correct* workspace. This is what makes multiple client workspaces safe: a
miles ticket posts with the miles key, an HKBU ticket with the HKBU key — no
cross-workspace leakage.

---

## Configuring the steps

**This is the main knob.** The step *sequence* is fixed, but each step is a model call
driven by an instruction, configured per project under `stages:`. Each step accepts:

| field | meaning |
|---|---|
| `instruction` | **your** prompt for this step (see modes below) |
| `instructionMode` | `replace` (default — swap the built-in) or `append` (add on top) |
| `model` | model tier, e.g. `sonnet` or `claude-opus-4-8` |
| `effort` | `low` / `medium` / `high` |
| `skill` | a skill to invoke (e.g. `code-review`) |
| `allowedTools` | which tools the step may use, e.g. `Read,Edit,Bash` |
| `enabled: false` | skip this step |

```yaml
stages:                       # global defaults for every project
  verify: { model: claude-opus-4-8 }
projects:
  - name: my-app
    repoPath: /abs/path/to/my-app
    autonomy: propose
    tracker: { team: MIL, states: [Todo, In Review] }
    exclude: ["**/migrations/**", "**/*auth*"]
    stages:                   # per-project overrides win over the globals
      verify:
        instructionMode: append
        instruction: "Run `npm run check` and browser-test the change; fail the verdict if either fails."
      ship:
        instruction: "Use the /ship-pr skill: open/update the PR, then watch CI and fix until green. Never merge."
```

The built-in defaults encode a reasonable house style (small diffs, feature branches,
run the project's checks, short commits, open a PR but **never merge**, reply in plain
non-technical English). Override any of them per project.

### What each step must output

The harness parses a machine-readable line from certain steps — **the harness appends
this requirement itself**, so it holds even if you fully replace the instruction. Write
your instruction to *do the work*; the contract line is added for you.

| step | must end with | drives |
|---|---|---|
| `triage` | `DECISION: eligible\|ineligible` + `KIND: question\|data\|change` | routing |
| `locate` | `REUSE: <branch>` or `REUSE: none` | reuse an open PR vs fresh |
| `verify` `review` `ship` | `VERDICT: pass` or `VERDICT: fail — <reason>` | the loop (fail → back to fix) |
| `clarify` `comment` | posts to the ticket via `$LINEAR_API_KEY`, then `COMMENT_URL: <url>` | delivery |

Notes:
- **Posting steps** (`clarify`, `comment`) post to Linear *themselves* using the key in
  `$LINEAR_API_KEY` (the right workspace) — **not** the Linear MCP. End the comment body
  with `— 🤖 via ticketloop` (the harness asks for this so it can recognize its own
  comments and not re-trigger on them) and print `COMMENT_URL: <url>`.
- **`ship`** must open/update the PR and drive CI green *inside its instruction* — the
  harness never watches CI. If the repo has no CI, "mergeable" counts as pass.
- **`export`** (data path) must use only the creds/source the ticket provides, stay
  read-only, write a file, and report its path + a short summary; the following
  `verify` checks the data; the `comment` attaches the file.

### What the harness does vs the model

| | owns |
|---|---|
| **Model** (`claude -p`) | every step's work, via its instruction + the project's tools/skills/CLI/MCP |
| **Harness** (the daemon) | scheduling, quota governor, routing, **git plumbing** (worktree/branch/cleanup), the off-limits guardrail, driving the loops by parsing verdicts, per-project keys, history, dashboard |

---

## Safety rails

- **`exclude`** — globs the agent must never auto-edit; a fix that touches one **blocks**
  the run before any PR. In multi-repo, patterns are repo-prefixed (`backend/migrations/**`).
- **`autonomy`** — `clarify` (answer only) · `propose` (open a PR, human merges — the
  recommended default) · `gated-merge` (auto-merge trivial clean changes; opt-in).
- **Never merges** — the loop opens/updates PRs and stops at ready-to-merge.
- **Worktree isolation** — the loop works in a throwaway worktree, not your checkout.
- **`shipDisabled` repos** (multi-repo) — greppable context only; editing one blocks.

### Multi-repo projects

One "project" folder can hold several sibling git repos. List them under `repos`;
`repoPath` becomes the workspace root:

```yaml
  - name: hkbu
    repoPath: /abs/path/to/hkbu
    repos:
      - { name: frontend, path: bu-job-board-frontend }
      - { name: backend,  path: bu-job-board-backend  }
      - { name: infra,    path: iac-uat, shipDisabled: true }   # context only
    exclude: [backend/migrations/**]
```

The harness mirrors **one worktree per repo** under the root (the model sees them
side-by-side, cross-repo greps work), the model edits whichever repos the ticket needs,
and it ships **one PR per changed repo** — the guardrail runs over all of them, untouched
repos' empty branches are cleaned up, and if some ship and some fail the run is `partial`.
(A **monorepo** is not this — just point `repoPath` at the monorepo root. PR-refresh via
`locate` is single-repo for now.)

## Quota / the governor

Anthropic doesn't publish real subscription token quotas, so the dashboard shows usage
as a percentage of **tunable estimates** (`quota.sessionTokenBudget`,
`quota.weeklyTokenBudget`) plus the **real** 5-hour / 7-day percentages read from Claude
Code's status line. The governor tracks every stage's tokens, shows a rolling 5-hour and
weekly meter, and **pauses the batch** when a meter nears its budget, resuming after
reset.

---

## Status

Runs end-to-end on real tickets (question, data export, change, and PR-refresh paths all
verified). Runs on your machine; not intended for hosted/shared multi-user use on a
subscription (that requires API keys per Anthropic's terms).

MIT.
