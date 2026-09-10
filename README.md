# codex-sdlc

`codex-sdlc` is a repository-resumable software delivery framework for Codex. It packages a deterministic Node.js runtime with six Codex skills for setup, business analysis, project coordination, backend delivery, frontend delivery, and independent quality control.

The framework is distributed as both an npm CLI and a Codex skills plugin. Existing project installations and saved runs remain unchanged until an explicit upgrade is performed.

## Current status

Version `0.3.0` is the first public release candidate. Runtime packaging, web-only, mobile-only, backend-only, and combined-project initialization, technology presets, configuration diagnostics, reversible installation lifecycle commands, delivery lifecycle commands, frozen legacy assets, and plugin validation are implemented here. Linux and Windows qualification is deferred from this candidate.

## Build and test

Requirements: Node.js `>=24.16.0 <25` and npm 11.

```sh
npm install
npm run verify
npm pack
```

Install the published CLI with:

```sh
npm install --global codex-sdlc
```

## Project setup modes

The initializer configures an existing repository; it does not generate application source code. Each selected application root must already exist.

Initialize a web-only Next.js project:

```sh
codex-sdlc init --root /path/to/project --name example-web \
  --applications web --web-root . --web-preset nextjs
```

Initialize a mobile-only Flutter project:

```sh
codex-sdlc init --root /path/to/project --name example-mobile \
  --applications mobile --mobile-root . --mobile-preset flutter
```

Initialize a combined repository with Go, Next.js, Flutter, PostgreSQL, and Redis:

```sh
codex-sdlc init --root /path/to/project --name example-platform \
  --applications backend,web,mobile \
  --backend-root service --backend-preset go \
  --web-root web --web-preset nextjs \
  --mobile-root mobile --mobile-preset flutter \
  --database-preset postgresql --redis
```

For one selected application the default root is `.`. For a combined project the default roots are `backend`, `web`, and `mobile`. Application roots must be separate and cannot overlap.

| Preset | Target | Generated verification commands |
| --- | --- | --- |
| `go` | Backend | `go test`, `go vet`, `go build`, and `gofmt` |
| `nextjs` | Web | npm test, typecheck, lint, and build scripts |
| `flutter` | Mobile | Flutter test, analyze, Android debug build, and Dart format check |
| `postgresql` | Data | Marks PostgreSQL as the primary authoritative database |
| `redis` | Data | Enables Redis in the non-authoritative cache role |

Use the `generic` application preset or `none` database preset when a listed preset does not fit. Generic applications deliberately receive unconfigured `sdlc_test` and `sdlc_typecheck` commands; replace those commands before starting a delivery run.

## Try the local package in an unrelated repository

Install the generated tarball, preview the bounded changes, and then initialize. During local testing, pin the generated repository launcher to the tarball:

```sh
npm install --global ./codex-sdlc-0.3.0.tgz
codex-sdlc init --root /path/to/project --name example --applications web --web-root . --web-preset nextjs --runtime-spec file:/absolute/path/codex-sdlc-0.3.0.tgz --dry-run
codex-sdlc init --root /path/to/project --name example --applications web --web-root . --web-preset nextjs --runtime-spec file:/absolute/path/codex-sdlc-0.3.0.tgz
cd /path/to/project
node .sdlc/runtime.cjs restore
```

Then verify the installation:

```sh
node .sdlc/runtime.cjs doctor
node .sdlc/runtime.cjs validate-config
```

The installer preserves existing `AGENTS.md` and `.gitignore` content, refuses conflicting managed files, and is byte-idempotent for identical inputs. It does not modify a root package manifest or application code. Preset commands assume the conventional tool and script names shown above; adjust `.sdlc/project.yaml` if the repository uses different commands.

## Upgrade, rollback, and uninstall

Preview and apply an upgrade with the new runtime package pinned into the repository:

```sh
codex-sdlc upgrade --root /path/to/project --runtime-spec file:/absolute/path/codex-sdlc-0.3.0.tgz --dry-run
codex-sdlc upgrade --root /path/to/project --runtime-spec file:/absolute/path/codex-sdlc-0.3.0.tgz
cd /path/to/project
node .sdlc/runtime.cjs restore
node .sdlc/runtime.cjs doctor
```

Every applied upgrade creates a backup under `.sdlc/backups/<backup-id>/`. Roll back the latest available backup, or select the ID printed by `upgrade`:

```sh
codex-sdlc rollback --root /path/to/project --dry-run
codex-sdlc rollback --root /path/to/project --backup <backup-id>
cd /path/to/project
node .sdlc/runtime.cjs restore
```

Rollback verifies that managed files still match the state produced by the original operation. It refuses to overwrite later edits.

Preview and apply an uninstall:

```sh
codex-sdlc uninstall --root /path/to/project --dry-run
codex-sdlc uninstall --root /path/to/project
```

Uninstall removes the managed framework, launcher, tooling, policy, schema, workflow, template, and preset files. It removes only the marked `AGENTS.md` block and `.gitignore` entries recorded as framework-added. Project configuration, requests, runs, evidence, application code, and lifecycle backups remain available. The global `codex-sdlc rollback` command can restore an uninstall backup.

## Package boundaries

- `src/` contains the CLI and deterministic runtime.
- `assets/` contains managed schemas, workflows, policies, presets, and templates.
- `skills/` is the Codex plugin skill bundle.
- `compatibility/legacy-v1/` retains private source material for future migration engineering and is excluded from the npm package.
- `plugin.json` is the portable Agent Plugins manifest; `.codex-plugin/plugin.json` is the supported Codex compatibility overlay.

## Data and security

The runtime reads and writes repository files only. It does not operate a remote service or send repository content to a codex-sdlc server. Command evidence, including captured standard output and standard error, is stored locally under `.sdlc/runs/`. Configure secret environment-variable names in the installed policy so evidence redaction can remove their values. See [SECURITY.md](SECURITY.md) and [docs/privacy.md](docs/privacy.md) for reporting and retention details.

## Support and contribution

Use [GitHub Discussions](https://github.com/prime-vimihi/codex-sdlc/discussions) for usage help, [GitHub Issues](https://github.com/prime-vimihi/codex-sdlc/issues) for reproducible defects, and the private process in [SECURITY.md](SECURITY.md) for vulnerabilities. Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md). This project is licensed under Apache-2.0.

The portable project command is `node .sdlc/runtime.cjs ...`. Run records remain under `.sdlc/runs/`; the manifest is the authority for an active delivery.

## Local Codex plugin marketplace

Build a self-contained local marketplace directory:

```sh
npm run build:marketplace
```

The command writes `build/marketplace/marketplace.json` and `build/marketplace/plugins/codex-sdlc/`. Install it with:

```sh
codex plugin marketplace add ./build/marketplace
codex plugin add codex-sdlc@codex-sdlc-local
```

These commands change the user's Codex configuration, so they remain separate from building and validating the source package. Open a fresh Codex session after installation so the six skills are discovered from the installed plugin bytes.
