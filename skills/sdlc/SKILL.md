---
name: sdlc
description: Handle /sdlc or $sdlc feature requests, including opt-in --compact delivery and --save-my-token or --normal project model presets, and route work to sdlc-pm.
---

# SDLC entry point

Treat `/sdlc --save-my-token` and `/sdlc --normal` as chat shorthand for this skill. Explicit skill invocation is `$sdlc --save-my-token` or `$sdlc --normal`; this plugin does not register a native Codex slash command. If the client rejects `/sdlc` before sending the prompt, use the explicit skill form.

## Project model mode

1. Resolve the selected project's coordinator directory and read its `AGENTS.md` and `.sdlc/project.yaml`. In a multi-repository workspace, the coordinator owns this setting for all mapped applications. Never select a different project or write global Codex settings. If the coordinator is unknown, ask for its location. If the project is not initialized, explain that setup is required; use [sdlc-setup](../sdlc-setup/SKILL.md) when initialization is requested rather than inventing application roots.
2. Accept exactly one of `--save-my-token` and `--normal`. Both together, or either combined with custom role model, effort, fallback, reset, or PO settings, are conflicting requests: explain the conflict without changing configuration. Custom role changes can be made separately through [sdlc-setup](../sdlc-setup/SKILL.md).
3. From the coordinator, run the corresponding command below with `--dry-run --json` first. Inspect the returned settings. An explicit mode request authorizes saving that preset: unless the user asked only for a preview, run the same command without `--dry-run`. Do not ask for another confirmation for the requested mode. If the runtime rejects the new flag, report that its version lacks this feature and use the setup upgrade workflow with version 0.6.0 or newer. Do not rewrite project configuration manually or claim success after a failed command.

   ```sh
   node .sdlc/runtime.cjs configure-agents --save-my-token --dry-run --json
   node .sdlc/runtime.cjs configure-agents --save-my-token --json
   ```

   Or, for normal mode:

   ```sh
   node .sdlc/runtime.cjs configure-agents --normal --dry-run --json
   node .sdlc/runtime.cjs configure-agents --normal --json
   ```

4. Report the saved project and role settings from the successful result. Settings apply to every new run in that project until changed. Existing runs keep their snapshots. A mode-only request ends here; it does not create or resume a delivery run. If the same request includes a new feature, save the mode before routing that feature to [sdlc-pm](../sdlc-pm/SKILL.md). Resuming a run keeps that run's original policy even after saving a mode.

| Role | `--save-my-token` | `--normal` |
| --- | --- | --- |
| PM | Inherited | Inherited |
| BA | `gpt-6-sol`, `high` | Inherited |
| Backend | `gpt-6-luna`, `xhigh` | Inherited |
| Frontend (web and mobile) | `gpt-6-luna`, `xhigh` | Inherited |
| QC | `gpt-6-luna`, `xhigh` | Inherited |

`xhigh` means extra-high reasoning. Both presets replace these five roles' previous models, efforts, and fallbacks. Normal mode restores inheritance rather than restoring earlier custom models. Both preserve optional AI Product Owner settings. No fallback is added. Dispatch still checks the host's model and reasoning capabilities; report an unavailable selection instead of silently substituting another model. The preset is a model configuration, not a guarantee about token usage.

## Delivery requests

For `$sdlc --compact <feature>` or `/sdlc --compact <feature>`, follow the [Compact workflow](../sdlc-pm/references/compact-workflow.md). Compact applies only to that new run and requires a complete low-risk assessment. Full remains the default. An existing run retains its saved profile; do not convert it during resume. If Compact is unsuitable, explain why Full is required before starting a new Full run. A standalone `--compact` without a feature does not start work or change project configuration. If an explicitly requested model preset accompanies the feature, save it first and then apply the independently selected workflow profile.

For a feature request or explicit resume without either mode flag, use [sdlc-pm](../sdlc-pm/SKILL.md) and preserve the saved project mode. A bare `/sdlc` or `$sdlc` explains the two mode commands and asks what feature to start or run to resume; it does not reset models or start unspecified work.
