# Multi-repository workspace configuration

Use multi-repository mode when one delivery run coordinates code or documentation stored in separate Git checkouts. One checkout is the coordinator and owns all `.sdlc` workflow authority. Other checkouts remain independent product repositories.

## Configuration split

The committed `.sdlc/project.yaml` records stable topology and never contains device-specific absolute paths:

```yaml
schema_version: 2
workspace:
  mode: multi-repository
  coordinator: coordinator
repositories:
  coordinator:
    remote: git@github.com:example/platform-delivery.git
    default_branch: main
  backend:
    remote: git@github.com:example/platform-api.git
    default_branch: main
  web:
    remote: git@github.com:example/platform-web.git
    default_branch: main
applications:
  backend:
    repository: backend
    root: .
  web:
    repository: web
    root: .
resources:
  documentation:
    repository: coordinator
    root: docs
  api_contracts:
    repository: backend
    root: contracts
```

The ignored `.sdlc/local.yaml` binds those IDs to checkouts on one device:

```yaml
schema_version: 1
repositories:
  coordinator: /Users/me/work/platform-delivery
  backend: /Users/me/work/platform-api
  web: /Users/me/work/platform-web
```

Commit `.sdlc/local.example.yaml` so another contributor knows which mappings are required. Never commit `.sdlc/local.yaml`.

## Initialization and rebinding

Pass all mappings during initialization. Each path must be the exact root of a Git checkout and must have an `origin` remote:

```sh
codex-sdlc init --root /work/platform-delivery --name platform \
  --workspace-mode multi-repository \
  --repo backend=/work/platform-api --repo web=/work/platform-web \
  --applications backend,web \
  --backend-repo backend --backend-root . --backend-preset go \
  --web-repo web --web-root . --web-preset nextjs
```

Rebind a moved or newly cloned checkout with `configure`:

```sh
codex-sdlc configure --root /work/platform-delivery --repo web=/new/work/platform-web --dry-run
codex-sdlc configure --root /work/platform-delivery --repo web=/new/work/platform-web
codex-sdlc doctor --root /work/platform-delivery
```

The runtime normalizes SSH and HTTPS forms of the same GitHub remote, including SSH host aliases whose names start with `github.com-`. It rejects a different repository remote, a subdirectory instead of a checkout root, duplicate checkout mappings, and nested repository mappings.

## Runtime behavior

- Commands declare a repository ID and a path relative to that checkout. Aggregate verification commands may contain ordered steps across repositories.
- Evidence stays in the coordinator repository and records the repository ID, relative working directory, executable, ordered arguments, and composite steps.
- Delivery assignments and reports carry the target repository ID in multi-repository mode. Product writes also carry a repository ID.
- The changed-file manifest uses `{ "repository": "web", "path": "src/page.tsx" }` for product files. Coordinator `.sdlc` artifacts continue to use portable string paths.
- Documentation and API contract locations resolve through `resources.documentation` and `resources.api_contracts`.

`doctor` and `validate-config` resolve the complete workspace before a run proceeds. A missing or mismatched local mapping makes the installation invalid until it is repaired.
