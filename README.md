# ticketloop

A **local, subscription-powered agent** that watches your tracker (Linear) and runs a
configurable dev-cycle loop on trivial tickets — so client questions and small
copy/UI changes stop eating your dev time.

It runs on **your machine** and shells out to **your own `claude` CLI**, so it uses
your Claude Pro/Max subscription instead of metered API tokens. A built-in web
**dashboard** shows token/quota usage and a full history of what the loop did.

```
triage ─▶ ┬─ (question) ─▶ clarify ─────────────────────────────────────▶ 💬 comment
          └─ (change)   ─▶ plan ─▶ prepare ─▶ fix ─▶ verify ─▶ review ─▶ ship ─▶ 💬 comment
```

**Model-driven by design.** ticketloop provides the *framework* (the sequence of
steps above) and a sensible default instruction for each step — then the **model**
does the actual work of each step using whatever skills, tools, MCP servers, or CLIs
that project has. The harness never dictates *how* a step is done; it only sequences
the steps, enforces two safety guardrails (quota + off-limits paths), and records
history. You customize any step by giving it your own instruction.

Two jobs, one loop:

1. **Clarification bot** — a client asks "why does X work this way?" → the agent
   reads your code and posts an answer comment. Read-only, zero risk.
2. **Simple-fix loop** — a small copy/CSS/one-to-few-line change → the agent plans,
   edits, runs your tests, self-reviews, and opens a PR for a human to merge.

## Why local?

Claude Pro/Max subscriptions authenticate through the **local `claude` CLI login**.
Running the loop on your machine means it draws from the subscription you already pay
for. CI/cloud runners need an `ANTHROPIC_API_KEY` (metered billing). ticketloop
defaults to **subscription mode** and actively protects that billing path:

- it never uses `--bare` (which skips your login and requires an API key),
- in subscription mode it **unsets `ANTHROPIC_API_KEY`** for the `claude` child, so a
  stray env var can't silently flip you to metered billing.

Switch `auth.mode: api` when you want unattended/heavy use on a metered key.

## Install

```bash
git clone <this-repo> ticketloop && cd ticketloop
npm install
npm link            # optional: puts `ticketloop` on your PATH
```

Requires Node ≥ 20, the `claude` CLI (logged in), `git`, and `gh` (for PRs).

## Quick start (no credentials needed)

```bash
ticketloop demo
```

This runs the loop against three **built-in demo tickets** with a **simulated** agent
(no quota spent) and opens the dashboard at http://127.0.0.1:4317. You'll see a
question answered and two small changes taken through to a (mock) PR.

## Real usage

```bash
ticketloop init                 # writes ticketloop.config.yml (globals + empty projects)
ticketloop watch                # start the daemon + dashboard
# → open the dashboard, go to the Setup tab, and add your project(s) + Linear key there
```

**Setup is split by how often you touch it:**
- **One-off globals** (auth mode, quota budgets, poll interval, tracker defaults) — set once in
  `ticketloop.config.yml`. Shown read-only in the dashboard.
- **Per-project setup** (add/edit projects, their repo path, autonomy, exclude paths, test
  command, per-step instructions, **and the Linear API key**) — done in the **Setup** tab of the
  dashboard, one project at a time. No env vars, no hand-editing YAML.

Prefer the CLI? `ticketloop set-key <project>` stores a key, and you can edit projects directly
in the config file. The dashboard just makes it point-and-click.

See **[SETUP.md](./SETUP.md)** for a full walkthrough, including running it as a
background service.

## Commands

| command | what it does |
|---|---|
| `ticketloop init` | scaffold `ticketloop.config.yml` |
| `ticketloop doctor` | check auth / credentials / tooling |
| `ticketloop demo` | run the loop on built-in demo tickets + dashboard (no creds, no quota) |
| `ticketloop watch` | start the daemon: poll tracker → run loop → serve dashboard |
| `ticketloop run [--ticket ID]` | scan once (or one ticket) then exit |
| `ticketloop status` | print quota meters + recent runs in the terminal |

Flags: `--config <path>`, `--mock`/`--demo`, `--ticket <ID>`, `--port <n>`, `--debug`.

## Configuration

Everything is driven by `ticketloop.config.yml` (see
[`ticketloop.config.example.yml`](./ticketloop.config.example.yml) for a fully
commented template). The three things that matter most:

**Per-step instructions (the main knob)** — the framework is fixed
(`triage → clarify → plan → prepare → fix → verify → review → ship → comment`), but
each step is a model call driven by an instruction. Every step ships with a built-in
default; you override any of them to tell the model exactly how *you* want that step
done — use a skill, an MCP, your own CLI, your commit/PR conventions, a browser test
flow. Each step also takes `model`, `effort`, `skill`, `allowedTools`, and
`enabled`. `instructionMode: append` adds your text on top of the default;
`replace` (default) swaps it entirely.

**The fix loop (check steps gate it).** After `fix`, the **check steps** (`verify`,
`review`) run. Each one ends with a machine-readable verdict — `VERDICT: pass` or
`VERDICT: fail — <reason>` (the harness enforces this format on every check step, so
it works even with a custom instruction). If **any** check fails, its findings are fed
back into another `fix` and the loop repeats, up to `loop.maxFixIterations` times (with
no-progress and quota backstops); then it ships — as a clean PR, or a PR flagged with
unresolved findings. There is **no** separate test/lint command — put any
build/test/lint you want gated inside the `verify` step's instruction (e.g. "run
`deno task check`; fail if it doesn't pass"), and it becomes part of that step's verdict.

```yaml
stages:
  verify:
    instructionMode: append
    instruction: "Use the test-plan skill and run the app in the browser to confirm."
  review:
    skill: code-review
  ship:
    instructionMode: append
    instruction: "Commit <50 chars, no AI attribution; open PR against main, never merge."
```

The built-in defaults encode a reasonable house style (small diffs, feature branches,
run the project's checks, short commits, open a PR but **never merge**, reply in
English). Override per project under a project's own `stages:`.

**Per-project safety rails** — `exclude` lists globs the agent must **never**
auto-edit; if a fix touches one, the run is blocked. `autonomy` sets how far it goes:

- `clarify` — answer questions only, never change code
- `propose` — open a PR, a human merges (recommended default)
- `gated-merge` — auto-merge trivial copy/CSS when review is clean (opt-in)

```yaml
projects:
  - name: my-app
    repoPath: /abs/path/to/my-app
    autonomy: propose
    match: { linearTeam: MIL }
    exclude: ["**/migrations/**", "**/*auth*", "**/*timezone*"]
    # any build/test/lint command goes in the verify step's instruction:
    stages: { verify: { instructionMode: append, instruction: "Run `npm run check`; fail if it doesn't pass." } }
```

**Credentials (per-project, stored in the daemon)** — each project points at its
**own tracker workspace with its own API key**, so multiple Linear
accounts/workspaces work. Store each key once with `ticketloop set-key <project>`
— it's saved to `~/.ticketloop/credentials.json` (chmod 600) and used
automatically, no env vars to juggle. (`tracker.apiKeyEnv` remains a fallback for
CI/headless.) MCP servers under `mcp:` are passed to `claude` during runs so the
model can act on Linear/GitHub directly.

```yaml
tracker:                      # defaults
  type: linear
  simpleLabel: ai-loop
projects:
  - name: app-a
    tracker: { team: AAA }    # workspace A → key via `ticketloop set-key app-a`
  - name: app-b
    tracker: {}               # workspace B → key via `ticketloop set-key app-b`
```

**Isolation** — each change runs in a **git worktree** off your repo (default), so the
loop never touches your working tree. No clone needed; point `repoPath` at your normal
checkout. Set `useWorktree: false` to work in-place.

### Multi-repo projects

If one "project" folder holds **several independent git repos** and a ticket can touch
any of them (e.g. a `frontend/` + `backend/` + `infra/` sibling layout), list them under
`repos`. `repoPath` becomes the **workspace root** (the container folder, not itself a
repo):

```yaml
  - name: hkbu
    repoPath: /abs/path/to/hkbu       # parent folder holding the repos
    repos:
      - { name: frontend, path: bu-job-board-frontend }
      - { name: backend,  path: bu-job-board-backend  }
      - { name: infra,    path: iac-hkbu-uat, shipDisabled: true }  # context only
    exclude: [backend/migrations/**]  # repo-PREFIXED in multi-repo mode
```

Each change mirrors **one worktree per repo** under the root, so the model sees them
side-by-side and cross-repo greps work. The guardrail runs over **all** repos (an
off-limits path in any repo blocks the whole run), and every changed repo gets its own
branch, commit, and **PR** — the ticket comment lists them all. `shipDisabled: true`
makes a repo read-only context (editing it blocks). If some repos ship and others fail,
the run is marked `partial`.

- **Omit `repos`** for the normal single-repo case — zero behaviour change.
- A **monorepo** is not this: just point `repoPath` at the monorepo root.
- **Just want the model to *see* everything?** Point `repoPath` at the parent folder with
  `useWorktree: false` + `autonomy: clarify` — cross-repo question-answering works with
  no `repos` block at all.

## Quota / the governor

Anthropic **does not publish** real subscription token quotas, so the dashboard shows
your usage as a percentage of **tunable estimates** (`quota.sessionTokenBudget`,
`quota.weeklyTokenBudget`). The governor:

- tracks the tokens `claude` reports for every stage,
- shows a rolling **5-hour** meter and a **weekly** meter (the weekly cap is the real
  bottleneck for sustained loops),
- **pauses the batch** when either meter nears its budget, and resumes after reset.

Tune the budgets to match how full the meters feel on your plan.

## How it decides what to touch

`triage` runs first and independently judges whether a ticket is safe to automate —
copy/CSS/tiny edits with clear intent pass; anything touching migrations, auth,
payments, dates/timezones, or your `exclude` globs is marked ineligible and left for a
human. Questions are always eligible (they're answered, not coded).

## Status

Early / MVP. The full pipeline runs end-to-end (verified in demo mode). Screenshot-
after-deploy and `gated-merge` auto-merge are scaffolded but conservative by default.
Runs on your machine; not intended for hosted/shared multi-user use on a subscription
(that requires API keys per Anthropic's terms).

MIT.
