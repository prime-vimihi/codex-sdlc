# Codex marketplace submission package

## Listing

- Name: codex-sdlc
- Publisher: vimihi
- Type: Skills only
- Category: Productivity
- Short description: Run evidence-backed SDLC.
- Website: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/getting-started.md
- Support: https://github.com/prime-vimihi/codex-sdlc/blob/main/SUPPORT.md
- Privacy: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/privacy.md
- Terms: https://github.com/prime-vimihi/codex-sdlc/blob/main/docs/terms.md

Long description:

Set up and coordinate resumable software delivery across one repository or multiple Git checkouts, from requirements through implementation, independent quality control, and Product Owner review. codex-sdlc records tasks, approvals, evidence, defects, and release decisions in a coordinator repository so work can be validated and resumed. The public plugin supplies Codex skills; its pinned npm CLI creates and operates the repository-local `.sdlc` framework.

## Starter prompts

1. Initialize codex-sdlc for this existing repository. Explain the setup choices and show the dry run before applying changes.
2. Initialize a multi-repository codex-sdlc workspace with this repository as the coordinator and map my backend, web, and mobile checkouts.
3. Start or resume a codex-sdlc feature delivery with independent quality control.

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
- Fixture: A disposable coordinator plus backend and web Git checkouts initialized by codex-sdlc 0.4.2, with a second clone of the backend remote and one unrelated checkout for the negative rebind check. No account or credentials are required.

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

Version 0.4.2 fixes Plugins Directory upload compatibility by limiting the manifest to three default prompts. It retains the 0.4.1 Getting Started guide, pinned npx setup fallback, and single- and multi-repository onboarding. Runtime schemas and delivery commands are unchanged.

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

Submit the skills-only plugin from the release source tree. The bundle root contains `plugin.json`, `skills/`, `.codex-plugin/plugin.json`, `README.md`, `docs/getting-started.md`, and the referenced brand assets. It requires no MCP server, authentication configuration, demo credentials, or network allowlist.

Prepared 0.4.2 artifacts:

| Material | File | SHA-256 |
| --- | --- | --- |
| Public plugin package | `build/public-submission/0.4.2/codex-sdlc-plugin-0.4.2.zip` | `516b263cc4823584858c781cb83fe18f0d13124e1c2429b56c3fea7d783f21a6` |
| Skills-only upload | `build/public-submission/0.4.2/codex-sdlc-skills-0.4.2.zip` | `5e86c5ab6e35e6c565ad22f505596fd46fe5ec35e3901fab31f8bae7a8d15166` |
| Listing logo | `build/public-submission/0.4.2/codex-sdlc-logo-0.4.2.png` | `678361975afc99f1c5bcb5b95a0883922b025d2aab3d2ce88f911a5972ff1825` |
| npm release tarball | `build/public-submission/0.4.2/codex-sdlc-0.4.2.tgz` | `a2ae15fafa5cbeae7ff8b84cc21f53afbcea659f1c4a0a64e93a248e8c6c228b` |

## Release order

1. Tag the reviewed source revision as `v0.4.2` and publish the GitHub release using `docs/releases/0.4.2.md`.
2. Wait for `.github/workflows/publish.yml` to publish `codex-sdlc@0.4.2` to npm with provenance, then verify that the public registry serves 0.4.2. Do not submit the plugin update while npm still serves 0.4.1.
3. Open the existing codex-sdlc listing in the OpenAI plugin submission portal, create a version update, keep the type **Skills only**, and upload the prepared skills bundle and listing logo.
4. Copy the listing, prompts, tests, availability, and release notes from this document; complete publisher identity and policy attestations.
5. Submit for review. After approval, explicitly publish the approved version to the universal Plugins Directory.
