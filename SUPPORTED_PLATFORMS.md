# Supported platforms

## Supported

- macOS on Apple silicon and Intel.
- Linux on x64 and arm64 where Node.js, Git, GitHub CLI, and the selected coding-agent CLI are supported.
- Windows through WSL2 using the Linux filesystem for repositories and Ticketloop state.
- Node.js 22 and 24, the current supported LTS lines. Automated checks cover both versions on macOS and Linux.

## Not supported

- Native Windows or PowerShell execution.
- Repositories stored on a Windows-mounted drive inside WSL2 when git worktree behavior or file permissions are unreliable.
- Exposing the local dashboard directly to a network or the public internet.
- Running several daemon processes against the same `TICKETLOOP_HOME`.
- Production deployment.

The selected Claude Code or Codex version may have stricter operating-system requirements than Ticketloop. Run `ticketloop doctor` after installing or updating provider CLIs.
