# Multi-repository project setup and delivery

Status: proposed implementation plan; no runtime changes implemented by this document.
Date: 2026-09-11

## Outcome

Allow one codex-sdlc project to coordinate backend, web, mobile, documentation, and API contracts across separate local Git checkouts. Initialization records their locations before delivery starts. Every task, command, change, and evidence record identifies the repository it belongs to.

Existing single-repository projects continue to work without moving files or rewriting historical runs.

## Current implementation

- `src/install.ts` accepts backend, web, and mobile roots relative to one repository and rejects escaping paths.
- `src/config.ts` validates those roots and rejects overlapping application roots.
- `src/types.ts` and `assets/schemas/project.schema.json` describe one repository with application roots and command working directories.
- `src/paths.ts`, authority resolution, changed-file reconciliation, and run evidence assume one repository root.
- `src/constants.ts` currently uses a shared schema-version constant of 1. A format change must distinguish project, run, and evidence compatibility rather than blindly changing every document version.
- There is no machine-local checkout mapping or first-class documentation/contract location configuration.

## Configuration design

### Shared project configuration

Extend `.sdlc/project.yaml` with:

- A workspace mode: single repository or multiple repositories.
- Stable repository IDs, expected remote identities, and per-repository default branches.
- Application locations expressed as a repository ID and a path relative to that repository.
- Named documentation and API-contract locations using the same location type.
- Role/stage ownership expressed using repository-qualified paths.
- Dependencies linking contract producers, generated-client destinations, applications, and documentation.
- Commands with an explicit repository ID and repository-relative working directory.

Keep application presets and lifecycle fields. Treat documentation and contracts as named resources, not extra application types that accidentally create backend/frontend tasks. Documentation work must have an explicit assignment to an existing role; a dedicated documentation role is deferred.

### Machine-local configuration

Add `.sdlc/local.yaml`, ignored by Git, mapping stable repository IDs to absolute checkout paths. Commit a placeholder-only `.sdlc/local.example.yaml` for onboarding.

The coordinator is the repository containing the authoritative `.sdlc` installation and run history. Its location defaults to the selected `--root`; other repositories may be anywhere on the device. A dedicated coordination repository is supported, but a non-Git coordination folder is outside the first release.

Local mappings may select checkout paths only. They cannot override ownership, commands, expected repository identities, quality gates, or approvals. Do not include absolute checkout paths in shared configuration or stable authority hashes. Command output may contain local paths; existing redaction behavior must remain accurately documented.

Illustrative fields only; the final schema will also retain the existing required fields:

```yaml
# project.yaml excerpt
workspace:
  mode: multi-repository
  coordinator: delivery
repositories:
  delivery:
    remote: https://github.com/example/delivery
    default_branch: main
  api:
    remote: https://github.com/example/api
    default_branch: main
  site:
    remote: https://github.com/example/site
    default_branch: main
  handbook:
    remote: https://github.com/example/handbook
    default_branch: main
applications:
  backend:
    repository: api
    root: .
  web:
    repository: site
    root: .
resources:
  documentation:
    repository: handbook
    root: docs
  api_contracts:
    repository: api
    root: contracts
```

```yaml
# local.yaml excerpt, never committed
schema_version: 1
repositories:
  api: /Users/developer/work/api
  site: /Volumes/Projects/site
  handbook: /Users/developer/Documents/handbook
```

## Initialization and onboarding

Extend `codex-sdlc init`; do not require users to hand-author the initial files.

Proposed CLI interface, subject to grammar tests:

```sh
codex-sdlc init --root /work/delivery --name example \
  --workspace-mode multi-repository \
  --repo api=/work/api --repo site=/work/site --repo handbook=/work/handbook \
  --applications backend,web \
  --backend-repo api --backend-root . --backend-preset go \
  --web-repo site --web-root . --web-preset nextjs \
  --docs-repo handbook --docs-root docs \
  --contracts-repo api --contracts-root contracts \
  --dry-run
```

- Preserve current single-repository flags and defaults.
- Inspect each supplied checkout and derive remote identity; accept explicit expected identities where discovery is ambiguous. Require a choice when multiple remotes cannot be resolved reliably.
- Preview generated configuration and the bounded write set before applying initialization.
- Write the framework, local mapping, and ignore entry in the coordinator only. Initialization does not clone repositories or edit their applications or instructions.
- Repeated identical initialization is idempotent. Conflicting existing configuration produces diagnostics instead of overwrites.
- Add a proposed `codex-sdlc configure --repo <id>=<path> --dry-run` flow for binding existing shared configuration on a new device or moving checkouts. It updates local mappings without reinstalling the framework.
- Extend `sdlc-setup` to collect missing locations conversationally and execute these commands. A separate interactive terminal wizard is deferred.

## Repository resolution and preflight

Create one resolver used by configuration loading, command execution, assignment publication, evidence checks, and resume.

It must:

1. Validate repository IDs and required mappings.
2. Resolve real paths and confirm directory existence and Git checkout roots.
3. Match expected remote identity. Normalize equivalent HTTPS/SSH URLs and configured SSH aliases without storing credentials or contacting the network merely to validate identity.
4. Support Git worktrees, including `.git` files, and distinguish worktrees that share a Git common directory.
5. Reject accidental duplicate mappings and nested repository boundaries in this first release. Submodules require a later explicit design.
6. Resolve relative paths within the selected checkout and reject traversal or symlink escapes, including writes to paths that do not exist yet.
7. Compare overlap within a repository; identical paths in different repositories are valid. Contract resources may overlap their owning backend tree only under explicit stage ownership.
8. Read applicable repository instructions and check required access. A configuration entry does not grant OS or Codex sandbox access; diagnose missing access without bypassing it.

`doctor` reports all configuration problems. Start and resume require the coordinator and repositories needed by the selected run; an unrelated optional checkout may remain unavailable. Static configuration validation must distinguish schema errors from machine-local access errors.

## Delivery authority, Git, and evidence

Use a structured location such as `{ repository: api, path: src/health.go }` everywhere a cross-repository reference is needed. Never infer the repository from a filename or concatenate absolute paths into shared authority.

- Keep run manifests, publication locks, approvals, and evidence authority in the coordinator.
- Qualify assignment inputs, outputs, allowed writes, changed files, command working directories, and delivery reports with repository IDs.
- Freeze relevant shared configuration and repository identities when publishing an assignment. Local path relocation is allowed only after identity and checkout-state checks; ownership changes require explicit reassignment.
- Record each participating checkout's base commit, branch or detached state, and dirty baseline. Do not attribute pre-existing user edits to an agent.
- Capture tested commits and working-tree content/diff fingerprints, including relevant untracked files, for integration and QC. A branch name alone is insufficient evidence.
- Resume revalidates mappings and state. Unexplained checkout drift blocks affected work and reports remediation; it does not silently refresh the evidence baseline.
- Make API contract generation a declared dependency with producer ownership and explicit generated-output destinations in consumer repositories.
- Run commands in the resolved checkout and retain argument-array execution, network-policy checks, and existing evidence capture.
- Lock conflicting writes per checkout and path across concurrent runs; preserve the existing coordinator publication transaction model.
- Report partial completion across repositories. Do not claim Git commits, merges, or pushes across several repositories are atomic.
- Revalidate tested state before finalization; invalidate affected QC evidence when that state changes.

## Compatibility and lifecycle

Choose the exact new schema versions after enumerating every affected serialized contract. Document a compatibility matrix for framework, project, run, assignment, report, and evidence readers/writers.

- Adapt legacy single-repository documents in memory to a default repository ID; do not rewrite old evidence.
- New multi-repository authority must be rejected clearly by older runtimes, rather than partially interpreted.
- Separate upgrading framework files from converting project topology. Existing active runs remain pinned to their original topology; topology conversion requires finishing or explicitly cancelling them.
- Upgrade preserves local mappings; rollback restores only operation-owned changes and refuses drift. Uninstall preserves local configuration and run history along with existing preserved data.
- A downgrade must refuse unsupported multi-repository authority unless a compatible rollback snapshot exists. Never flatten multiple repositories into one root.

## Implementation sequence

| Step | Deliverable | Main code areas | Completion gate |
| --- | --- | --- | --- |
| 1 | Versioning decision, schemas, typed locations, legacy adapter | `types.ts`, `constants.ts`, `schemas.ts`, `assets/schemas/` | Legacy fixtures readable; new contracts validate; incompatible versions fail explicitly |
| 2 | Local mappings and repository resolver | `config.ts`, `paths.ts`, new resolver module | Identity, worktree, traversal, symlink, duplicate, and access cases covered |
| 3 | Init, rebind, diagnostics, lifecycle behavior | `install.ts`, `cli.ts`, `cli-grammar.ts`, `installation-lifecycle.ts` | Single/multi init previews match writes; rebinding and lifecycle preservation verified |
| 4 | Repository-qualified authority and command provenance | `semantic-contracts.ts`, `delivery-authority-resolver.ts`, `changed-files-authority.ts`, `delivery-report-reconciliation.ts`, `command-provenance.ts`, evidence modules | Cross-repository ownership and provenance enforced; commands execute in correct checkout |
| 5 | Run snapshots, locking, integration, QC, finalization | `runs.ts`, `manifest-transaction.ts`, `run-authority-lock.ts`, `transitions.ts`, `finalize.ts` | Resume drift, concurrent writes, partial failure, and stale QC detected |
| 6 | Skills, templates, documentation, examples | All six skills, policies, workflows, templates, README | Every role consumes repository-qualified assignments and respects each checkout's instructions |
| 7 | End-to-end qualification and release preparation | Tests, disposable fixtures, package validation | Independent delivery across separate repositories succeeds with reproducible evidence |

Steps 1–2 establish the contract. Steps 3–6 must ship together for multi-repository delivery to be advertised as supported; accepting external paths in init alone is not completion.

## Verification and acceptance

Build disposable local Git fixtures for:

- Existing single-repository backend/web/mobile setup without behavior changes.
- Backend and frontend in separate checkouts; documentation in a third checkout.
- A dedicated coordinator plus separate backend, web, mobile, and contract repositories.
- Multiple components in one checkout and components spread across checkouts.
- Paths containing spaces, relocation between devices, SSH aliases, and Git worktrees.
- Missing mappings, wrong remote, nested repositories, duplicate IDs/checkouts, symlink escape, and unauthorized writes.
- Existing dirty edits, detached HEAD, branch/commit drift, and untracked-file changes after QC.
- Conflicting concurrent assignments and failures after only one repository finishes work.
- API-contract generation across repositories with traceable consumer outputs.
- Upgrade, rollback, uninstall, and unsupported downgrade with local mappings preserved.

Run the existing `npm run verify` gate and focused new tests. Then execute a full independent-role delivery with backend and frontend in separate repositories, documentation in another checkout, integration evidence, independent QC, and final Product Owner review. Verify unauthorized cross-repository changes are rejected and pre-existing edits remain intact.

Linux and Windows execution qualification remains deferred as previously requested. Keep path formats portable and add lexical tests on the current platform; do not describe those as native OS verification.

The feature is complete when a fresh user can initialize a distributed project, bind it on another device, deliver and resume work across its checkouts, and reproduce final evidence without storing device paths in shared project authority.

## Release boundary

Implementation is included in the 0.4.0 source. Schema-family 1 remains supported for existing single-repository installations; schema-family 2 activates the multi-repository topology, local checkout mappings, repository-aware commands, permissions, evidence, and delivery authority. Native Linux and Windows qualification remains deferred and must be completed before claiming those platforms in release materials.
