<p align="center">
  <img src="assets/brand/codex-sdlc.svg" alt="codex-sdlc logo" width="108" height="108">
</p>

<h1 align="center">codex-sdlc</h1>

<p align="center">
  <strong>One request. A complete delivery workflow.</strong><br>
  Describe what you want to build. codex-sdlc coordinates the work from requirements to final review.<br>
  You steer the decisions. The AI team carries the process forward.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codex-sdlc"><img src="https://img.shields.io/npm/v/codex-sdlc?style=flat-square&amp;logo=npm&amp;logoColor=white&amp;labelColor=101820&amp;color=168b67" alt="npm version"></a>
  <a href="https://github.com/prime-vimihi/codex-sdlc/actions/workflows/verify.yml"><img src="https://img.shields.io/github/actions/workflow/status/prime-vimihi/codex-sdlc/verify.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=verify&amp;labelColor=101820" alt="Verification workflow status"></a>
  <a href="https://www.npmjs.com/package/codex-sdlc"><img src="https://img.shields.io/node/v/codex-sdlc?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white&amp;labelColor=101820&amp;color=168b67" alt="Required Node.js version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/prime-vimihi/codex-sdlc?style=flat-square&amp;labelColor=101820&amp;color=168b67" alt="Apache-2.0 license"></a>
</p>

<p align="center">
  <a href="https://chatgpt.com/plugins/plugins_6aa375d1f1d48191b6a2a5f95e1b8a64"><strong>Install the plugin</strong></a>
  &nbsp; · &nbsp;
  <a href="docs/getting-started.md">Getting started</a>
  &nbsp; · &nbsp;
  <a href="docs/agent-models.md">Role models</a>
  &nbsp; · &nbsp;
  <a href="https://github.com/prime-vimihi/codex-sdlc/releases">Releases</a>
</p>

---

## Describe the outcome. Start the workflow.

Once your project is set up, give Codex a feature request in plain language. **codex-sdlc leads the delivery process** through requirements, planning, implementation, integration, independent quality control, and a final delivery report. It brings you in for clarifications and material decisions; final acceptance remains yours.

<p align="center">
  <img src="assets/brand/delivery-overview.svg" alt="Amber YOU stages: describe your request, clarify goals and approve material decisions when needed, then accept the delivery or request changes. Teal AI stages: requirements and planning, implementation and integration, independent QC, and a delivery report with optional AI Product Owner advice. The coordinator records the workflow so it can resume later." width="1080">
</p>

**Amber / YOU:** provide the request and make decisions. **Teal / AI:** coordinate and carry out the delivery work.

PM coordinates the stages and reviews each handoff. Frontend work follows the reviewed API contract; independent QC follows integration. The optional AI Product Owner offers advice before PM prepares the final package. **Only you accept delivery.**

### A workflow you can resume

Eight Codex skills and a repository-local CLI keep tasks, evidence, blockers, and decisions in your repository. The next session can continue from recorded state.

| What you need | What codex-sdlc provides |
| --- | --- |
| Turn a simple request into a delivery workflow | Coordinated requirements, implementation, independent QC, and a final report. |
| Continue work across sessions | Saved run manifests, task dependencies, blockers, and decisions. |
| Work across separate codebases | One coordinator with explicit backend, web, and mobile repository mappings. |
| Choose a model for each role | Per-role model and reasoning settings, explicit fallbacks, and dispatch records. |
| Know what was actually verified | Independent QC, acceptance coverage, and recorded command evidence. |
| Stay in control of delivery | Optional AI Product Owner advice followed by your explicit acceptance. |

## Get started

**New in 1.0.1:** Token-saving mode now selects GPT-6.1 Sol for BA. Update both plugin and project runtime, then reapply the preset for new runs. See the [release notes](docs/releases/1.0.1.md).

**New in 1.0.0:** Runtime-assisted delivery reduces manual task bookkeeping, and eligible bounded features can use opt-in Compact mode. See the [release notes](docs/releases/1.0.0.md) for changes and upgrade guidance.

You need **Codex**, **Node.js `>=24.16.0 <25`**, **npm 11**, and an existing application repository. Setup configures your application directories; it does not scaffold application code.

### 1. Install the plugin

Install [codex-sdlc from the Plugins Directory](https://chatgpt.com/plugins/plugins_6aa375d1f1d48191b6a2a5f95e1b8a64), then open your repository in Codex.

### 2. Initialize your project

Ask Codex:

```text
Initialize codex-sdlc for this project. Explain the setup choices
and show the dry run before applying changes.
```

Tell Codex where your backend, web, or mobile applications live. It previews the setup, creates `.sdlc/` and a managed `AGENTS.md` block, restores the pinned runtime, and checks the configuration.

### 3. Start a feature

After setup checks pass:

```text
Start a codex-sdlc feature delivery for: <describe the outcome you want>.
```

To continue later, ask Codex to resume the existing run. Its manifest records the current tasks, completed work, and remaining decisions.

**Version note:** Compact mode and the new task helpers require both the **1.0.0 plugin and runtime**. Check your installed plugin version; updating the plugin does not upgrade an existing project's runtime. See the [upgrade guide](docs/getting-started.md#upgrade-an-existing-project).

<details>
<summary><strong>Prefer the CLI? Preview a Next.js setup</strong></summary>

Run this against an existing web repository:

```sh
npx --yes codex-sdlc@1.0.1 init \
  --root /absolute/path/to/web --name example-web \
  --applications web --web-root . --web-preset nextjs \
  --dry-run
```

Run the same command without `--dry-run` to apply it, then:

```sh
cd /absolute/path/to/web
node .sdlc/runtime.cjs restore
node .sdlc/runtime.cjs doctor
node .sdlc/runtime.cjs validate-config
```

For a global CLI installation, use `npm install --global codex-sdlc@1.0.1`.

</details>

## Your repositories. Your stack.

### Less delivery bookkeeping in 1.0.0

The runtime can now prepare task assignments, record agent activation, collect declared checks, and generate handoff reports from real files and execution evidence. PM still reviews the result, and QC still verifies acceptance independently.

- `preflight` detects local application/root, fixture-file, and command problems before implementation. Live services and populated data remain explicit checks.
- `prepare-task`, `activate-task`, `check-task`, and `handoff-task` replace manual IDs, hashes, inventories, and report metadata for eligible backend/frontend work.
- `repair-task` preserves earlier cycles and invalidates affected verification after a QC defect or rejected implementation review. `recover-repair` handles an interrupted file transaction.
- `timing` reports recorded lifecycle intervals and collector durations, with overlapping work and unknown model time clearly distinguished.
- Configured roots such as `apps/api` and Next.js route groups/dynamic segments work consistently. Several technical capabilities can reference one business requirement.

See [runtime-assisted delivery](skills/sdlc-pm/references/task-operations.md) and [1.0.0 release notes](docs/releases/1.0.0.md). Full remains the default; eligible new runs can now opt into Compact. Parallel scheduling and evidence caching remain deferred. Automatic handoff verifies the caller-declared task-owned subset of actual uncommitted Git changes; it does not independently infer ownership of omitted files or support deleted product paths.

### Compact delivery for bounded features

```text
$sdlc --compact <describe the feature>
```

Compact uses one specification and one independent QC record, with compatibility views and metadata generated by the runtime. It combines requirements/API review and integrated QC into fewer handoffs, while preserving affected implementation roles, permission boundaries, repair history, and final human acceptance.

Only use it when scope and existing patterns are understood. Migrations, breaking APIs, authorization changes, new sensitive-data exposure, or unresolved risk require Full. The profile is frozen per run; `--save-my-token` and `--normal` continue to configure models separately. See the [Compact guide](skills/sdlc-pm/references/compact-workflow.md).

A [reproducible scripted benchmark](docs/workflow-benchmark.md) compares identical acceptance checks and seeded defects. Its timings measure local framework work, not real agent implementation time or token savings.

Start with a web-only, mobile-only, backend-only, or combined project. Use multi-repository mode when the applications live in separate Git checkouts.

| Layer | Built-in preset |
| --- | --- |
| Backend | Go |
| Web | Next.js |
| Mobile | Flutter |
| Primary database | PostgreSQL |
| Cache | Redis |

Other stacks can use the `generic` application preset with project-specific verification commands. Use `none` when no database preset applies.

**Frontend here, backend elsewhere?** Ask Codex:

```text
Use this frontend repository as the codex-sdlc coordinator.
My Go backend is at /absolute/path/to/backend.
Initialize multi-repository mode with Next.js and Go.
Show the dry run first.
```

The coordinator owns `.sdlc/`. Each mapped checkout must be a Git root with an `origin` remote. Shared configuration records repository identity; ignored `.sdlc/local.yaml` records paths on your machine.

→ [Project setup examples](docs/getting-started.md#common-project-shapes) · [Multi-repository guide](docs/multi-repository.md)

## Choose the team behind the work

Keep Codex's inherited models, or configure a model and reasoning effort for each delivery role.

| Skill | Responsibility |
| --- | --- |
| `sdlc` | Apply project model modes and route feature requests to PM. |
| `sdlc-setup` | Initialize, diagnose, configure, upgrade, roll back, and uninstall. |
| `sdlc-pm` | Coordinate delivery, review handoffs, and prepare the final package. |
| `sdlc-ba` | Define requirements, acceptance criteria, and traceability. |
| `sdlc-backend` | Own API contracts, backend implementation, and data changes. |
| `sdlc-frontend` | Implement the affected web or mobile experience. |
| `sdlc-qc` | Independently verify acceptance coverage, defects, and retests. |
| `sdlc-po` | Provide an optional advisory Product Owner review after QC. |

For example, with a compatible plugin and runtime:

```text
Use Astra for frontend, Luna for backend, and Sol for PM and QC.
Enable advisory AI Product Owner review with Sol.
Keep other roles inherited and preview the settings first.
```

Selections must be available on your Codex host. New runs snapshot the settings; existing runs keep theirs. An unavailable model stops dispatch unless you configured an explicit fallback. Actual model metadata stays unknown when the host does not report it.

→ [Model configuration, fallbacks, and AI Product Owner review](docs/agent-models.md)

### Project model modes

These chat shortcuts, introduced in 0.6.0, remain available:

```text
/sdlc --save-my-token
/sdlc --normal
```

Token-saving mode keeps PM inherited, uses GPT-6.1 Sol (`gpt-6.1-sol`) with high reasoning for BA, and Luna (`gpt-6-luna`) with extra-high reasoning for backend, web/mobile frontend, and QC. Normal mode restores inheritance for those roles. Both save to the current project's `.sdlc/project.yaml` for every new run; existing runs and optional AI Product Owner settings are preserved.

These are skill-handled chat shortcuts. In clients that reject custom slash commands, invoke `$sdlc --save-my-token` or `$sdlc --normal`. The updated token-saving preset requires plugin/runtime 1.0.1 or newer; normal mode requires 0.6.0 or newer. After upgrading an existing project, reapply `--save-my-token` to update its saved preset. See [project mode details and CLI equivalents](docs/agent-models.md#project-model-modes).

## What stays in your repository

```text
your-coordinator/
├── AGENTS.md                # Managed Codex guidance
└── .sdlc/
    ├── project.yaml         # Project, repositories, presets, role settings
    ├── local.yaml           # Local checkout paths in multi-repo mode (ignored)
    ├── framework.lock.yaml  # Pinned framework installation
    ├── runtime.cjs          # Repository command launcher
    ├── requests/            # Feature requests
    └── runs/                # Manifests, artifacts, decisions, and evidence
```

This is the key-file view; setup also installs the framework's policies, schemas, workflows, and templates. Plugin skills stay in Codex's plugin cache, so a plugin-based setup does not need a project `.agents/skills` folder.

codex-sdlc does not operate a hosted service or send repository content to a codex-sdlc server. Codex and any tools you run have their own data handling. Command evidence is stored locally; configure secret redaction as described in the [security guidance](SECURITY.md) and [privacy policy](docs/privacy.md).

## Upgrade with a way back

Preview a project upgrade before applying it:

```sh
npx --yes codex-sdlc@1.0.1 upgrade \
  --root /absolute/path/to/coordinator --dry-run
```

Applied upgrades create backups. Rollback checks managed-file integrity before restoring them. Uninstall preserves project configuration, requests, run history, and application code.

→ [Upgrade an existing project](docs/getting-started.md#upgrade-an-existing-project) · [CLI setup and lifecycle reference](docs/cli-reference.md)

## Explore the documentation

| Start here | Go deeper |
| --- | --- |
| [Getting started](docs/getting-started.md) | [CLI setup and lifecycle reference](docs/cli-reference.md) |
| [Multi-repository workspaces](docs/multi-repository.md) | [Role models and dispatch records](docs/agent-models.md) |
| [What's new in 1.0.1](docs/releases/1.0.1.md) | [Release history](https://github.com/prime-vimihi/codex-sdlc/releases) |
| [Support](SUPPORT.md) | [Contributing](CONTRIBUTING.md) |

Current verification includes automated runtime tests, plugin and skill validation, and independent built-CLI checks. Native Linux/Windows qualification and a matched real-agent performance benchmark remain pending. See the [1.0.1 validation notes](docs/releases/1.0.1.md#validation).

## Build with us

Try codex-sdlc on a project, [report a reproducible issue](https://github.com/prime-vimihi/codex-sdlc/issues), or [contribute an improvement](CONTRIBUTING.md). For security reports, follow [SECURITY.md](SECURITY.md).

```sh
npm ci
npm run verify
```

See the [contributor reference](docs/cli-reference.md#local-codex-plugin-marketplace) for building and testing a local plugin marketplace. Licensed under [Apache-2.0](LICENSE).

<p align="center">
  <strong>Start with one feature. Keep the evidence for the next session.</strong><br>
  <a href="docs/getting-started.md">Get started with codex-sdlc →</a>
</p>
