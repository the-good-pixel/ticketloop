# Security policy

Ticketloop runs coding agents against local repositories with broad tool access. Treat every tracker ticket and comment as trusted input from your own team. Do not connect Ticketloop to a public or untrusted ticket source.

## Report a vulnerability

Do not open a public issue for a security problem.

Use [GitHub private vulnerability reporting](https://github.com/the-good-pixel/ticketloop/security/advisories/new). Include the affected version, impact, and a small reproduction when possible. Do not include real API keys, customer data, private repository code, or unredacted Ticketloop state.

We will acknowledge a report within five business days. We will publish a fix and advisory after affected users have a reasonable update window.

## Supported versions

Before the first stable release, only the latest published version receives security fixes. After `1.0.0`, the latest minor release will be supported.

## Security boundaries

- Ticketloop binds the dashboard to `127.0.0.1` by default. Do not expose the dashboard directly to the internet.
- Provider subscription mode removes provider API-key variables from agent child processes.
- Linear keys stored with `ticketloop set-key` live in the local Ticketloop data directory with user-only file permissions where supported.
- Change work uses isolated git worktrees by default. Exclude rules block a run before a pull request when protected paths changed.
- Workflows request authority; project permissions grant it. Production deployment is never supported.
- Pull requests are the review boundary. Keep automatic merging and dev deployment off unless the project has an explicit, reviewed policy.

Run `ticketloop support-bundle` for diagnostics that are designed to be safe on a public issue. Review any attachment yourself before uploading it.
