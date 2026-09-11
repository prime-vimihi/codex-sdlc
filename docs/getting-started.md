# Getting started with codex-sdlc

codex-sdlc combines a Codex skills plugin with a deterministic npm CLI. The plugin teaches Codex how to initialize and coordinate delivery. The CLI creates and operates the repository's `.sdlc` framework.

## Requirements

- Codex with the public **codex-sdlc** plugin installed.
- Node.js `>=24.16.0 <25` and npm 11.
- One or more existing application directories. The initializer configures applications; it does not scaffold product code.
- Every checkout used by a multi-repository workspace must be a Git root with an `origin` remote.

## Initialize through Codex

Open the repository that should own `.sdlc` and start a new Codex task:

```text
Initialize codex-sdlc for this existing repository. Explain the setup choices and show the dry run before applying changes. If the CLI is unavailable, use codex-sdlc@0.4.3 through npx.
```

Tell Codex which applications already exist and where they live. Supported presets are Go for backend, Next.js for web, Flutter for mobile, PostgreSQL for the primary database, and Redis for cache. Codex will inspect the repository, show the proposed files, apply the same command without `--dry-run`, restore the pinned project runtime, and run diagnostics.

## Common project shapes

| Shape | Example request |
| --- | --- |
| Web only | `Initialize this existing Next.js repository as a web-only codex-sdlc project.` |
| Mobile only | `Initialize this existing Flutter repository as a mobile-only codex-sdlc project.` |
| Backend only | `Initialize this existing Go repository as a backend-only codex-sdlc project using PostgreSQL and Redis.` |
| Combined | `Initialize this repository with the Go backend in backend, Next.js in web, and Flutter in mobile. It uses PostgreSQL and Redis.` |
| Multiple repositories | `Use this checkout as the coordinator. Map my backend, web, and mobile Git checkouts and initialize codex-sdlc in multi-repository mode.` |

## Manual web-only initialization

Preview first:

```sh
npx --yes codex-sdlc@0.4.3 init --root /absolute/path/to/web --name example-web \
  --applications web --web-root . --web-preset nextjs --dry-run
```

Run the same command without `--dry-run`, then verify:

```sh
cd /absolute/path/to/web
node .sdlc/runtime.cjs restore
node .sdlc/runtime.cjs doctor
node .sdlc/runtime.cjs validate-config
```

## Manual multi-repository initialization

One checkout is the coordinator and owns `.sdlc`. The reserved repository ID `coordinator` represents the path passed through `--root`. Map every other checkout with a stable ID and an absolute path.

This example uses the frontend checkout as the coordinator and maps a backend elsewhere:

```sh
npx --yes codex-sdlc@0.4.3 init \
  --root /absolute/path/to/frontend \
  --name example-platform \
  --workspace-mode multi-repository \
  --repo backend=/absolute/path/to/backend \
  --applications backend,web \
  --web-repo coordinator --web-root . --web-preset nextjs \
  --backend-repo backend --backend-root . --backend-preset go \
  --database-preset postgresql --redis \
  --dry-run
```

Run the same command without `--dry-run`, then restore and validate from the coordinator:

```sh
cd /absolute/path/to/frontend
node .sdlc/runtime.cjs restore
node .sdlc/runtime.cjs doctor
node .sdlc/runtime.cjs validate-config
```

Only the coordinator receives `.sdlc`. The plugin skills remain in each user's Codex plugin cache. Another contributor binds their local checkout paths with `npx --yes codex-sdlc@0.4.3 configure --root <coordinator> --repo <id>=<absolute-path>` and reruns `doctor`.

Choose single-repository or multi-repository mode before starting delivery. Version 0.4.3 does not automatically convert an initialized single-repository project to multi-repository mode. Preserve existing runs before changing topology.

## Start using the framework

After diagnostics pass, ask Codex:

```text
Start a codex-sdlc feature delivery for <describe the requested outcome>.
```

Codex uses the PM, BA, backend, frontend, and QC skills as the work requires. Configuration, approvals, run manifests, reports, defects, and evidence remain under `.sdlc/` in the coordinator repository.

Use [GitHub Discussions](https://github.com/prime-vimihi/codex-sdlc/discussions) for usage help and [GitHub Issues](https://github.com/prime-vimihi/codex-sdlc/issues) for reproducible defects.
