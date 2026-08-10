# Plan — Linear isolation · data-export path · PR-refresh · second project

Status: **BUILT** on `feature/linear-keys-data-pr-refresh` (steps 1–3 committed; step 4 is config-only — needs `ticketloop set-key hkbu`). Captures the decisions from the MRM-181 first-run review.

- **Step 1** (`0f9b4d8`, `5b27615`) — model owns posting via per-project `$LINEAR_API_KEY` (env, never in prompt); no harness poster; never the wrong-account MCP. clarify + comment.
- **Step 2** (`94976b1`) — data-export path: `data` triage kind + `export` stage → `plan → prepare → (export ↔ verify) → comment`, read-only, outcome `exported`, attaches the file; ticket attachments surfaced as readable files.
- **Step 3** (`<this branch>`) — `locate` step + adaptive `setupWorkspace` (reuse an open PR's branch remote-aware, Option-B guardrail base = tip at checkout; else fresh). Single-repo.
- **Step 4** — `hkbu` added to the (gitignored) user config as a multi-repo project (team HKB, frontend+backend). Global stage model → opus. **User must run `ticketloop set-key hkbu` and verify team/states/repos/exclude/skills.**

Reference: the live architecture artifact (three triage kinds, data path, locate step, per-project Linear keys).

---

## 0. Context — what the MRM-181 run exposed

The first real run shipped a correct PR, but surfaced three problems + motivated two features:

- The `comment` step (instruction: *"comment in the ticket directly"*) made the **model** post the comment itself, using the **global Linear MCP** — which is authed to a **different client's workspace (HKBU)**. It couldn't find the mrmiles ticket, so it (a) **named "HKBU"** in its output, (b) **fell back to posting on GitHub**, and (c) the harness then posted the model's *report* (with the HKBU mention) to Linear.
- Root: one Linear MCP = one account login; the harness already does Linear I/O per-project via stored **API keys**, but the model was reaching for the MCP.

---

## 1. Linear is per-project, key-driven — the model never uses the Linear MCP

- The harness already reads/posts Linear with each project's **own API key** (`ticketloop set-key`). That's inherently multi-account — mrmiles ticket → mrmiles key, HKBU ticket → HKBU key.
- **Change:** pass that project's Linear API key + how-to (API/CLI) **into the comment / clarify / export steps**, and instruct the model to use *that key* for this ticket — never the Linear MCP connector.
- Keep all other MCPs (browser, etc.). **Do NOT `--strict-mcp-config`** (the user needs the other MCPs).
- **Settled: the model posts, the harness never does.** Post steps (`clarify`, `comment`, later `export`) get the key as `$LINEAR_API_KEY` (env, never in the prompt) + a posting contract (use the API with that key, never the MCP, end with `— 🤖 via ticketloop`, report `COMMENT_URL:`). The harness only parses `COMMENT_URL`. No harness fallback poster — the model owns posting (it also needs the key to attach the export file on the data path). Re-trigger detection relies on the model including the `via ticketloop` marker (enforced by the contract).
- **GitHub:** the Linear↔GitHub *Issue Sync* (the `#574` mirror + "synced to GitHub" notice) is a **Linear workspace integration the user disables in Linear** — not ticketloop. Once the model stops posting to GitHub (above), ticketloop's only GitHub touch is opening the code PR (intended).
- **Dropped:** changing the `— 🤖 via ticketloop` footer. User wants to **keep the branding** (the hidden marker wasn't actually hidden in Linear).

## 2. Data-export path (new triage kind)

Example: **MRM-182 "Export Member List"** — client asks to export the member list w/ opt-in status; **the ticket attaches a read-only prod-DB `.env`**. Source, creds, format, PII rules all come from the **ticket + instruction**, never the harness.

- **Triage gains a third kind:** `question` | `data` | `change`.
- **Path:** `plan → prepare → export → verify → comment`. Read-only — **no worktree / branch / PR**; runs in the repo checkout like clarify.
  - `plan` — what to pull, how, output format.
  - `prepare` — read-only; pull creds/source from the ticket, connect.
  - `export` — run the pull, build the file (CSV/Excel).
  - `verify` — VERDICT: is the data correct? re-export (↺) if not.
  - `comment` — attach the file to the ticket via the project's Linear key.
- **Two harness capabilities needed** (everything else = instruction/env):
  1. Download **all** ticket attachments (not just images) so the model can read the `.env`.
  2. Comment **with a file attachment** — the model uploads/attaches via the project's Linear key.

## 3. Follow-up / refresh an existing PR

Example: **HKB-933** — PR opened by a **human/other agent** (arbitrary branch name), user added feedback.

- **New `locate` step** (LLM, read-only, in the repo checkout) at the top of the change path. Finds an **open** PR for this ticket any way it can (gh pr list / search, the Linear ticket's PR link, branch names). Emits a machine-readable line:
  ```
  REUSE: <branch>     ← open PR to refresh
  REUSE: none         ← fresh
  ```
- **`setupWorkspace` becomes conditional (per repo):**
  - **fresh** (`none`) — unchanged: `resolveBase` → `origin/main`; fresh unused branch; `worktree add -b … origin/main`.
  - **reuse** (`<branch>`) — `git fetch origin <branch>`; **remote-aware `createWorktree`** checks out that branch (restore the fetch/track logic previously removed); fix-loop edits it; **ship pushes → updates the same PR**.
- **Guardrail base on a reused PR = Option B:** base = the PR branch's **tip at checkout**, so the guardrail polices **only the model's new delta**, not the human's already-made (possibly approved, possibly off-limits) PR changes. Tell the model not to rebase/pull main on a reused branch so the diff stays clean.
- **Fallbacks:** located branch won't fetch, or PR is merged/closed → **fresh**. Harness verifies before trusting locate.
- **Multi-repo:** ship `locate`/reuse **single-repo first** (refreshes are ~always one repo); extend per-repo later.
- Merged/closed prior PR → fresh (matches the earlier "re-processing = fresh PR" rule); only an **open** PR is reused.

## 4. Second project — hkbu

Add `hkbu` as a second project (own `repoPath`, own Linear key via `ticketloop set-key hkbu`, own team/states/exclude) so the loop covers both mrmiles and HKBU. This is what exercises the per-project Linear-key isolation end to end.

---

## Suggested build order
1. Per-project Linear key passed into comment/clarify/export steps (keep MCPs). ← fixes the leak + GitHub-posting.
2. `data` triage kind + `plan→prepare→export→verify→comment` path + attachment download & upload.
3. `locate` step + conditional `setupWorkspace` (reuse w/ remote-aware checkout, Option-B guardrail base) + ship-updates-PR.
4. Add `hkbu` as the second project; end-to-end test on HKB-933 (PR refresh) and an MRM data-export ticket.
