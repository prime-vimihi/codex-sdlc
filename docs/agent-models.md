# Choose a model for each SDLC role

Custom role settings are available in codex-sdlc 0.5.0. The updated token-saving preset requires both the 1.0.1 plugin and runtime; normal mode remains supported from 0.6.0. Updating the plugin does not upgrade existing projects; upgrade the runtime as described in the [getting started guide](getting-started.md).

## Project model modes

In your initialized project's Codex task, send:

```text
/sdlc --save-my-token
```

The new `sdlc` skill interprets this chat shorthand and saves the following project configuration:

| Role | Model | Reasoning |
| --- | --- | --- |
| PM | Inherited | Inherited |
| BA | `gpt-6.1-sol` | `high` |
| Backend | `gpt-6-luna` | `xhigh` (extra-high) |
| Frontend, including web and mobile | `gpt-6-luna` | `xhigh` (extra-high) |
| QC | `gpt-6-luna` | `xhigh` (extra-high) |

To restore normal inherited models:

```text
/sdlc --normal
```

Normal mode removes model, reasoning, and fallback overrides for PM, BA, backend, frontend, and QC. It does not restore custom models that existed before token-saving mode. Both commands preserve optional AI Product Owner configuration and all other project settings.

Each selection is stored in the coordinator's `.sdlc/project.yaml` and applies to **every new run** until you change it. After upgrading from 1.0.0, send `/sdlc --save-my-token` again to replace the saved BA selection with GPT-6.1 Sol. Upgrading alone preserves saved settings. Other projects and existing runs are unaffected. A mode-only request does not start a feature run. In a multi-repository workspace, run it in the coordinator to cover its mapped applications. An uninitialized project needs setup first.

Codex's explicit skill syntax is `$sdlc --save-my-token` or `$sdlc --normal`; use it if your client reserves slash commands for built-in actions. The plugin handles `/sdlc` as prompt shorthand rather than registering a native slash command. See [official skill invocation guidance](https://learn.chatgpt.com/docs/build-skills).

The equivalent runtime commands, from the coordinator, are:

```sh
node .sdlc/runtime.cjs configure-agents --save-my-token
node .sdlc/runtime.cjs configure-agents --normal
```

Add `--dry-run --json` to preview without saving. Use `--root /absolute/path/to/coordinator` to select a project explicitly. The two modes are mutually exclusive and cannot be combined with individual role or PO configuration flags; make custom changes in a separate invocation. Applying the same preset again keeps the same settings.

The preset requires `gpt-6.1-sol/high` and `gpt-6-luna/xhigh` support on the user's host. Configuration saves the requested policy; dispatch still validates availability. No fallback is added, and an unavailable model or effort stops dispatch. Token-saving mode selects these models; actual token usage depends on the work.

The model IDs match [OpenAI's current Codex model guidance](https://learn.chatgpt.com/docs/models), checked on 2026-10-05. GPT-6.1 Sol is the newer Sol selection; GPT-6 Luna remains the current Luna selection. SDLC pins exact IDs rather than silently changing a saved policy when another generation is released. Reasoning effort is retained across this update; compare actual delivery results before claiming time or token savings.

## Custom role settings

Ask Codex:

```text
Configure codex-sdlc to use Astra for frontend, Luna for backend, and Sol for QC and PM. Keep other roles inherited and show the settings before applying them.
```

Use exact model IDs supported by your Codex host. Names and account availability vary. The example below uses `gpt-6-astra`, `gpt-5.6-luna`, and `gpt-5.6-sol`; it does not assume every user has those models.

## Configure an existing project

From the coordinator repository:

```sh
node .sdlc/runtime.cjs configure-agents \
  --agent-model frontend=gpt-6-astra \
  --agent-model backend=gpt-5.6-luna \
  --agent-model qc=gpt-5.6-sol \
  --agent-model pm=gpt-5.6-sol \
  --dry-run --json
```

Remove `--dry-run` to save the previewed settings. Add `--agent-reasoning pm=high` if you want an explicit reasoning effort. Unspecified roles continue to inherit from Codex. For configured models, the planner checks the host’s effort inheritance; it uses an advertised model default when needed, or asks for an explicit compatible effort when the host cannot resolve omission safely. Replacing a role's model clears its old effort and fallback; include those flags again if wanted.

The same flags work with `init`, in single-repository and multi-repository setups. Settings live in the coordinator's committed `.sdlc/project.yaml`:

```yaml
agents:
  roles:
    frontend:
      model: gpt-6-astra
    backend:
      model: gpt-5.6-luna
    qc:
      model: gpt-5.6-sol
    pm:
      model: gpt-5.6-sol
  product_owner_review: disabled
```

| Role key | Work |
| --- | --- |
| `pm` | Intake, coordination reviews, integration review, final package |
| `ba` | Business analysis and acceptance criteria |
| `backend` | API contract and backend implementation |
| `frontend` | Both web and mobile implementation |
| `qc` | Independent quality control |
| `po` | Advisory AI Product Owner review |

Each new run copies these settings into `manifest.agent_policy`. Changing project settings affects new runs. An already started run keeps its settings and task graph; do not hand-edit its snapshot to change a model midway.

## Availability and fallback

The plugin checks requested models and reasoning efforts against the current host's agent capabilities before launching. Missing capability, an unavailable selection, or a later host rejection stops that dispatch with a diagnostic. Project configuration alone cannot grant access to a model.

There is no automatic fallback. To authorize one explicitly:

```sh
node .sdlc/runtime.cjs configure-agents \
  --agent-fallback backend=gpt-5.6-sol:low
```

This sets the backend's fallback model and effort. Use `--agent-fallback backend=none` to clear it. The YAML format also supports an ordered `fallbacks` list. A fallback is chosen only when the requested model/effort is absent from the host's advertised capabilities. Runtime access or capacity failures are surfaced for resolution.

To restore model inheritance:

```sh
node .sdlc/runtime.cjs configure-agents --reset-role frontend
```

## AI Product Owner review

Enable it with an inherited model:

```sh
node .sdlc/runtime.cjs configure-agents --po-review advisory
```

Or choose a model, which also enables the review:

```sh
node .sdlc/runtime.cjs configure-agents --agent-model po=gpt-5.6-sol
```

New runs add `PO-001` after QC and before the PM delivery package. The reviewer checks business value, acceptance coverage, and limitations and publishes `artifacts/po/advisory-review.yaml`. It can recommend readiness for human review or recommend changes. PM includes that recommendation in the final package.

**The AI cannot accept delivery on your behalf.** Finalization leaves your decision pending. Codex records acceptance only after you explicitly provide it. To disable the additional review for new runs:

```sh
node .sdlc/runtime.cjs configure-agents --reset-role po --po-review disabled
```

## How execution works

The PM skill passes the configured model and optional effort to Codex's actual agent launch tool. The runtime validates the plan and records the returned agent ID before the task starts. A model name written in a prompt does not switch models. No API keys or generated `.codex/agents` files are required by this feature.

For a configured PM model, the current conversation dispatches each PM task to a separate PM agent and relays its results. It keeps user communication and human decisions in the current conversation. This does not change the current conversation's model.

Each task's `agent_dispatches` records the requested and selected model, explicit fallback use, host capability source, and returned agent ID. Actual model/effort fields are populated only when reported by the host; otherwise they remain `null`. This is an audit supplied by the orchestration adapter, not independent proof of the host's internal model selection.

For adapter details, see the plugin's [routing contract](../skills/sdlc-pm/references/agent-model-routing.md). Codex model selection and inheritance are documented in the [official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).
