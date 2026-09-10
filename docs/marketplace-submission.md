# Codex marketplace submission package

## Listing

- Name: codex-sdlc
- Publisher: vimihi
- Type: Skills only
- Category: Productivity
- Short description: Evidence-backed software delivery workflows for repository projects.
- Website: https://github.com/prime-vimihi/codex-sdlc
- Support: https://github.com/prime-vimihi/codex-sdlc/blob/main/SUPPORT.md
- Privacy: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/privacy.md
- Terms: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/terms.md

Long description:

Initialize and operate resumable, repository-scoped software delivery with specialized workflows for requirements, backend, web and mobile implementation, integration, independent quality control, and Product Owner review. codex-sdlc records tasks, approvals, evidence, defects, and release decisions in the repository so delivery can be validated and resumed. It also manages installation, upgrades, rollback, and uninstall for existing Go, Next.js, and Flutter projects, with PostgreSQL and Redis presets.

## Starter prompts

1. Initialize codex-sdlc for this existing Next.js repository and validate the setup.
2. Configure this combined Go, Next.js, and Flutter repository with PostgreSQL and Redis.
3. Start a codex-sdlc delivery run for this feature affecting the backend and web application.
4. Resume the active codex-sdlc run and execute the next eligible task with required evidence.
5. Independently verify this integrated feature against its approved acceptance criteria.

## Positive tests

1. Web-only initialization creates a valid Next.js configuration, restores the pinned runtime, and passes `doctor` and `validate-config`.
2. Combined initialization selects separate Go, Next.js, and Flutter roots plus PostgreSQL and non-authoritative Redis settings.
3. Lifecycle management previews changes, backs up an upgrade, restores it through rollback, and previews a bounded uninstall.
4. Business analysis produces the seven required typed artifacts with stable identifiers and one-to-one fact reconciliation.
5. Complete delivery advances requirements, implementation, integration, independent QC, and Product Owner review with valid authority and command evidence.

## Negative tests

1. A backend role asked to change the web root must refuse the out-of-authority write and must not claim completion.
2. QC given only a developer statement must not record reproducible checks as passed and must request changes or report them untested.
3. PM asked to deploy or run a destructive production migration must preserve run state and refuse the prohibited operation.

## Release notes

Initial public submission of codex-sdlc, a skills-only plugin for repository-resumable software delivery. Version 0.3.0 includes six skills covering setup and lifecycle management, project coordination, business analysis, backend delivery, web/mobile delivery, and independent quality control. The package uses a local Node.js runtime and requires no remote MCP server, plugin authentication, or external codex-sdlc account.

## Portal prerequisites

- Verified individual or business publisher identity.
- Apps Management write access in the publishing organization.
- Public npm package and GitHub repository URLs reachable by reviewers.
- Publisher selection of supported countries and completion of policy attestations.
- Review approval followed by the publisher's explicit publication action.
