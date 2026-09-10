# Changelog

All notable changes to codex-sdlc are documented here.

## 0.4.0 - 2026-09-11

- Add schema-family 2 multi-repository workspaces with a coordinator repository and stable repository IDs.
- Add committed repository topology in `.sdlc/project.yaml`, ignored device paths in `.sdlc/local.yaml`, and a shareable `.sdlc/local.example.yaml`.
- Add `init` repository, application, documentation, and API-contract mapping options plus `configure --repo` for moved or newly cloned checkouts.
- Validate Git checkout roots, origin remotes, duplicate and nested mappings, application/resource roots, and repository-scoped command declarations.
- Run preset and aggregate evidence commands in their mapped checkouts and record repository-aware provenance.
- Add repository-aware delivery assignments, reports, permissions, authority snapshots, and changed-file ownership while retaining schema-family 1 compatibility.
- Add independent multi-repository initialization, command resolution, rebinding, remote mismatch, and duplicate mapping tests.

Native Linux and Windows qualification remains deferred from this release.

## 0.3.0 - 2026-09-10

- Add web-only, mobile-only, backend-only, and combined-project initialization.
- Add Go, Next.js, Flutter, PostgreSQL, and Redis presets.
- Add backup-backed upgrade, rollback, and uninstall commands with drift checks.
- Add local Codex marketplace packaging for the six SDLC skills.
- Preserve repository-specific configuration and delivery history across lifecycle operations.
- Allow whole-project application roots, declared future evidence, and project-specific frontend capabilities in typed delivery assignments.
- Allow authority publication to repair documents made stale by a newer runtime while retaining full post-publication validation and rollback.
- Align pre-start delivery assignments with their authorized running state.
- Mark the API-contract gate not applicable for projects without backend work, including upgraded runs finalized from the earlier pending state.

Linux and Windows qualification is deferred from this release.
