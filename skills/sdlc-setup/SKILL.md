---
name: sdlc-setup
description: Initialize, diagnose, upgrade, roll back, or uninstall codex-sdlc when a user asks to set up, configure, repair, update, restore, or remove the framework in a repository.
---

# codex-sdlc setup

Resolve the repository the user selected before running a command. Read its `AGENTS.md` and preserve all instructions outside the codex-sdlc managed block.

For a new installation:

1. Confirm Node.js satisfies the version declared by the installed codex-sdlc package.
2. Identify the existing application roots and select one setup shape:
   - Web only: `--applications web --web-root <root> --web-preset nextjs`
   - Mobile only: `--applications mobile --mobile-root <root> --mobile-preset flutter`
   - Backend only: `--applications backend --backend-root <root> --backend-preset go`
   - Combined: `--applications backend,web,mobile` with the relevant root and preset option for each application.
   Add `--database-preset postgresql` and/or `--redis` when the repository uses those services. Use `generic` or `none` when no supplied preset fits. The initializer configures existing application directories and does not scaffold product code. When applications, documentation, or contracts live in separate Git checkouts, select `--workspace-mode multi-repository`. Use the `.sdlc` checkout as `--root`, map every other checkout with repeatable `--repo <id>=<absolute-path>`, bind applications with `--backend-repo`, `--web-repo`, or `--mobile-repo`, and bind shared resources with `--docs-repo`/`--docs-root` or `--contracts-repo`/`--contracts-root`.
3. Preview the bounded write set by adding `--dry-run` to the complete `codex-sdlc init --root <repository> --name <project-name> ...` command. During local tarball testing, also pass `--runtime-spec file:<absolute-tarball-path>` so restoration does not contact an unpublished registry version.
4. Inspect the preview for existing `.sdlc` controls or a modified codex-sdlc block. Do not overwrite a conflict.
5. Run the same command without `--dry-run`, then run `node .sdlc/runtime.cjs restore` from the repository root.
6. Confirm the generated preset commands match the repository. Generic applications deliberately receive failing `sdlc_test` and `sdlc_typecheck` entries; replace those with the project's real non-deploying checks. Keep command arguments as arrays and never wrap them in a shell.
7. Run `node .sdlc/runtime.cjs doctor` and `node .sdlc/runtime.cjs validate-config`.

For a multi-repository installation, commit `.sdlc/project.yaml` and `.sdlc/local.example.yaml`; never commit ignored `.sdlc/local.yaml`. After a checkout moves or another developer clones the workspace, run `codex-sdlc configure --root <coordinator> --repo <id>=<absolute-path>` and rerun `doctor`. Do not manually change a committed remote identity to make an unrelated local checkout pass validation.

Initialization owns only the managed `.sdlc` assets, launcher/tooling files, the marked `AGENTS.md` block, and its exact `.gitignore` entries. It must preserve application files, root package manifests, existing instructions, run history, and user-edited configuration. A second invocation with identical inputs should make no changes.

`doctor` is read-only. Report every diagnostic with the concrete file or command the user must fix. Do not start a feature run while required project checks are still the generated failing placeholders.

For installation lifecycle work, always run the matching `--dry-run` first and inspect its bounded file list and backup ID. `upgrade` preserves `.sdlc/project.yaml` content except the required framework version, refreshes managed assets and generated permissions, and records a rollback snapshot under `.sdlc/backups/`. After an applied upgrade or rollback, run `node .sdlc/runtime.cjs restore`, then `doctor` and `validate-config`.

Use `rollback --backup <backup-id>` when the user identifies a backup; otherwise rollback selects the latest ready backup. Do not bypass a rollback drift error because it prevents overwriting changes made after the original operation.

`uninstall` preserves project configuration, requests, runs, evidence, application code, and backups. It removes the codex-sdlc managed assets, launcher/tooling, marked `AGENTS.md` block, and only `.gitignore` entries recorded as framework-added. Keep the printed backup ID so the globally installed CLI can restore the installation later.
