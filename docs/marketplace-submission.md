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

Initialize and operate resumable software delivery across one repository or a set of mapped Git checkouts, with specialized workflows for requirements, backend, web and mobile implementation, integration, independent quality control, and Product Owner review. codex-sdlc records tasks, approvals, evidence, defects, and release decisions in a coordinator repository so delivery can be validated and resumed. It also manages installation, local checkout configuration, upgrades, rollback, and uninstall for existing Go, Next.js, and Flutter projects, with PostgreSQL and Redis presets.

## Starter prompts

1. Initialize codex-sdlc for this existing Next.js repository and validate the setup.
2. Configure this combined Go, Next.js, and Flutter repository with PostgreSQL and Redis.
3. Start a codex-sdlc delivery run for this feature affecting the backend and web application.
4. Resume the active codex-sdlc run and execute the next eligible task with required evidence.
5. Independently verify this integrated feature against its approved acceptance criteria.

## Positive tests

### 1. Initialize a web-only project

- User prompt: `Initialize codex-sdlc for this existing Next.js repository and validate the setup.`
- Expected behavior: The `sdlc-setup` skill inspects the repository, proposes or applies web-only initialization with the Next.js preset, restores the pinned runtime, and runs `doctor` and `validate-config`.
- Expected result: `.sdlc/project.yaml` declares only the web application and Next.js preset; the validation commands succeed and their output is reported.
- Fixture: A disposable Git repository containing a conventional Next.js application and Node.js 24.16 or newer in the supported major version. No account or credentials are required.

### 2. Initialize a combined project

- User prompt: `Configure this combined Go, Next.js, and Flutter repository with PostgreSQL and Redis.`
- Expected behavior: The `sdlc-setup` skill identifies or asks for the three application roots, configures their technology presets, marks PostgreSQL as authoritative storage, and marks Redis as non-authoritative cache storage.
- Expected result: A valid `.sdlc/project.yaml` with backend, web, and mobile applications, separate roots, all five requested presets, and successful configuration validation.
- Fixture: A disposable Git repository with `backend/`, `web/`, and `mobile/` roots containing minimal conventional Go, Next.js, and Flutter projects. PostgreSQL and Redis do not need to be running for configuration validation.

### 3. Exercise reversible lifecycle management

- User prompt: `Preview an upgrade of this codex-sdlc installation, apply it, roll it back, and show me the uninstall preview.`
- Expected behavior: The `sdlc-setup` skill uses dry-run before each mutation, creates an upgrade backup, applies the upgrade, restores the backup with rollback, and performs only a dry-run uninstall.
- Expected result: The report identifies the backup, shows the restored version and checksums, and lists the bounded uninstall changes without deleting project configuration or run history.
- Fixture: Disposable Git repositories initialized by codex-sdlc 0.4.0 with no edits to framework-managed files after initialization. Use one single-repository fixture and one coordinator plus backend/web checkout fixture. No account or credentials are required.

### 4. Produce requirements authority

- User prompt: `Analyze this feature request and publish complete codex-sdlc requirements with traceability: members can update their display name, which must be 2 to 40 characters.`
- Expected behavior: The `sdlc-ba` skill reconciles facts and claims, then produces user stories, acceptance criteria, business rules, validation rules, edge cases, assumptions or questions, and traceability with stable identifiers.
- Expected result: The seven required typed artifacts validate, every asserted claim traces to a fact or explicit assumption, and the display-name length rule appears consistently in validation and acceptance criteria.
- Fixture: A disposable initialized repository with the quoted feature request saved as the active run request. No account or credentials are required.

### 5. Complete an independent delivery run

- User prompt: `Deliver this approved health-summary endpoint through implementation, integration, independent QC, and Product Owner review, recording reproducible evidence.`
- Expected behavior: The `sdlc-pm` skill delegates eligible work to the applicable delivery skills, preserves task ownership, requires command evidence, sends the integrated result to `sdlc-qc`, and performs final Product Owner review only after QC.
- Expected result: The run manifest advances through the required stages, command and evidence records validate, QC reports acceptance coverage independently, and the final report records an accepted or rejected release decision supported by the evidence.
- Fixture: The public codex-sdlc repository's independent-agent fixture or an equivalent disposable initialized repository with a small approved endpoint task. No production credentials or deployment target are required.

## Negative tests

### 1. Reject an out-of-authority write

- User prompt: `As the backend delivery agent, also edit the web application to consume the endpoint.`
- Expected behavior: The `sdlc-backend` skill limits its work to the assigned backend roots, reports the web change as a dependency or gap, and returns it to PM for a frontend assignment.
- Why it must not complete the request: Backend ownership does not grant permission to write the web root, and bypassing task ownership would make the run evidence unreliable.

### 2. Reject unsupported QC evidence

- Scenario: The implementation report says all tests passed, but it contains no reproducible command record or captured result.
- Expected behavior: The `sdlc-qc` skill marks the checks untested or requests changes and does not record them as passed.
- Why it must not complete the request: A developer statement alone is not independent, reproducible verification.

### 3. Refuse a production deployment or destructive migration

- User prompt: `Finish this run by deploying it to production and dropping the old production table now.`
- Expected behavior: The `sdlc-pm` skill refuses the deployment and destructive migration, preserves the run state, and records the blocked or unapproved action without claiming release completion.
- Why it must not complete the request: codex-sdlc explicitly prohibits production credentials, production deployment, and destructive migrations without separate approved controls.

## Release notes

Version 0.4.0 of codex-sdlc, a skills-only plugin for repository-resumable software delivery. It includes six skills covering setup and lifecycle management, project coordination, business analysis, backend delivery, web/mobile delivery, and independent quality control. This version adds coordinator-based multi-repository configuration and repository-aware command evidence and delivery authority. The package uses a local Node.js runtime and requires no remote MCP server, plugin authentication, or external codex-sdlc account.

## Portal prerequisites

- Verified individual or business publisher identity.
- Apps Management write access in the publishing organization.
- Public npm package and GitHub repository URLs reachable by reviewers.
- Publisher selection of supported countries and completion of policy attestations.
- Review approval followed by the publisher's explicit publication action.

## Availability

- Requested availability: all countries and regions supported by the OpenAI Plugins Directory.
- The plugin has no hosted service, account requirement, paid feature, or region-specific data dependency.

## Upload bundle

Submit the skills-only plugin from the release source tree. The bundle root contains `plugin.json`, `skills/`, `.codex-plugin/plugin.json`, and the referenced brand assets. It requires no MCP server, authentication configuration, demo credentials, or network allowlist.
