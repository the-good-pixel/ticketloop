# Live recovery pilot

Date: 2026-10-04
Branch: `fix/recovery-consolidation`
Recovery implementation: `5cd6478`
Codex credential fix: `3605d44`

## Method

Ran the committed code through the real `processTicket` entry point, using the
configured Codex subscription runner (`gpt-5.6-sol`), the MRM project credential,
Linear and GitHub. State was isolated under
`/tmp/ticketloop-live-pilot-20261004`; the normal daemon configuration and state
were not changed. The two ticket IDs were explicitly allowlisted.

The pilot used `standard@3`, a worktree off `origin/main`, default step instructions
and explicit permissions allowing a feature PR but denying merges and all
deployments. DEV steps were disabled. This tested the shared lifecycle and standard
workflow; it did not exercise the scheduler or the assigned `miles-loyalty@5`
custom workflow. Both tickets stayed in Backlog, outside the normal watched states.

## Results

| Ticket | Outcome | Evidence |
| --- | --- | --- |
| [MRM-226](https://linear.app/mrmiles/issue/MRM-226) | Answered | One author-scoped, operation-marked answer; triage replayed without a model call. |
| [MRM-227](https://linear.app/mrmiles/issue/MRM-227) | PR opened | Same saved run and worktree after pause; one PR and one final comment. |

MRM-226 paused after real triage. Its run ID remained `MRM-226-muthzesg-1` on
resume. The successful answer used one further model invocation and posted
[this comment](https://linear.app/mrmiles/issue/MRM-226/ticketloop-pilot-1-explain-miles-loyalty-validation-commands#comment-10c5cca2).
The answer's commands were checked against `frontend/deno.json` and
`backend/Makefile`.

MRM-227 paused after workspace preparation, before implementation. Its run ID
remained `MRM-227-muti84k4-1`, and its complete workspace descriptor matched the
paused record. The resumed process replayed triage and planning. PR lookup and
preparation reran as required by their declared recovery policies. Resuming made
seven model calls; the initial process made four.

[PR #705](https://github.com/the-good-pixel/miles-loyalty/pull/705) targets `main`
and contains one seven-line document, `docs/ticketloop-pilot-validation.md`.
Its head is `044bfe648654966f9a5d14f23bf0be7d11404f78`, with a short commit message
and no attribution footer. The frontend check passed with zero errors and 66
existing warnings. Verification and review passed before shipping. A single
[final comment](https://linear.app/mrmiles/issue/MRM-227/ticketloop-pilot-2-add-a-local-validation-checklist-document#comment-187915a7)
links to the PR. The PR remained open and unmerged.

Independent read-only checks confirmed one bot comment per ticket, matching
issue/author/operation markers, exactly one PR for the pilot branch, and no pending
operation records. The PR body also contains its operation marker. Successful
runs removed their checkpoints and left no registered child processes. DEV steps
were recorded as skipped. No merge or deployment occurred, and neither shared
repository acquired tracked changes from the pilot.

## Issue found and fixed during the pilot

Codex inherited the user's `shell_environment_policy.inherit = "core"`, which
removed `LINEAR_API_KEY` from commands executed by the agent even though Ticketloop
passed the key to the Codex process. The answer and waiting-report attempts stopped
without posting. The run correctly retained uncertain operation records.

The runner now supplies an explicit shell variable allowlist for steps with scoped
environment values. The allowlist contains core shell variables and the step's
own variables; credential values remain in the child environment and never enter
the prompt or command arguments. Subscription API billing keys are excluded.
Regression checks cover the argument construction and secret-value exclusion.
The full `npm run check` suite passed after the fix.

After the failed processes exited, author-scoped remote marker lookup confirmed
that neither attempt posted a comment. Both operations were locally reviewed as
`not-performed` while the pilot ticket was paused. The same run then resumed and
posted its answer successfully. No remote comment fallback was used.

## Limits

The live pilot covered normal pause/resume and real PR/comment delivery. Hard-crash,
corrupt-record isolation, deployment completion and scheduler cases remain covered
by isolated smoke checks rather than destructive live tests. GitHub's Detect
Changes check passed; code checks were skipped for this documentation-only PR.
The separate AI review also passed.

The normal daemon and custom workflow have not been switched to this branch.
Existing legacy and older workflow checkpoints still need the documented drain or
review before a wider rollout. Pilot raw records and verification snapshots remain
in the isolated state directory.
