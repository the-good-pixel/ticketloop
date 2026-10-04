# Ticketloop ADK evaluation

Private prototype for `@google/adk` 2.2.0. The adoption decision is **defer migration**; see [the report](../../docs/adk-workflow-evaluation.md).

Run from this directory:

```sh
npm ci
npm run typecheck
npm run evaluate
```

Tested on macOS with Node 26.8.1. The pinned SQLite driver requires Node >=22.17. The parent Ticketloop dependencies must also be installed with `npm ci` in the worktree root.

The experiment uses temporary state, mock coding-agent runners, ordinary disposable Node child processes, and a local SQLite database. No provider API keys or tracker credentials are required. Each test creates its own isolated state.

- `adapter.ts`: validated Ticketloop plan -> ADK graph, using shared step execution and Ticketloop checkpoints.
- `scenario.ts`: one executor and one mock scenario, in an independent process.
- `probes.ts`: native in-memory human-input resume.
- `recovery.ts` / `recovery-worker.ts`: fresh-process SQLite recovery, SIGKILL, and uncertain external-action completion.
- `node-probes.ts`: rerun policies, retries, timeout, and targeted child-process cancellation.
- `domain-probes.ts`: existing Ticketloop checkpoint, permission, quota, workspace, and bundle controls.
- `benchmark.ts`: five fresh-process import samples for each module.
- `evaluate.ts`: executes the comparison and probes, writes `results.json`.

A successful command confirms both passing behaviours and reproduced incompatibilities. Look at `compatible: false` and `existingGap: true` observations in the results. There is no ADK engine setting, live pilot, or automatic migration.

The adapter expands bounded iterations into graph nodes and targets `standard@2`; full arbitrary-workflow compatibility is unproven. Native SQLite recovery is measured separately from the adapter's use of Ticketloop checkpoints.
