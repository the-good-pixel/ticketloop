# Recovery and executor consolidation

Date: 2026-10-04
Baseline: `68ebe6f`
Branch: `fix/recovery-consolidation`
Status: implemented and verified locally; no live rollout.

## Changes

- New runs use the workflow interpreter, defaulting to `standard@3`. The stable engine entry owns run records, checkpoint selection, images and finalization. Legacy execution is lazy-loaded only for existing legacy checkpoints. Old empty checkpoints retain legacy routing, and a missing run-history file does not change their operation identity.
- New checkpoints save a JSON execution-plan snapshot with an integrity checksum. Resume uses resolved saved instructions and step definitions instead of compiling the current catalog. Current permissions and excluded paths still apply. Changed repository, runner, tracker or MCP configuration suspends recovery before cached history is overwritten.
- Plan digests now include resolved step definitions and execution settings. Older workflow checkpoints without a matching digest stop for review. A damaged checkpoint is preserved rather than treated as a fresh run. A missing saved worktree also requires review.
- External-effect steps save durable intent records before invoking the model. Records remain after cancellation, checkpoint deletion and new activity. Pending actions from another run prevent a new real run from bypassing recovery checks.
- Interrupted tracker comments can be recovered by exact operation marker, issue and current API author. Lookup paginates comments and uses the project's own key. PR recovery looks for the existing head branch in the target repository. Ambiguous or failed lookup, or uncertain absence, does not authorize an automatic retry.
- Recovered PRs still go through shipping checks. Recovering a comment does not manufacture an unsaved gate verdict. Steps combining comment delivery with other effects require review rather than blindly repeating the step.
- Local `operation list` and `operation resolve` commands let an operator record a reviewed artifact or verified absence. Resolution requires a paused ticket with no running step and a review reason; it sends no remote request.
- Existing stage overrides, model-to-provider inference, runner effort defaults, explicit execution profiles, built-in loop limits and clarify-only autonomy are retained. Shared workspace safety stays in one module. Legacy-only dead helpers were removed, and ticket-text assembly no longer loads the legacy prompt builder for new runs.
- Dashboard/default configuration, history filters, examples, changelog and agent guidance describe the new execution path.

## Verification

`npm run check` covers type checking, dashboard JavaScript syntax and all smoke scripts. The added verification scripts also passed a separate strict TypeScript check.

The original and updated workflow interpreters produced matching normalized traces for 17 `standard@2` scenarios: question, data, bug, change, no action, ineligible, verification/review/shipping repairs, shipping/DEV approval waits, no progress, pause/resume, shipping error/resume, Codex, multiple repositories and forbidden paths. Comparison includes step order/status, replay, verdicts, output, artifacts, PR/comment references and outcomes. Explicit provider metadata is excluded from trace equality because the new compiler now resolves it; Codex selection is asserted separately. The retained result is [recovery-trace-comparison.json](recovery-trace-comparison.json).

Focused recovery checks cover changed instructions, saved-plan integrity, corrupt checkpoint preservation, permission revocation, changed repository context, run-history preservation, new activity, legacy question/change/bug/data recovery, empty legacy checkpoints, provider inference, explicit profile effort, quota denial/resume, uncertain actions, reviewed retry decisions and model-owned comment delivery recovery.

Fresh-process SIGKILL checks cover interruption before a request, after simulated remote success but before local save, and after saved completion. Repeated resume does not duplicate the simulated action. PR recovery requires remaining checks rather than creating another PR.

Scheduler checks cover two configured parallel slots, stop at a step boundary, cancelled outcome, checkpoint deletion, no retry, never-process filtering and targeted child-process-group termination without killing another ticket's child. Dashboard HTTP checks cover workflow default/assignment, recovery filters and old record readability. Remote lookup checks use fake HTTP and a disposable fake `gh` executable to exercise credential/issue/author scope, pagination, ambiguity and tool/network failure without remote traffic.

Reproduction:

```sh
npm ci
npm run check
# Optional comparison against the original checkout's src directory:
node --import tsx scripts/compare-workflow-traces.ts /absolute/baseline/src
```

All mock state, disposable children and the test HTTP server are isolated from the live daemon. No model inference, live tracker/GitHub writes, daemon restart, deployment, commit or push was performed.

## Remaining operational work

A read-only inspection of the live checkpoint directory found one clearly legacy checkpoint, six workflow checkpoints and seven checkpoints with insufficient metadata for confident classification. These counts are a point-in-time observation, not a rollout approval. Older-format checkpoints without workflow identity conservatively use legacy recovery; they are not translated into workflow output keys.

The compatibility executor and legacy prompt builder must remain until old checkpoints finish or the user explicitly abandons them after checking remote actions. Deleting those modules now would break recovery. New runs cannot select that executor. The shared checkout and live configuration remain unchanged.

Before a live upgrade, review existing workflow checkpoints that lack snapshots, resolve uncertain actions, validate each project's workflow and permissions, and choose a controlled restart. The default `standard@3` data path is narrower than the old legacy path; malformed triage values stop safely and external waits suspend rather than trigger repairs. These are intentional workflow behaviours, not claims of complete legacy trace equality.

PR/comment recovery is the supported automatic scope. Interrupted deployments and other effects require review. Records are retained indefinitely pending a separate retention policy. Remote visibility and model-owned writes do not provide an exactly-once guarantee. Actions made before operation records existed cannot be reconstructed reliably from local output alone.
