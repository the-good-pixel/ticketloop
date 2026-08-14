# Contributing

Ticketloop welcomes bug reports, workflow feedback, documentation fixes, and focused code changes.

## Before coding

For a bug, open the bug-report form and attach a redacted report from:

```bash
ticketloop support-bundle
```

For a larger feature, open a feature request first. Workflow and safety changes often affect the engine, catalog, dashboard, resume data, and mock runner together. Agreeing on behavior first avoids wasted work.

Never post API keys, environment values, ticket content, private repository paths, agent output, or customer data.

## Local setup

Requirements: Node.js 22 or 24, Git, and either Claude Code or Codex CLI.

```bash
npm install
npm run check
npx tsx src/cli.ts demo
```

`demo` uses mock tickets and a mock runner. It spends no provider quota and makes no network request.

## Pull requests

- Keep each pull request focused.
- Add or update a smoke script for engine, resume, safety, or redaction behavior.
- Run `npm run check` before opening the pull request.
- Test dashboard changes in a real browser.
- Do not add a build step or frontend framework. The project runs TypeScript through `tsx` and serves plain HTML, CSS, and JavaScript.
- Do not weaken worktree isolation, protected-path checks, permission validation, or the no-production-deployment rule.
- Do not add generated attribution footers to commits.

By contributing, you agree that your contribution is licensed under the repository’s MIT license.
