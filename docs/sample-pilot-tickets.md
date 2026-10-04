# Sample pilot tickets

Create these tickets in the user's chosen tracker workspace, team and project.
Initially leave both outside the daemon's watched label/state. Enable one ticket
at a time after the reviewed fixes are ready and the intended code is running.
Do not enable deployment or automatic merging for this pilot.

## Ticket 1: Explain Ticketloop pause, stop and never-process

Please explain the difference between pause, stop and never-process in Ticketloop.
Include the relevant source files and what happens to the checkpoint for each
action. Answer on this ticket. No code changes or PR are needed.

Acceptance criteria:

- One answer comment in the correct tracker workspace.
- Explanation matches the current implementation and links to the relevant files.
- No repository changes, PR, merge or deployment.

Operator checks: confirm the question route, a real comment URL and a completed
operation record. Request a pause at a step boundary and resume once to check
that cached work is retained and no duplicate answer is posted. Do not deliberately
kill the shared daemon during this first live test.

## Ticket 2: Add a small operator checklist document

In the Ticketloop repository, add `docs/pilot-operator-checklist.md` with a short
checklist covering how to inspect status, pause a ticket, resume a ticket, and stop
a ticket. Use commands supported by the current CLI. Open a PR for review.
Keep the change limited to this new document. Do not merge or deploy.

Acceptance criteria:

- Only `docs/pilot-operator-checklist.md` changes.
- Commands match the CLI help.
- Type checking passes and one PR is opened against the intended base branch.
- One final tracker comment links to the PR.
- No merge or deployment.

Operator checks: pause at a step boundary after the isolated worktree exists,
resume, and confirm the run ID and worktree stay the same. Confirm completed
steps replay without another provider call. Confirm exactly one PR and one final
comment, with completed operation records. Keep destructive crash tests isolated
until a separate pilot process is available.

## Created MRM pilots

The actual MRM tickets target the configured Miles Loyalty repository rather than
Ticketloop: MRM-226 asks about repository validation commands; MRM-227 adds
`docs/ticketloop-pilot-validation.md`. Both are in Common Infrastructure, Backlog,
without labels. MRM watches Todo and In Review, so neither ticket is eligible yet.
