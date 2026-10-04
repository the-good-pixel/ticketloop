# Upgrading Ticketloop

Ticketloop is pre-1.0 software. Read [CHANGELOG.md](CHANGELOG.md) before every update.

## Update

1. Pause Ticketloop and stop the daemon.
2. Back up the local state directory and workspace config.
3. Install the new version.
4. Run the checks below before resuming.

```bash
ticketloop pause
# Stop the foreground process or user service.
cp -R ~/.ticketloop ~/.ticketloop.backup
npm install --global @the-good-pixel/ticketloop@latest
ticketloop --version
ticketloop doctor
ticketloop workflow validate
ticketloop watch
```

Open Projects and Workflows while the daemon is paused. Confirm each project is Ready and still points to the intended immutable workflow version, then resume from Activity.

Config migrations run when a config is loaded and are saved on the next dashboard edit. Ticketloop does not rewrite immutable user-created workflow or step versions. A compatibility migration may move an old built-in standard-workflow pin to a safer built-in version; the changelog will call out such changes.

## Roll back

Stop the daemon, reinstall the exact prior npm version, and restore the backup only if the newer version changed local state incompatibly:

```bash
npm install --global @the-good-pixel/ticketloop@0.1.0
```

Do not run old and new versions against the same state directory at the same time.

## Version policy before 1.0

- Patch releases contain fixes and compatible documentation or UI changes.
- Minor releases may change config, workflow, checkpoint, or command behavior.
- Every breaking or migration-relevant change must appear in the changelog.

## Workflow executor and recovery changes

New runs use the workflow interpreter. Projects without an `engine` setting use their assigned workflow, defaulting to `standard@3`. Existing stage overrides, provider choices, loop limits, and clarify-only autonomy apply to the built-in standard workflow. Explicit `engine: legacy` blocks new runs with migration guidance. Existing legacy checkpoints, including empty checkpoints in the old format, retain the legacy executor regardless of the project's new engine setting.

New workflow checkpoints include the resolved plan and an integrity checksum. Continue keeps that plan even if instructions or catalog versions change. Current permission restrictions and excluded paths still apply. Changes to repository, runner, tracker or MCP configuration require review. Older workflow checkpoints without a snapshot must match the current digest; the stronger digest now includes resolved step definitions, so checkpoints created by older releases may require review rather than automatic continuation.

External-action records live in `~/.ticketloop/operations` and survive checkpoint removal, stop requests, and new ticket activity. Records are retained until a separate retention policy is introduced. A pending action from an older run blocks a new real run. Inspect and resolve reviewed operations with the commands documented in README; do not delete pending records to force a retry. Existing actions made before these records were introduced cannot be reconstructed reliably from local output alone.

The legacy compatibility module cannot be removed until old checkpoints have finished or been explicitly abandoned after review. No live project settings or checkpoints are changed by the source update alone.
