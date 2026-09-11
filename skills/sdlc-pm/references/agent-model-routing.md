# Role model dispatch

Read this when `manifest.agent_policy` exists. It is the run's frozen policy; project settings apply only to new runs. Roles without settings retain host inheritance. Configuring `frontend` covers both web and mobile. A `po` role or advisory review setting adds `PO-001` between QC and the PM delivery package.

## Host preflight

Use the current host's advertised agent tool schema or model listing. Do not infer account access from an API model catalog, hardcode the author's available models, or turn a model name in a prompt into an execution claim. Supply a strict JSON object on standard input to `node .sdlc/runtime.cjs agent-plan <run-id> <task-id> --json`:

```json
{
  "source": "Current host spawn tool schema",
  "model_selection": true,
  "reasoning_selection": true,
  "omitted_reasoning_effort": "inherit-parent",
  "parent_reasoning_effort": "medium",
  "models": [
    { "id": "gpt-5.6-sol", "reasoning_efforts": ["low", "medium", "high", "xhigh", "max", "ultra"] }
  ]
}
```

This is a shape example. Populate it from the actual host. Describe omitted-effort behavior as `model-default`, `inherit-parent`, or `unknown`; supply the actual parent effort only if exposed. A model entry may include its host-advertised `default_reasoning_effort`. Do not infer the current effort from a model name. Set a capability to false when unavailable. An unavailable model/effort blocks routing unless a configured fallback matches. Tell the user when a fallback is selected. A later host rejection may still indicate account or capacity restrictions; report it and stop that dispatch. Do not change a project's preferences or invent availability to get past the error.

## Launch and record

1. Check the task is ready, dependencies are complete, and required inputs exist. Prepare any typed backend/frontend assignment through the existing publisher. Obtain the agent plan after those inputs are ready.
2. Delegate this bounded task with the returned `selected.model` and optional `selected.reasoning_effort` as actual tool parameters. If `selected` is null, omit model/effort parameters. Pass the plan’s selected effort when present, including an explicitly resolved host default. When absent, omission follows the host’s declared default/inheritance behavior; the planner checks inherited effort compatibility. Unknown behavior requires a configured effort or an advertised model default. With `collaboration.spawn_agent`, pass `fork_turns: "none"` and a self-contained assignment. Never combine overrides with a full-history fork. Do not select a named custom agent whose TOML overrides the intended model or effort.
3. The initial child message must tell it to wait for an activation message before producing artifacts. Include coordinator root, run/task identity, matching skill path, allowed scope, required inputs/outputs, configured command IDs, and the selected model plan. Shared repository state remains authoritative.
4. After a successful spawn, record its real returned agent ID with `agent-dispatch <run-id> <task-id> --json`. Supply the raw plan object from `agent-plan`'s `result`, not the CLI envelope:

```json
{
  "plan": { "...": "the unchanged agent-plan result" },
  "agent_id": "the actual returned ID",
  "actual_model": null,
  "actual_reasoning_effort": null,
  "observation_source": null
}
```

The `plan` placeholder above describes substitution; it is not a valid runnable package. Fill actual fields only from host metadata, with `observation_source` naming that response. Do not copy the requested values into actual fields or use the child's self-identification as proof. Many hosts return only an agent ID; leave unreported actual values null. These records are an adapter-supplied audit trail, not independent model attestation.
5. Transition the task `ready -> running`, then activate the child using a tool that wakes an idle child. With collaboration tools, use `followup_task`: `send_message` alone does not start an idle agent. If publication, recording, or transition fails, stop the waiting child and resolve the error before retrying. If the CLI publisher rejects a permissions policy, report the defect to setup; do not import internal runtime APIs to bypass actor-policy validation. Dispatch recording changes run authority; obtain any required fresh authority snapshot after activation before task execution. Do not reuse a hash from before the dispatch/transition.
6. Wait for the result. Keep legal handoff transitions, independent QC, and evidence checks. Record a replacement agent if resuming with a new child. A blocked/failed-to-ready retry requires a new plan and dispatch record for that activation. Never record a spawn that failed or reuse an old plan after task state changes.

## PM model

A skill cannot switch the current conversation's model. When `pm` has a configured model, the coordinating conversation acts as dispatcher and delegates each PM-owned task to a task-only PM child using the selected model. This includes intake, requirements/API reviews, integration, and the final delivery package. It may relay the PM child's reviewed instructions through runtime commands but must not substitute its own substantive PM work or invent the child's review conclusions.

A PM child receiving `execution_mode: task-only` performs only its assigned PM task and returns artifacts/review decisions to the dispatcher. It does not rerun the full orchestration loop, create another PM, or dispatch sibling roles. The dispatcher keeps user communication and recorded human decisions in the main conversation. This avoids requiring a PM child to have its own nested-agent capacity. If the host cannot launch the configured PM model, report that limitation instead of silently using the current conversation.

## AI Product Owner and human acceptance

When present, dispatch `PO-001` to `$sdlc-po` after QC. Review its schema-valid advisory artifact before completing it. Include the recommendation, coverage gaps, and findings in `PM-004` and the final user package. `changes_recommended` is valid advisory output, not a passing test or user rejection. Never translate an AI recommendation into human acceptance. Only record a final Product Owner decision that the user explicitly gave.
