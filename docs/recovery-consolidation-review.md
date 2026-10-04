# Recovery and consolidation review

Reviewed the uncommitted changes on `fix/recovery-consolidation`, based on
`68ebe6f54c2c8d92d2e8feb04a1b7cc1c5687afc`.

## Findings closed locally

### R1 — High, fixed: successful deployments remain uncertain forever

`completeOperations` ignores effects other than `create-pr` and `tracker-comment`.
The built-in deploy step declares `deploy-dev`, so even a successful deployment
with a passing verdict leaves its operation pending. After the run completes,
new human activity on the same ticket starts a new run, which the engine blocks
because the previous run has an uncertain external action.

The resolution command cannot confirm a completed deployment: only comment and
PR URLs are accepted. Marking a performed deployment `not-performed` would be
incorrect and could allow another deployment.

Reproduction: prepare a `deploy-dev` operation, complete it with
`Deployment succeeded. VERDICT: pass`, then query uncertain operations for a
different run. Result: one pending operation.

Required closure: persist confirmed completion for deployment effects; provide
an honest operator resolution for interrupted deployments. Keep genuinely
uncertain deployment attempts blocked. Verify a clean deployment does not block
later ticket activity, and an interrupted deployment does not retry automatically.

### R2 — Medium, fixed: one corrupt operation blocks every project

`listOperations(ticketKey)` reads and validates every operation file before
filtering by ticket. An unreadable record throws before the filter. Since every
real run calls `uncertainOperations`, a corrupt record belonging to one ticket
blocks unrelated tickets and projects as well. The inspection command also fails,
and the error does not identify the corrupt file.

Reproduction: create an invalid JSON file with a valid operation filename under
an isolated operations directory, then list operations for another ticket.
Result: `Unreadable external-operation record; recovery needs review.`

Required closure: preserve corrupt records and stop affected recovery, while
isolating records by ticket so unrelated projects remain usable. Identify the
record that needs repair. Verify corruption cannot silently permit a duplicate
external action.

## Validation

`npm run check` passed during this review, including type checking, JavaScript
syntax checks and all smoke scripts. Both findings were reproduced with an
isolated temporary state directory. No provider inference, remote writes or
deployments were performed. Existing checks do not cover these two failures.

Live pilot should follow closure of R1 and R2. Review follow-up should check these
findings and changes introduced by their fixes.

## Closure checks

R1: explicit passing DEV deployment verdicts now complete the operation. Failed,
waiting, skipped and missing verdicts remain uncertain. A paused operator can
record `performed` with evidence for a verified completed DEV deployment; resume
replays the saved passing result rather than deploying again.

R2: ownership metadata is persisted before operation records. Ticket-scoped
checks filter by ownership before parsing records. Corrupt owned records block
their ticket and preserve evidence; unrelated tickets remain usable. Valid older
records acquire ownership metadata when inspected. Corrupt older records with no
ownership still block runs conservatively because the affected ticket cannot be
identified safely. Error messages identify the damaged file.

The smoke suite now covers these cases. Full checks passed after the fixes.
Pilot tickets MRM-226 and MRM-227 were created in Common Infrastructure, Backlog,
without labels. Their isolated live runs passed; see [live-pilot-results.md](live-pilot-results.md).
