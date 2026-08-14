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
npm install --global ticketloop@latest
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
npm install --global ticketloop@0.1.0
```

Do not run old and new versions against the same state directory at the same time.

## Version policy before 1.0

- Patch releases contain fixes and compatible documentation or UI changes.
- Minor releases may change config, workflow, checkpoint, or command behavior.
- Every breaking or migration-relevant change must appear in the changelog.
