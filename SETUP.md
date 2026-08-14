# Setup guide

This guide takes a private tester from installation to one controlled live ticket.

## 1. Check the machine

Install Node.js 22 or 24, Git, and GitHub CLI. Log in to at least one coding-agent CLI:

```bash
node --version
git --version
gh auth status
claude --version
codex --version
```

Claude Code and Codex CLI are alternatives. Both may be installed, and each workflow step can choose one.

## 2. Install and run the offline demo

```bash
npm install --global ticketloop
ticketloop --version
ticketloop doctor
ticketloop demo
```

Demo mode uses a simulated agent and built-in tickets. No provider quota, Linear key, or network access is used. Stop it with `Ctrl-C`.

## 3. Create the local workspace

The config can live in any folder. It does not need to be inside the project repository.

```bash
mkdir -p ~/ticketloop-workspace
cd ~/ticketloop-workspace
ticketloop init
ticketloop watch
```

Open [http://127.0.0.1:4317/#setup](http://127.0.0.1:4317/#setup).

The first-project setup asks for:

- a short project name;
- the normal local git checkout;
- the visual workflow;
- an optional Linear team key;
- a required opt-in label;
- eligible Linear states;
- the project’s Linear API key.

The key is stored in `~/.ticketloop/credentials.json`, not in YAML or the browser response.

## 4. Review before the first scan

The first project is saved paused. Before resuming:

1. Confirm the project card says Ready.
2. Open Edit workflow and inspect every path.
3. Keep the project policy at PR for review.
4. Keep dev deployment and merge permissions off.
5. Add exclude rules for migrations, authentication, billing, secrets, generated files, infrastructure, or other sensitive paths.
6. Run `ticketloop workflow validate`.
7. Create or choose one small Linear test ticket.
8. Add the exact opt-in label and put the ticket in one eligible state.

Resume from Activity. Watch the first run and review the resulting comment or pull request manually.

## 5. Customize the workflow

Use Workflows in the dashboard. Select a project before editing.

- Work steps are reusable prompts and instructions from the catalog.
- Flow steps control triage, branches, and loops.
- Multiple loops may appear on one path; nested loops are rejected.
- Each work step and triage can choose a provider, model, and effort.
- Editing the shown default instruction creates a new default step version. Existing workflows stay pinned until updated.
- Saving a project edit creates and assigns a new immutable workflow version for that project.

Use Continue run after an interruption. Use Start over when a change to an earlier step must apply to the whole ticket again.

## 6. Advanced configuration

The complete reference is [ticketloop.config.example.yml](ticketloop.config.example.yml). Common settings include:

```yaml
runner:
  defaultProvider: claude
  providers:
    claude:
      authMode: subscription
      defaultModel: opus
      defaultEffort: medium

tracker:
  type: linear
  simpleLabel: ai-loop
  states: [Todo, Backlog]
  pollIntervalSec: 300
```

For a multi-repo project, `repoPath` is the parent workspace and `repos` lists each repository. A read-only repository uses `shipDisabled: true`. Each changed writable repository gets its own pull request.

Do not store keys directly in the config. Use the first-project form or:

```bash
ticketloop set-key PROJECT_NAME
```

## 7. Run controls

```bash
ticketloop watch
ticketloop status
ticketloop pause
ticketloop resume
ticketloop pause APP-123
ticketloop resume APP-123
ticketloop run --ticket APP-123
```

`watch` keeps polling. `run` performs a one-shot scan. A ticket-specific `run` bypasses normal state selection, so use it only when you intend to process that ticket immediately.

## 8. Background service

First prove the foreground process works. Then use the service manager for the operating system.

Find the installed command:

```bash
command -v ticketloop
```

For macOS, create a user LaunchAgent that runs:

```text
/absolute/path/to/ticketloop watch --config /absolute/path/to/ticketloop.config.yml
```

For Linux, create a `systemd --user` service with the same command as `ExecStart`.

Do not expose port `4317` publicly. Keep the dashboard bound to `127.0.0.1`. Keys stored with `ticketloop set-key` are loaded from the user’s Ticketloop home, so the service must run as the same user.

## 9. Diagnostics

```bash
ticketloop doctor
ticketloop workflow validate
ticketloop support-bundle
```

The support bundle is designed for a public issue, but review the JSON before uploading it. Security problems must use GitHub private vulnerability reporting.

## 10. Update or remove

See [UPGRADING.md](UPGRADING.md) before updating.

```bash
npm install --global ticketloop@latest
npm uninstall --global ticketloop
```

Uninstalling the package does not delete `~/.ticketloop` or a workspace config. Keep those files for reinstalling, or move them to Trash after confirming they are no longer needed.
