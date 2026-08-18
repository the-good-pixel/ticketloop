# Changelog

All notable changes are recorded here. Ticketloop follows semantic versioning, with the pre-1.0 rules in [UPGRADING.md](UPGRADING.md).

## Unreleased

## 0.2.0 - 2026-08-18

### Added

- Searchable run History with ticket IDs, project and outcome filters, date filters, sorting, pagination, and clearer run details.
- Live Claude subscription quota polling alongside Codex quota polling, with the source and age of each reading shown in the dashboard.
- Immediate Stop and permanent Never process controls, including a visible list where exclusions can be undone.
- Clear pause progress, per-ticket pause controls, and explanations for skipped or cancelled runs.

### Changed

- Waiting runs now use one standard `waiting` outcome with a structured blocker describing quota, approval, deployment, or an external system.
- Waiting records state why work stopped, whether resume is automatic or manual, and whether a safe checkpoint is available.
- Provider quota labels distinguish Codex model-specific limits and stale local Claude cache readings.

### Fixed

- Waiting runs keep their checkpoints and can continue from the blocked step when a safe checkpoint exists.
- Legacy waiting records remain readable and filterable without rewriting stored run files.
- New activity no longer silently revives tickets marked Never process.

## 0.1.0 - 2026-08-14

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
