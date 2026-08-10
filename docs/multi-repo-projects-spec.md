# Multi-repo projects — design investigation & spec

Status: **v1 implemented** (see §5 for the v1 vs full-design split). Shipped across `src/types.ts`, `src/config.ts`, `src/loop/engine.ts` (`setupWorkspace`/`scanRepos` + ship loop), `src/adapters/repo/github.ts` (`isGitRepo`, per-repo mock), `src/loop/prompts.ts` (workspace/ship blocks), `src/daemon/server.ts` (+`partial` facet), `src/web/{app.js,style.css}` (per-repo PR links + `partial` badge). Verified in mock mode (3-repo workspace, ship-per-dirty-repo, `shipDisabled`, cross-repo exclude block) and against the real `~/Development/hkbu` repos (worktree create/detect/cleanup). **Deferred to the full design:** triage `REPOS:` hint, two-pass `gh pr edit` cross-linking, `existingPr` re-run detection, per-repo `prepare`/`testCmd`, submodule pointer-bump, and the Setup-form repo editor (configure via YAML for now).

---

## 1. The problem

`ProjectConfig` today is *one project = one git repo*:

```ts
interface ProjectConfig {
  repoPath: string      // THE repo
  exclude: string[]     // one glob list
  useWorktree?: boolean
  worktreeBase?: string | null
}
```

Real projects often aren't shaped that way. A "project" folder can be a **container of repos**. Three distinct sub-cases:

| | Shape | On disk | Remotes / PRs |
|---|---|---|---|
| **(a) Sibling repos** | parent dir holds N independent repos | `~/dev/myapp/{frontend,backend,infra}/.git` each | N remotes, N default branches, N PRs |
| **(b) Monorepo** | one repo, many packages | `~/dev/myapp/.git`, `apps/*`, `packages/*` | 1 remote, 1 PR |
| **(c) Meta-repo w/ submodules** | superproject + pinned children | `~/dev/myapp/.git` + `libs/foo/.git` (gitlink) | N remotes + a **pointer bump commit** in the parent |

**(b) is the easy case and already works.** Point `repoPath` at the monorepo root; the model already sees every package, `git status` covers the whole tree, one branch, one PR. Nothing in this spec is needed for (b) — the only ergonomic gap is that `exclude` is a flat list with no per-package scoping, which is a cosmetic issue, not a breakage. **If a user's "multi-repo" situation is actually a monorepo, tell them to use `repoPath: <root>` and stop.**

(a) and (c) are the hard cases and are what the rest of this doc addresses. (c) is (a) plus an ordering constraint and an extra commit.

---

## 2. How the current design breaks

Trace the change path in `engine.ts` (lines ~100–195):

| Step | Code today | Breaks on (a)/(c) because |
|---|---|---|
| triage / clarify cwd | `repoPath = project.repoPath` | The model sees only one repo. A ticket like "the button label comes from the FE but the string is served by the BE" cannot be answered — half the code is invisible. If `repoPath` is the *parent* folder instead, triage/clarify actually work fine (they're read-only, no git needed) — this is the one part that degrades gracefully. |
| branch | `` `ticketloop/${id}` `` — one name | Fine as a *name* (reuse it per repo), but it's created in exactly one place. |
| `defaultBranch(repoPath)` | one `symbolic-ref` | Each repo may have a different default (`main` vs `master` vs `develop`) and a different PR base. |
| `createWorktree(repoPath, workdir, …)` | one worktree | If `repoPath` is the parent folder (not a repo), `git worktree add` **fails outright**. If it's one child repo, the other repos are outside `workdir` and the model either can't reach them or edits them **in-place on the user's working tree** — silently, with no branch, no isolation, and no guardrail. This is the worst failure mode: an unnoticed dirty tree in a repo ticketloop doesn't know about. |
| `ensureClean` (non-worktree path) | one `git status` | Only one repo's cleanliness checked. |
| **exclude guardrail** | `changedFiles(workdir)` → one `git status --porcelain` | **Silent safety hole.** Changes in the sibling repos are invisible to `matchesAny`, so an off-limits path in `backend/` is never seen and never blocks. The guardrail's own docstring calls it "the ONE deterministic safety check" — on (a) it checks one of N repos. |
| `changed.length === 0` → fail | counts one repo | A ticket legitimately fixed entirely in a *sibling* repo reports "Fix step produced no file changes" and fails. |
| ship | model runs git+gh in `workdir`, harness parses **one** URL via `extractPrUrl` (first `/pull/\d+` match) | Two PRs → only the first is recorded. `rec.prUrl` is a single field. |
| cleanup | `removeWorktree(repoPath, workdir)` | Leaks: other repos' branches/worktrees never cleaned; failure path leaves an unknown number of dirty trees. |
| `RunRecord.prUrl` / dashboard | `string?`, one link (`app.js:293`) | No place to show PR 2 of 2. |
| `prompts.ts` | `if (workdir !== p.repoPath)` → "isolated worktree of X, do NOT create another branch" | Actively **wrong instruction** in multi-repo: the model *must* create branches in the other repos. |
| doctor / server | `existsSync(p.repoPath)`, `repoExists` | Reports healthy on a parent folder that contains no `.git`. |

Summary: on case (a) the loop doesn't error loudly — it **half-works and drops the safety guarantee**. That's the argument for treating this as a correctness issue, not a feature request.

---

## 3. The four hard questions

### 3.1 Which repo(s) does a ticket touch?

Three candidate mechanisms:

1. **Config declares** — ticket label/team → repo. Rigid; most tickets ("the login page is slow") genuinely span repos, and the user shouldn't have to pre-classify.
2. **Model decides up front** — extend `triage` to emit `REPOS: frontend, backend`. Cheap (triage already runs, already read-only, already parses `DECISION:`/`KIND:`), and it lets the harness prepare exactly the worktrees needed *before* `fix`. Risk: triage guesses wrong and the model then can't touch a repo it needs.
3. **Detect from the change** — run `git status` in every repo after `fix`; whatever is dirty is what's touched.

**Recommendation: (3) as the source of truth, (2) as a hint.** Detection is the only mechanism that cannot be wrong, and the guardrail must be detection-based anyway (a declared-repos list that disagrees with reality is exactly the hole we're closing). Triage's `REPOS:` line is used only to decide which worktrees to *pre-create*, and the harness must tolerate the model touching a repo triage didn't name — by preparing worktrees for **all** configured repos when in doubt (cheap: `git worktree add` is ~100 ms and disk-cheap).

Corollary: **prepare worktrees for all repos, ship only the dirty ones.** That is the design's central simplification — it removes the need to get repo attribution right.

### 3.2 Worktrees and cwd

Two viable layouts:

**Layout A — mirrored workspace (recommended).** Build a per-ticket *workspace directory* whose children mirror the parent folder's repo names, each child being a worktree of the corresponding repo:

```
~/.ticketloop/worktrees/myapp/MIL-123/
  frontend/   ← worktree of ~/dev/myapp/frontend  on ticketloop/mil-123
  backend/    ← worktree of ~/dev/myapp/backend   on ticketloop/mil-123
  infra/      ← worktree of ~/dev/myapp/infra     on ticketloop/mil-123
```

cwd for plan→ship = the **workspace root**. The model sees all repos side-by-side, relative paths look like the real project, cross-repo greps work, and every edit lands in an isolated worktree. Non-repo files in the parent folder (a top-level `README`, `docker-compose.yml`, scripts) are *not* mirrored — symlink them read-only, or accept that they're absent and expose the real parent path to the model as reference-only.

**Layout B — in-place, branch per repo** (`useWorktree: false` equivalent). cwd = real parent folder. Simple, and the only option when repos have submodules/absolute-path build config that breaks under worktrees. Requires `ensureClean` on every repo first and disturbs the user's working trees. Keep it as the escape hatch, not the default.

Rejected: **per-repo worktree with cwd = one repo.** It reintroduces exactly the blind spot in §2.

Practical worktree caveats to note in docs: `node_modules`/`vendor` are not copied into a worktree, so the `prepare` stage's "install deps" instruction now has to run **per repo** (N installs per ticket — a real wall-clock cost); `.env` files are usually gitignored and therefore absent — the biggest practical friction of worktree isolation, already true today but multiplied by N.

### 3.3 Branching + ship + N PRs

- **One branch name across all repos**: `ticketloop/<ticket-id>`. Same identifier everywhere makes the correspondence obvious to a human and makes re-processing (branch reuse, already implemented in `createWorktree`) work unchanged per repo.
- **Base branch per repo**: `defaultBranch()` per repo, overridable by `repos[].base`.
- **Ship becomes harness-orchestrated, per dirty repo.** Today `ship` is a free-text model stage that runs git+gh itself and the harness scrapes a URL. With N repos that's fragile — the model must be told which repos to ship, in what order, with what cross-links, and the harness must recover N URLs from prose. Two options:
  - **Ship-per-repo loop (recommended):** the harness iterates dirty repos and invokes the `ship` stage once per repo with `cwd = workspace/<repo>` and the repo injected into the prompt. Each invocation produces one PR URL, parsed with the existing `extractPrUrl`. Reuses all existing machinery; the only new logic is the loop and the result list. Cost: N ship invocations (ship is a cheap stage).
  - Single ship invocation with a structured `PRS:` output block. Fewer tokens, but re-introduces brittle multi-URL parsing.
- **Cross-linking.** PRs must reference each other, but PR 1's body can't contain PR 2's URL before PR 2 exists. Use a **two-pass link**: open all PRs first with a stable marker in the body (e.g. a `Part of ticketloop <ticket-id>` line + the ticket URL), then a final harness step edits each body (`gh pr edit --body`) to append the sibling list. Cheap, deterministic, no model involvement. A weaker v1: put only the ticket URL in each body and let the ticket comment carry the full PR list (Linear becomes the join point) — acceptable, and the ticket comment is where a human looks anyway.
- **Order.** For independent repos, order doesn't matter; ship in a stable, configured order for reproducibility. For **submodules (c)**, order is mandatory: child repos ship first, then the superproject commits the updated gitlink pointers and ships last, and the parent PR is only mergeable after the child PRs merge — which ticketloop cannot enforce (it never merges). Call this out in the ticket comment as a human instruction ("merge child PRs first, then the parent").

### 3.4 Guardrail, partial failure, cleanup

- **Guardrail**: `changedFiles` per repo, prefix each path with the repo name (`backend/internal/foo.go`) before `matchesAny`. Two exclude sources compose: the **project-level** `exclude` (matched against the repo-prefixed path, so existing `backend/migrations/**` patterns keep working unchanged) and the optional **per-repo** `exclude` (matched against the repo-relative path). Any hit in any repo blocks the whole run — no partial ship after a violation. The "no changes at all" check becomes "no changes in **any** repo".
- **Partial failure is the genuinely new failure mode.** PR 1 opens, PR 2's push is rejected. Rules:
  - Guardrail + review run **before** any ship, over the union of all repos, so a blocked run ships nothing.
  - Ship failures are **not rolled back** (never force-delete a pushed branch or close a PR automatically). Record per-repo status.
  - Outcome becomes `partial` (new `RunOutcome`) when ≥1 PR opened and ≥1 repo failed. The ticket comment must say plainly which repos shipped and which need a human.
  - Worktrees: remove only on **full** success; on partial/failure keep **all** of them for inspection (today's behaviour, per repo).
  - Re-processing a partially-shipped ticket must be safe — it is, because branch reuse already exists: the already-shipped repo's branch is reused and `gh pr create` on an existing PR fails harmlessly (the model/harness should detect an existing PR and update instead).

---

## 4. Recommended design

### 4.1 Config

`ProjectConfig` gains an optional `repos` list. `repoPath` keeps its meaning and becomes the **workspace root** when `repos` is present:

```yaml
projects:
  - name: myapp
    repoPath: /Users/me/dev/myapp        # parent folder (the workspace root)
    repos:                                # NEW — omit for single-repo (today's behaviour)
      - name: frontend                    # also the dir name in the workspace
        path: frontend                    # relative to repoPath (absolute allowed)
        base: main                        # optional; default = detected default branch
        exclude: ['src/lib/api/**']       # optional; repo-relative, adds to project exclude
      - name: backend
        path: backend
        base: develop
      - name: infra
        path: infra
        shipDisabled: true                # optional: readable for context, never edited/shipped
    exclude:                              # unchanged; matched against <repo>/<path>
      - backend/migrations/**
      - '**/*auth*'
    useWorktree: true
```

Semantics:
- **`repos` absent** → exactly today's behaviour. Zero migration, zero regression risk. This is the compatibility contract.
- **`repos` present** → `repoPath` is *not* required to be a git repo; it is the workspace root and the read-only cwd for `triage`/`clarify`.
- `shipDisabled` (or `readOnly`) is worth having: `infra`, or a vendored reference repo, should be greppable context but never edited. Enforce by treating any change there as a guardrail block.
- Validation (`validateProject` / `validate`): if `repos` is present it must be non-empty; each entry needs a unique `name` matching `^[\w.-]+$` and a `path` that resolves inside/next to `repoPath` and contains a `.git`; `useWorktree: false` + `repos` requires every repo clean before start.

Deliberately **not** doing: a separate `workspacePath` field, a `type: monorepo|multi|submodule` enum (detectable), or repo-level tracker/autonomy overrides (a ticket has one autonomy).

### 4.2 Engine flow (change path)

```
triage / clarify        cwd = repoPath (workspace root)  — sees all repos, read-only
                        triage additionally emits `REPOS:` (hint only, non-binding)
  ↓
setup                   for each repo in repos:
                          base = repo.base ?? defaultBranch(repo.path)
                          createWorktree(repo.path, workspace/<name>, ticketloop/<id>, base)
                        (all repos, not just the hinted ones)
  ↓
plan → prepare → fix    cwd = workspace root
  ↓
GUARDRAIL               for each repo: changedFiles(workspace/<name>)
                          → prefix with <name>/  → matchesAny(project.exclude)
                          → also matchesAny(repo.exclude) on the unprefixed path
                          → shipDisabled repo dirty ⇒ block
                        dirty = repos with ≥1 change; if dirty is empty ⇒ fail
  ↓
verify → review         cwd = workspace root (sees the whole cross-repo diff)
  ↓
ship                    for each repo in dirty (stable order; submodule children first):
                          run `ship` stage with cwd = workspace/<name>
                          parse PR URL → rec.prs.push({repo, branch, url, status})
                        then: harness edits each PR body to link siblings
  ↓
comment                 cwd = workspace root; prompt carries the full PR table
  ↓
cleanup                 remove all worktrees only if every repo shipped ok
```

### 4.3 Repo adapter

`Repo` methods are already `(cwd, …)`-shaped, so they need **no signature changes** — the engine just calls them N times. Additions worth having:
- `isGitRepo(path): boolean` — for validation/doctor.
- `linkPrs(cwd, prUrl, siblings): void` — wraps `gh pr edit --body`.
- optionally `existingPr(cwd, branch): string | null` — so re-runs update rather than fail.

`MockRepo` needs per-repo mock changed-file lists so the mock path exercises N repos.

### 4.4 Prompt changes (`prompts.ts`)

Replace the single "Working directory / isolated worktree of X" block with a workspace block when `repos` is present:

```
Working directory: <workspace root>
This directory is an isolated workspace containing one git worktree per repo in
this project, each already on branch ticketloop/<id>:
  - frontend/  → <origin url>, base main
  - backend/   → <origin url>, base develop
  - infra/     → READ ONLY: read for context, never edit
Make changes in whichever repo(s) the ticket requires. Do NOT create branches —
they already exist. Each repo will get its own commit, push and PR.
OFF-LIMITS paths (repo-prefixed): backend/migrations/**, **/*auth*
```

The `ship` stage prompt additionally names the single repo it is shipping and instructs it to reference the ticket URL in the body and **not** to touch other repos.

### 4.5 RunRecord / dashboard

```ts
export interface PrRecord {
  repo: string
  branch: string
  url?: string
  status: 'opened' | 'failed' | 'skipped'   // skipped = repo had no changes
  error?: string
}

interface RunRecord {
  prUrl?: string        // KEEP — first/primary PR, so existing UI + history keep working
  prs?: PrRecord[]      // NEW — populated on multi-repo runs
  // RunOutcome gains 'partial'
}
```

Backwards compatible: old records have no `prs`; the dashboard renders `prs` when present (a small list of `repo → PR ↗` links in the detail panel, `app.js:293`) and falls back to `prUrl`. Setup form (`app.js:816`) gains a repeatable repo row (name / path / base / exclude / read-only) behind a "This project contains multiple repos" toggle; the existing folder picker (`listDir`, which already reports `isGitRepo`) can offer to **auto-detect** child repos when the user picks a parent folder — that's the discoverability win and it's nearly free. `buildStatus`/`buildConfigView` report `repoExists` per repo.

### 4.6 Submodules (c)

Treat as case (a) with three deltas:
1. The superproject is just another entry in `repos` (path `.`), listed **last** in ship order.
2. After the child repos are pushed, the superproject's worktree must have its gitlinks updated to the pushed child commits before its own commit — a `git add <submodule-path>` in the parent worktree. Note that a parent worktree with submodules needs `git worktree add` followed by `git submodule update --init` in that worktree; this is fiddly enough that **v1 should recommend `useWorktree: false` for submodule projects**.
3. The comment must state the merge order (children first). Ticketloop cannot enforce it.

If submodule support is more trouble than it's worth for the first users, an explicit "not supported yet, use in-place mode" is an honest position — the pointer-bump semantics are where most of the risk lives.

---

## 5. v1 vs full design

**v1 (smallest thing that is correct and useful):**
1. `repos?: RepoEntry[]` in config + validation + doctor.
2. Workspace of worktrees; cwd = workspace root for all change-path stages.
3. **Guardrail over all repos** (repo-prefixed paths). ← the actual safety fix; ship this even if nothing else lands.
4. Ship loop over dirty repos; `prs[]` on `RunRecord`; `partial` outcome.
5. Ticket comment lists all PRs (no PR-body cross-links).
6. Prompt workspace block.
7. Submodules: documented as "use `useWorktree: false`", or unsupported.

**Shipped after v1:**
- **Re-processing branch default** (`resolveBranch` in `engine.ts` + `localBranchExists` in the repo adapter). The harness must put the worktree on *some* branch before any model step runs (a worktree needs a branch; the guardrail diffs against a base), so it picks a safe **default**: a fresh branch off the current base under an unused name (`ticketloop/<id>`, then `-2`, `-3`, …) → a clean **new PR** each re-processing. This matches the common reality (the prior PR is already merged & released). The harness does **not** decide new-vs-update-an-existing-PR — that judgment, if wanted, lives in the `prepare`/`ship` instruction, where the model runs `gh pr list` and checks out an open PR's branch itself. Unit-tested (5 cases). *(An earlier revision hard-coded the open-vs-merged PR decision via `gh pr list`; removed as harness over-reach — keep the mechanical default here, put the judgment in instructions.)*
- **Setup-form repo editor** (`app.js`): a "multiple repos" toggle + repeatable name/path/base/read-only rows, round-tripped to YAML.
- **Empty-branch cleanup** (`deleteBranch` in the adapter; success path in `engine.ts`): worktrees use the normal **branch-from-base** model (`git worktree add -b ticketloop/<id> … <base>`) — not detached HEAD (considered and rejected as non-idiomatic). Because all N worktrees are created up front, a repo the ticket never touches gets an empty branch; on **full success** the cleanup removes every worktree and then force-deletes the branch of each **untouched** repo (shipped repos keep theirs — the PR needs it). On failure, worktrees + branches are kept for inspection. Verified against the real `~/Development/hkbu` repos (branch created → deleted, no residue).

**Deliberately dropped** (owner preference — the harness must not decide/suggest process the model can own; the model decides): the triage `REPOS:` hint (which repo), and hard-coded new-vs-update-PR logic (goes in an instruction). **Also not built:** per-repo `prepare`/`testCmd` (handled by the per-step instruction instead) and submodule pointer-bump (out of scope).

**Full design still open:** two-pass `gh pr edit` cross-linking; folder-picker child-repo auto-detect.

Note there is a **cheap intermediate** for users who just want the model to *see* everything: set `repoPath` to the parent folder with `useWorktree: false` and `autonomy: clarify`. Question-answering across sibling repos works today with zero code change. That's worth documenting in the README immediately, independent of this spec.

---

## 6. Risks & tradeoffs

| Risk | Assessment |
|---|---|
| **Silent scope creep across repos** | Highest-value new risk: a "change the button label" ticket that also edits `backend/`. Mitigation: `review` explicitly asked to justify *each repo* it touched, and the comment lists PRs per repo so a human sees the blast radius immediately. Consider an optional `maxRepos: 1` per project. |
| **Cost / wall clock** | Prepare installs deps in N repos; ship runs N times; verify may need N test suites. A 3-repo ticket can be ~2–3× a single-repo one. Mitigate with the triage `REPOS:` hint (full design) and per-repo `shipDisabled`. |
| **Partial ship** | Genuinely unavoidable — no cross-repo atomic commit exists. Design contains it (guardrail before any ship, `partial` outcome, never auto-rollback) but the user must accept "2 of 3 PRs opened" as a real end state. |
| **Worktrees × N env friction** | `.env`, `node_modules`, absolute-path tooling. Already the sharpest edge of worktree mode; multiplying by N makes it the most likely source of "it failed in prepare" reports. `useWorktree: false` escape hatch is important. |
| **Reviewability** | Two PRs from one ticket are harder for a human to review as a unit. Cross-links + a ticket comment table are the mitigation; GitHub has no first-class cross-repo PR grouping. |
| **Config complexity** | `repos` is a second way to say "where's the code". Mitigate by making it purely additive (absent = today), auto-detecting children in the picker, and never requiring it for monorepos. |
| **Merge-order coupling (submodules / API-then-client)** | Ticketloop never merges, so it can only *tell* the human the order. Acceptable, but must be explicit in the comment or someone will merge the client PR first. |

## 7. Prior art (brief)

The converging pattern in 2026 tooling is a **declared workspace manifest of sibling repos + isolated per-repo worktrees + one agent view over all of them**: the "repo-of-repos" pattern uses a `repos.yaml` manifest so the agent reads the whole workspace and cross-references repos as one codebase; Augment's Intent runs implementor agents in isolated git worktrees against a spec spanning multiple services; GitHub's agentic workflows create cross-repo PRs by checking out target repos at mirrored locations so a deterministic handler can find them again. All three validate the two core choices here — **a manifest, and mirrored per-repo worktrees under one root**. None of them solves atomic cross-repo merge either; they all fall back to linked PRs plus a human merge order.

Sources: [repo-of-repos pattern](https://raffertyuy.com/raztype/repo-of-repos-pattern/), [multi-repo workspace strategy](https://medium.com/@sunghyunroh/multi-repo-workspace-strategy-the-structure-where-ai-coding-agents-actually-shine-4ed6b87fb11d), [Augment Code](https://www.augmentcode.com/tools/13-best-ai-coding-tools-for-complex-codebases), [GitHub cross-repo agentic workflows](https://github.blog/ai-and-ml/github-copilot/automating-cross-repo-documentation-with-github-agentic-workflows/)
