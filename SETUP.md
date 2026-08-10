# Setup & usage walkthrough

A step-by-step guide from zero to a running loop. Follow it in order.

## 0. Prerequisites

- **Node ≥ 20** — `node --version`
- **`claude` CLI, logged in** — `claude --version`, and make sure `claude` opens
  without asking you to log in (that means your Pro/Max subscription is active).
- **`git`** and, for opening PRs, **`gh`** logged in — `gh auth status`.
- A **Linear API key** — Linear → Settings → Security & access → *Personal API keys*
  → create one. It looks like `lin_api_...`.

## 1. Install

```bash
cd ticketloop
npm install
npm link          # optional: makes `ticketloop` available everywhere
```

Without `npm link`, run commands as `node bin/ticketloop.mjs <command>`.

## 2. Try it with zero setup (demo mode)

```bash
ticketloop demo
```

- Runs the loop against **built-in demo tickets** with a **simulated** agent — no
  Linear, no `claude` calls, **no quota spent**.
- Open the dashboard it prints (http://127.0.0.1:4317).
- You'll see: one client **question answered**, two small **changes → mock PR**, and
  the quota meters filling. Click any run to expand its per-stage detail.
- `Ctrl-C` to stop.

This is the fastest way to understand what the tool does before wiring real accounts.

## 3. Configure for a real project

```bash
ticketloop init
```

This writes `ticketloop.config.yml` (globals + an empty/example project list).

> **Easiest path — set projects up in the dashboard.** Run `ticketloop watch`, open the
> dashboard, and use the **Setup** tab to add each project and paste its Linear key,
> one at a time — no YAML, no env vars. The globals (auth, quota, poll interval, tracker
> defaults) stay in the config file and show read-only there. The rest of this section is
> the equivalent by hand if you prefer editing the file.

Open `ticketloop.config.yml` and set, at minimum:

```yaml
tracker:                       # defaults shared by all projects
  type: linear
  simpleLabel: ai-loop         # only tickets with this Linear label are picked up
  states: [Todo, Backlog]

projects:
  - name: my-app
    repoPath: /absolute/path/to/my-app     # your normal checkout — NOT a clone
    autonomy: propose                       # open PRs, you merge
    useWorktree: true                       # isolate each change in a git worktree (default)
    tracker:
      team: MIL                             # this project's Linear workspace (key via set-key)
    exclude:                                # NEVER auto-edit these
      - "**/migrations/**"
      - "**/*auth*"
      - "**/*timezone*"
    testCmd: "npm run check"                # the model runs this in the verify step
```

> **No clone needed.** Each change runs in an isolated **git worktree** off your repo
> (`~/.ticketloop/worktrees/<project>/<ticket>`), created before the change and removed
> after. Your working tree is never touched. Point `repoPath` at your normal checkout.

**Label your safe tickets.** In Linear, add the `ai-loop` label (or whatever you set in
`simpleLabel`) to tickets you're happy for the loop to handle. It only ever looks at
labelled tickets in the listed states — a dedicated label is your on/off switch.

### Store your keys in the daemon (no env vars)

Store each project's Linear key once; it's saved to `~/.ticketloop/credentials.json`
(chmod 600) and used automatically:

```bash
ticketloop set-key my-app        # prompts for the key (hidden), saves it
ticketloop set-key other-app     # a different workspace/account
```

> **Multiple Linear workspaces/accounts?** That's exactly why keys are per-project —
> `set-key <project>` stores each one separately, and each project polls only its own
> workspace. (`gh` is already authed from `gh auth login`; nothing else needed for GitHub.)

### Check everything

```bash
ticketloop doctor
```

Fix anything it flags. In particular, in **subscription mode** it will warn if
`ANTHROPIC_API_KEY` is set — unset it in your shell to avoid accidental metered
billing elsewhere (ticketloop already scrubs it for its own `claude` calls).

## 4. Run it

Dry-run a single scan without committing to the daemon:

```bash
ticketloop run                 # process all eligible tickets once, then exit
ticketloop run --ticket MIL-123   # just one ticket
```

Then run the daemon for real:

```bash
ticketloop watch
```

- It polls Linear every `pollIntervalSec` (default 5 min), processes each new eligible
  ticket, and serves the dashboard.
- Questions get an **answer comment**. Changes get a **branch → PR** and a comment
  linking it. It **stops at the PR** — you review and merge.
- Watch progress live on the dashboard, or `ticketloop status` in another terminal.

## 5. Keep it running in the background (macOS `launchd`)

Create `~/Library/LaunchAgents/com.ticketloop.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ticketloop</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/ticketloop/bin/ticketloop.mjs</string>
    <string>watch</string>
    <string>--config</string>
    <string>/absolute/path/to/ticketloop.config.yml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- Linear keys come from `ticketloop set-key` (stored in ~/.ticketloop),
         so no API keys are needed here. Just PATH for node/git/gh/claude. -->
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart on CRASH, but not on a clean exit (so `SIGTERM`/stop stays stopped),
       and throttle restarts so a ticket that reliably crashes can't hammer. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/tmp/ticketloop.log</string>
  <key>StandardErrorPath</key><string>/tmp/ticketloop.err</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.ticketloop.plist   # start on login + now
launchctl unload ~/Library/LaunchAgents/com.ticketloop.plist # stop
tail -f /tmp/ticketloop.log                                  # watch logs
```

> `which node` to get the right node path for `ProgramArguments`. The loop is a
> catch-up poller: if your machine sleeps, tickets simply wait and are picked up when
> it wakes.

**Linux (`systemd --user`):** create `~/.config/systemd/user/ticketloop.service` with
`ExecStart=/usr/bin/node /path/to/bin/ticketloop.mjs watch --config /path/to/config`
(keys already stored via `set-key`), then `systemctl --user enable --now ticketloop`.

## 6. Where state lives

- Config: `./ticketloop.config.yml` (or `~/.ticketloop/config.yml`).
- Usage + run history: `~/.ticketloop/usage.jsonl`, `runs.jsonl`, `daemon.json`.
  (Override the directory with `TICKETLOOP_HOME`.)
- Delete these to reset history/quota tracking.

## 7. Tuning

- **Meters look wrong?** Adjust `quota.sessionTokenBudget` / `weeklyTokenBudget` — they
  are estimates, not official numbers.
- **Loop too eager / too shy?** Tighten or loosen the triage by editing the `triage`
  stage `instruction`, and curate the `exclude` globs and which tickets you label.
- **Cost control = scope control.** Keep `defaultModel: sonnet`; only raise a specific
  stage to `opus` if you genuinely need it. Narrow `exclude`/label discipline keeps
  runs small, which keeps them both safe and cheap.
