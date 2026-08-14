# Changelog

All notable changes are recorded here. Ticketloop follows semantic versioning, with the pre-1.0 rules in [UPGRADING.md](UPGRADING.md).

## Unreleased

### Added

- Full-screen visual workflow builder with project-specific immutable workflow versions.
- Categorized work and flow steps, triage branches, multiple non-nested loops, per-step model and effort settings, and editable default step instructions.
- Guided first-project setup that saves the daemon paused.
- Redacted `ticketloop support-bundle` diagnostics.
- Workflow execution and support-bundle smoke tests.
- Public security, contribution, issue, platform, and upgrade documentation.

### Changed

- Project cards show their assigned workflow and readiness.
- Activity uses plain outcome labels and shows only steps that ran.
- Continue run and Start over now explain checkpoint behavior.
- `ticketloop init` creates a minimal dashboard-first config.
- Fresh state directories are created before the first atomic state write.

### Security

- First-project setup requires a Linear opt-in label and pauses before adding the live project.
- Support bundles omit credential values, paths, private names, ticket content, prompts, agent output, raw errors, and external URLs.
