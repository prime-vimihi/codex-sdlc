# Choose a model for each SDLC role

Available in codex-sdlc 0.5.0. Both the plugin and the repository runtime must support this version. Updating the plugin does not upgrade existing projects; upgrade the runtime first as described in the [getting started guide](getting-started.md).

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
