# Codex marketplace submission package

## Listing

- Name: codex-sdlc
- Publisher: vimihi
- Type: Skills only
- Category: Productivity
- Short description: Evidence-backed software delivery across one or more repositories.
- Website: https://github.com/prime-vimihi/codex-sdlc
- Support: https://github.com/prime-vimihi/codex-sdlc/blob/main/SUPPORT.md
- Privacy: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/privacy.md
- Terms: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/terms.md

Long description:

Initialize and operate resumable software delivery across one repository or a set of mapped Git checkouts, with specialized workflows for requirements, backend, web and mobile implementation, integration, independent quality control, and Product Owner review. codex-sdlc records tasks, approvals, evidence, defects, and release decisions in a coordinator repository so delivery can be validated and resumed. It also manages installation, local checkout configuration, upgrades, rollback, and uninstall for existing Go, Next.js, and Flutter projects, with PostgreSQL and Redis presets.

## Starter prompts

1. Initialize codex-sdlc for this existing Next.js repository and validate the setup.
2. Configure codex-sdlc with this coordinator repository plus separate backend, web, and mobile Git checkouts.
3. Configure this combined Go, Next.js, and Flutter repository with PostgreSQL and Redis.
4. Start or resume a multi-repository feature delivery and collect repository-routed evidence.
5. Independently verify this integrated feature against its approved acceptance criteria.

## Positive tests

### 1. Initialize a web-only project

- User prompt: `Initialize codex-sdlc for this existing Next.js repository and validate the setup.`
- Expected behavior: The `sdlc-setup` skill inspects the repository, proposes or applies web-only initialization with the Next.js preset, restores the pinned runtime, and runs `doctor` and `validate-config`.
- Expected result: `.sdlc/project.yaml` declares only the web application and Next.js preset; the validation commands succeed and their output is reported.
- Fixture: A disposable Git repository containing a conventional Next.js application and Node.js 24.16 or newer in the supported major version. No account or credentials are required.

### 2. Initialize a multi-repository workspace

- User prompt: `Configure codex-sdlc with this coordinator repository plus separate backend, web, and mobile Git checkouts. Use Go, Next.js, Flutter, PostgreSQL, and Redis.`
- Expected behavior: The `sdlc-setup` skill identifies or asks for each checkout, verifies that every mapping is a Git root with an `origin`, assigns stable repository IDs, binds each application and shared resource to its repository, and configures the five requested technology presets.
- Expected result: Schema-family 2 `.sdlc/project.yaml` records portable repository identity and application ownership; ignored `.sdlc/local.yaml` records absolute checkout paths; `.sdlc/local.example.yaml` provides shareable placeholders; `doctor` and `validate-config` pass.
- Fixture: Four disposable Git repositories: an empty coordinator plus conventional Go backend, Next.js web, and Flutter mobile checkouts. Each has a distinct `origin` remote. PostgreSQL and Redis do not need to be running for configuration validation.

### 3. Exercise reversible lifecycle management

- User prompt: `Preview an upgrade of this multi-repository codex-sdlc workspace, apply it, roll it back, rebind the backend checkout to its new local path, and show me the uninstall preview.`
- Expected behavior: The `sdlc-setup` skill uses dry-run before each mutation, creates an upgrade backup, applies the upgrade, restores it with rollback, verifies the rebound checkout has the declared remote identity, and performs only a dry-run uninstall.
- Expected result: The report identifies the backup, restored version and checksums, accepted repository mapping, and bounded uninstall changes without deleting project configuration, local mapping, or run history. A checkout with a different remote must be rejected.
- Fixture: A disposable coordinator plus backend and web Git checkouts initialized by codex-sdlc 0.4.0, with a second clone of the backend remote and one unrelated checkout for the negative rebind check. No account or credentials are required.

### 4. Produce requirements authority

- User prompt: `Analyze this feature request and publish complete codex-sdlc requirements with traceability: members can update their display name, which must be 2 to 40 characters.`
- Expected behavior: The `sdlc-ba` skill reconciles facts and claims, then produces user stories, acceptance criteria, business rules, validation rules, edge cases, assumptions or questions, and traceability with stable identifiers.
- Expected result: The seven required typed artifacts validate, every asserted claim traces to a fact or explicit assumption, and the display-name length rule appears consistently in validation and acceptance criteria.
- Fixture: A disposable initialized repository with the quoted feature request saved as the active run request. No account or credentials are required.

### 5. Complete an independent delivery run

- User prompt: `Deliver this approved health-summary feature across the backend and web repositories through implementation, integration, independent QC, and Product Owner review, recording reproducible evidence.`
- Expected behavior: The `sdlc-pm` skill binds each assignment to its configured repository, delegates eligible work to the applicable delivery skills, preserves task ownership, records repository-routed command evidence and changed files, sends the integrated result to `sdlc-qc`, and performs final Product Owner review only after QC.
- Expected result: The coordinator run manifest advances through the required stages; assignments, changed-file authority, commands, and evidence carry stable repository IDs; QC reports acceptance coverage independently; the final report records an evidence-supported release decision.
- Fixture: A disposable coordinator plus separate backend and web Git repositories containing a small approved endpoint task. No production credentials or deployment target are required.

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

Initial public submission of codex-sdlc 0.4.0, a skills-only plugin for resumable software delivery across one or more repositories. It includes six skills covering setup and lifecycle management, project coordination, business analysis, backend delivery, web/mobile delivery, and independent quality control. Version 0.4.0 adds coordinator-based multi-repository configuration, checkout identity verification and rebinding, repository-routed command evidence, and repository-aware delivery authority while retaining single-repository compatibility. The package uses a local Node.js runtime and requires no remote MCP server, plugin authentication, demo credentials, or external codex-sdlc account.

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

Prepared 0.4.0 artifacts:

| Material | File | SHA-256 |
| --- | --- | --- |
| Public plugin package | `build/public-submission/0.4.0/codex-sdlc-plugin-0.4.0.zip` | `0be5ff482093780986c8c9e51d31b4bf87cf31f01ac6b40a7895861976257bc8` |
| Skills-only upload | `build/public-submission/0.4.0/codex-sdlc-skills-0.4.0.zip` | `f2c35b53691ec2bfb51df5f0163cdbb3f8758d3f3d4367c3ee005f78dd6d2eb4` |
| Listing logo | `build/public-submission/0.4.0/codex-sdlc-logo-0.4.0.png` | `678361975afc99f1c5bcb5b95a0883922b025d2aab3d2ce88f911a5972ff1825` |
| npm release tarball | `build/public-submission/0.4.0/codex-sdlc-0.4.0.tgz` | `1f9180d2d2335da1c6c386b3c17e93960bc6632541131a51ee906b46e1e2e914` |

## Release order

1. Publish the exact 0.4.0 npm tarball so setup workflows resolve the same runtime as the plugin. The public npm registry currently serves 0.3.0.
2. Tag the reviewed source revision as `v0.4.0` and publish the GitHub release using `docs/releases/0.4.0.md`.
3. Create a **Skills only** draft in the OpenAI plugin submission portal and upload the prepared skills bundle and listing logo.
4. Copy the listing, prompts, tests, availability, and release notes from this document; complete publisher identity and policy attestations.
5. Submit for review. After approval, explicitly publish the approved version to the universal Plugins Directory.
