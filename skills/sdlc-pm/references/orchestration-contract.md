# Orchestration contract

## Dependency graph

`PM-001 → BA-001 → PM-002 → BE-001 → PM-003 → {BE-002, WEB-001, MOBILE-001 as affected} → INT-001 → QC-001 → PM-004`.

Use the active manifest rather than these example IDs when a workflow supplies different IDs. `WEB-001` and `MOBILE-001` both require completed API-contract review; each is a separate frontend assignment. Integration waits for every affected implementation task.

## Assignment shape

Every role assignment contains:

```text
task_id: <manifest task ID>
role_and_target: <ba|backend|frontend/web|frontend/mobile|qc>
required_input_paths: <literal run-relative paths from task.required_inputs>
allowed_scope: <paths permitted by permissions policy>
required_outputs: <literal task.required_outputs>
configured_command_ids: <IDs from project.yaml, or none>
handoff_gate: <artifact/evidence/transition condition>
```

Do not mark a task complete from the handoff. Confirm files and evidence in the manifest, run `validate-run`, then use the legal transition. The deterministic runtime alone creates `evidence/commands/<evidence-id>/evidence.json`.

### Typed backend/frontend assignment

Before backend/frontend dispatch, render `.sdlc/runs/<run-id>/tasks/<task-id>.assignment.yaml` from `.sdlc/templates/pm/delivery-assignment.yaml` and validate it with `delivery-assignment.schema.json`. Bind the current positive assignment revision, facts revision, complete dependency states, required inputs, workflow outputs, permission roots, collector evidence, evidence requirements, transition policy, and role controls. When activating a ready task, the assignment describes its authorized execution state: use `task_status: running` and the `running -> awaiting_review` transition policy before issuing the separate `ready -> running` manifest transition. The canonical assignment path is represented by the authority snapshot's `assignment` record; do not use it to widen any other assignment field.

Build the authority snapshot from repository files and reconcile it before dispatch. PM ownership cannot broaden workflow output inventory or permission roots. For destructive work, require a complete bound unconsumed decision. Preserve the durable and non-authoritative storage roles declared by the project configuration.

When the role returns, parse exactly one typed delivery report. Validate its schema and reconcile identity, revisions, artifacts and their integrity, exact authority-owned changed files, target-owned writes, collector evidence, controlled observations, disposition, and transition. Reject the handoff on any diagnostic. The role never requests `completed`; only PM may later transition an independently reviewed task from `awaiting_review` to `completed`.

## PM V5 evaluator response

For a typed PM evaluator stimulus containing `request_kind`, return exactly these four level-two sections, in order, with exactly one YAML block in each and no other text:

1. `State assessment`: `run_id`, `run_status`, `current_task_id`, `current_task_status` copied from the stimulus.
2. `Ordered command plan`: `commands`, a non-empty ordered array. Each entry has exactly `order`, `source_status`, and `command`. `order` starts at 1. `source_status` is the actual source state for `transition` and null for every other command. Each command starts `node .sdlc/runtime.cjs` and uses the CLI table below.
3. `Role assignments`: `assignments`, an array. Use `[]` when no role handoff is currently legal. Each entry has exactly `task_id`, `role_skill`, `role`, `target`, `assignment_path`, `required_input_paths`, `allowed_scope`, `required_outputs`, `configured_command_ids`, and `handoff_gate`. Copy task arrays exactly. Backend/frontend use their canonical assignment path and `delivery_report_reconciliation`; other roles use a null assignment path.
4. `Lifecycle controls`: use exactly this mapping:

```yaml
ba_required: true
api_contract_review_required_before_frontend: true
collector_evidence_required: true
independent_qc_required: true
product_owner_decision_required: true
approval_decisions_single_use: true
deferred_review_resumable: true
production_deployment: prohibited
role_reports_may_request_completed: false
```

Scenario rules are state-derived: approval request precedes decision and its bound transition; intake never skips BA; backend API contract and PM review precede frontend; configured evidence precedes a passed gate and review completion; integration precedes independent QC; finalization prepares Product Owner review and never deploys.

## Transition sequence

Use the task's manifest status as the source state and preserve command order. The runtime transition edges and prerequisites used by PM are:

| Edge | Transition-specific prerequisites |
| --- | --- |
| `ready -> running` | Dependencies are completed, every required input exists, and the command supplies actor and reason. Required outputs, collector evidence, and quality gates are not required and are not prerequisites for starting work. |
| `running -> awaiting_review` | Every required output exists. Tasks for which the runtime requires collector evidence also have passed collector evidence before review. |
| `awaiting_review -> completed` | The reviewer has inspected the handoff; required outputs and required passed evidence exist; the relevant quality gate is passed. |
| `awaiting_review -> running` | Review requests rework; preserve the original start time and state the rework reason. |
| `blocked -> ready` | Every open blocker for the task is resolved; use `--resolve-blocker <blocker-id>` for the concrete open blocker. Continue with a separate `ready -> running` transition. |
| `failed -> ready` | The failure originated from a runtime-supported source and has failure evidence; supply `--retry-reason <reason>`. Continue with a separate `ready -> running` transition. |

Never propose or use `ready -> completed` or `running -> completed`. Do not collapse start, handoff, and review into one transition. `pending -> ready` activation is derived from completed dependencies by the runtime; inspect it with `ready` and validate the run rather than inventing a later state.

## CLI contract

| Purpose | Exact command |
| --- | --- |
| Start | `node .sdlc/runtime.cjs start --id <run-id> --title <title> --request <request-path> --applications <csv>` |
| Ready tasks | `node .sdlc/runtime.cjs ready <run-id>` |
| Transition | `node .sdlc/runtime.cjs transition <run-id> <task-id> <status> --actor pm --reason <reason>` |
| Validate run | `node .sdlc/runtime.cjs validate-run <run-id>` |
| Record command evidence | `node .sdlc/runtime.cjs evidence <run-id> <task-id> <command-id>` |
| Record quality gate | `node .sdlc/runtime.cjs quality-gate <run-id> <gate-id> <pending|running|passed|failed|blocked> --actor <actor> --reason <reason> --evidence <path>` |
| Request approval | `node .sdlc/runtime.cjs approval-request <run-id> <task-id> <running|completed> --id <DEC-id> --actor <actor> --topic <topic>` |
| Record approval decision | `node .sdlc/runtime.cjs approval-decision <run-id> <DEC-id> <approved|rejected> --approver <actor> --decision <text>` |
| Finalize | `node .sdlc/runtime.cjs finalize <run-id> --actor pm` |
| Product Owner decision | `node .sdlc/runtime.cjs product-owner-decision <run-id> <accepted|accepted_with_limitations|changes_requested|rejected|deferred> --actor product-owner --comments <comments>` |

Use `--resolve-blocker <blocker-id>` only for `blocked -> ready`, `--retry-reason <reason>` only for `failed -> ready`, and `--decision <DEC-id>` only for `awaiting_approval -> running|completed`. A transition plan lists commands in execution order and never skips an intermediate state. Never invent a CLI command, command ID, task state, evidence path, or quality-gate outcome.

## Defect loop

QC result → PM records/validates defect route → responsible implementation role repairs in permitted scope → collector evidence → PM integration recheck → independent QC retest → updated QC recommendation. A blocker or critical defect stays open until state proves otherwise.
