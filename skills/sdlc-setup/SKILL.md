---
name: sdlc-setup
description: Initialize, diagnose, upgrade, roll back, or uninstall codex-sdlc when a user asks to set up, configure, repair, update, restore, or remove the framework in a repository.
---

# codex-sdlc setup

Resolve the repository the user selected before running a command. Read its `AGENTS.md` and preserve all instructions outside the codex-sdlc managed block.

## First-use onboarding

For a new setup, explain briefly that the installed plugin supplies Codex skills while the npm CLI creates and operates `.sdlc`. Plugin skills stay in Codex's plugin cache; initialization does not create `.agents/skills` in the project.

Confirm Node.js satisfies the version declared by codex-sdlc. Run `codex-sdlc --version` when the executable is available and use it only when it reports 0.5.0. If it is unavailable or differs, run the release-pinned CLI through `npx --yes codex-sdlc@0.5.0`; do not require a global installation. Let the environment request approval if downloading the package requires network access.

Infer the project name, application roots, technologies, and workspace shape from the selected repository. Ask only for missing information that changes repository topology or application ownership. State which checkout will own `.sdlc` before previewing a multi-repository installation.

## Initialize

1. Select one setup shape:
   - Web only: `--applications web --web-root <root> --web-preset nextjs`
   - Mobile only: `--applications mobile --mobile-root <root> --mobile-preset flutter`
   - Backend only: `--applications backend --backend-root <root> --backend-preset go`
   - Combined: `--applications backend,web,mobile` with the relevant root and preset for each application.
   Add `--database-preset postgresql` and/or `--redis` when the repository uses those services. Use `generic` or `none` when no supplied preset fits. Existing application directories must already exist; initialization does not scaffold product code.
2. When applications, documentation, or contracts live in separate Git checkouts, select `--workspace-mode multi-repository`. Use the checkout that will own `.sdlc` as `--root`. The ID `coordinator` is reserved for that checkout. Map every other checkout with repeatable `--repo <id>=<absolute-path>`, bind applications with `--backend-repo`, `--web-repo`, or `--mobile-repo`, and bind shared resources with `--docs-repo`/`--docs-root` or `--contracts-repo`/`--contracts-root`.
3. Add `--dry-run` to the complete initialization command and inspect its bounded write set. Do not overwrite existing `.sdlc` controls or a modified managed block. If an existing single-repository installation must become multi-repository, report that automatic conversion is unsupported and preserve existing runs rather than rewriting topology by hand.
4. When the preview is clean and the user's request authorizes initialization, run the same command without `--dry-run`, then run `node .sdlc/runtime.cjs restore` from the coordinator root.
5. Confirm generated preset commands match the repository. Generic applications deliberately receive failing `sdlc_test` and `sdlc_typecheck` entries; replace those with the project's real non-deploying checks before starting delivery.
6. Run `node .sdlc/runtime.cjs doctor` and `node .sdlc/runtime.cjs validate-config`.

For multi-repository installations, commit `.sdlc/project.yaml` and `.sdlc/local.example.yaml`; never commit ignored `.sdlc/local.yaml`. After a checkout moves or another developer clones the workspace, run `codex-sdlc configure --root <coordinator> --repo <id>=<absolute-path>` and rerun `doctor`. Do not change a committed remote identity to make an unrelated checkout pass validation.

Initialization owns only the managed `.sdlc` assets, launcher/tooling files, the marked `AGENTS.md` block, and its exact `.gitignore` entries. Preserve application files, root package manifests, existing instructions, run history, and user-edited configuration. A second invocation with identical inputs should make no changes.

Report the selected shape, coordinator, mapped repositories, created files, runtime restoration, and both diagnostic results. Give the user one suitable starter request for beginning a feature delivery.

## Role models

When the user asks to choose agent models, use `configure-agents` after initialization or pass the same `--agent-model`, `--agent-reasoning`, `--agent-fallback`, and `--po-review` settings during `init`. Canonical roles are `pm`, `ba`, `backend`, `frontend`, `qc`, and `po`; translate FE/BE/Product Owner to `frontend`/`backend`/`po`. The frontend setting covers web and mobile. Use exact model IDs exposed by the current host and preserve the user’s selected models. Do not choose a model for an unspecified role.

Example: `node .sdlc/runtime.cjs configure-agents --agent-model frontend=gpt-6-astra --agent-model backend=gpt-5.6-luna --agent-model qc=gpt-5.6-sol --agent-model pm=gpt-5.6-sol --dry-run`. Run it without `--dry-run` when the preview matches the authorized choices. `--po-review advisory` enables an inherited-model AI Product Owner; `--agent-model po=<model-id>` also enables it. Final acceptance stays human.

Use `--agent-reasoning pm=high` for an explicit effort. `--agent-fallback backend=gpt-5.6-sol:low` authorizes that fallback only. Omit fallback unless the user chose one. `--reset-role frontend` restores model inheritance. Changing a model clears its previous effort and fallback; restate them if wanted. To disable AI Product Owner review and remove its override, use `--reset-role po --po-review disabled`.

Settings are stored in coordinator `.sdlc/project.yaml` and copied into new run manifests. Existing runs keep their snapshot. Configuration validates syntax; model access and supported reasoning are checked by the host adapter at dispatch. No `.codex/agents` files or API keys are needed: the PM skill sends explicit model parameters to Codex’s subagent tools. A configured PM model runs through task-only PM children. Do not claim to change the current conversation model. If the installed runtime predates these commands, upgrade it before applying settings.

## Diagnose and lifecycle operations

`doctor` is read-only. Report every diagnostic with the concrete file or command the user must fix. Do not start a feature run while required project checks are generated failing placeholders.

For upgrade, rollback, or uninstall, always run the matching `--dry-run` first and inspect its bounded file list and backup ID. `upgrade` preserves `.sdlc/project.yaml` except the required framework version, refreshes managed assets and permissions, and records a rollback snapshot under `.sdlc/backups/`. After an applied upgrade or rollback, run `node .sdlc/runtime.cjs restore`, then `doctor` and `validate-config`.

Use `rollback --backup <backup-id>` when the user identifies a backup; otherwise rollback selects the latest ready backup. Do not bypass a rollback drift error.

`uninstall` preserves project configuration, requests, runs, evidence, application code, and backups. It removes managed assets, launcher/tooling, the marked `AGENTS.md` block, and only `.gitignore` entries recorded as framework-added. Keep the printed backup ID so the globally installed CLI can restore the installation later.
