---
name: sdlc-pm
description: Use when starting, coordinating, resuming, reviewing, or finalizing a complete repository-scoped feature delivery through business analysis, backend, web/mobile frontend, integration, and quality assurance.
---

# SDLC Project Orchestrator

Make repository state—not an agent claim—the source of delivery truth. Read [role contract](references/role-contract.md), [orchestration contract](references/orchestration-contract.md), [approval contract](references/approval-contract.md), and [final review contract](references/final-review-contract.md).

For a delegated assignment with `execution_mode: task-only`, perform only the named PM task in its allowed scope and return its artifacts and review conclusions to the dispatcher. Wait for activation if instructed. Do not create another PM or run the complete orchestration loop.

## Establish state

1. Read `AGENTS.md`, applicable nested instructions, `.sdlc/project.yaml`, selected workflow, all policies, and `.sdlc/runs/<run-id>/manifest.yaml`. If `workspace.mode` is `multi-repository`, also resolve `.sdlc/local.yaml` and stop on any missing or remote-mismatched mapping. The coordinator repository owns `.sdlc` authority; application and resource paths resolve inside the repository IDs declared in project configuration. For a new request, save the request then create the run with `node .sdlc/runtime.cjs start --id <run-id> --title <title> --request <request-path> --applications <backend,web,mobile,database,shared-packages>`.
2. Run `node .sdlc/runtime.cjs ready <run-id>` and `node .sdlc/runtime.cjs validate-run <run-id>` before planning or resuming. Treat the manifest task statuses, dependencies, affected applications, required inputs/outputs, evidence, gates, defects, blockers, and decisions as authoritative.
3. Build the graph from the selected workflow and manifest: intake → BA → PM requirements review → backend API contract → PM API review → affected backend/web/mobile implementation → PM integration → QC → optional AI Product Owner advisory review → PM delivery package → human Product Owner decision. Never omit BA; never dispatch frontend before the reviewed API contract.
4. During intake, normalize explicit Product Owner statements into `.sdlc/runs/<run-id>/facts.yaml`. Keep inferred or ambiguous material behavior `proposed` or `unresolved`; never promote it to `approved` without a recorded decision. During requirements review, validate all seven BA artifacts, their schemas, one-to-one fact/claim reconciliation, and cross-artifact claim links before passing the requirements gate.

## Dispatch and verify

When the run has `agent_policy`, read [agent model routing](references/agent-model-routing.md) before dispatch. Use actual model-selecting spawn parameters, record successful agent launches through the runtime, and preserve unreported actual models as unknown. Configured PM tasks run in task-only PM children; the parent coordinates and relays their results. Configured non-PM tasks also require the spawn/record/activate sequence in that reference before execution. Use the legacy sequence below only for roles without a configured model.

For each ready non-PM task, first verify that dependencies are completed and every required input exists. For backend or frontend work, create the current schema-valid `.sdlc/runs/<run-id>/tasks/<task-id>.assignment.yaml`, bind its revision and hash to the authority snapshot, then transition `ready -> running`. The pre-start assignment authorizes execution: set `task_status: running` and `transition_policy` to `current_status: running`, `allowed_request: awaiting_review`, and `unmet_disposition: refuse`; do not copy the temporary manifest `ready` state into those fields. Send the matching `$sdlc-ba`, `$sdlc-backend`, `$sdlc-frontend`, or `$sdlc-qc` assignment using every field in the orchestration contract. Required outputs, collector evidence, and quality gates are not prerequisites for `ready -> running`; they are produced or verified later. Assign one frontend target at a time. PM performs intake, requirements/API reviews, integration report, and final package only in PM-permitted paths, through task-only PM children when a PM model is configured. Dispatch `PO-001` with `$sdlc-po` when the run includes it; the AI review is advisory.

Follow the runtime state sequence exactly. Backend/frontend roles return only their task-specific typed delivery report and never request `completed`. Before any handoff transition, PM validates the assignment, authority, report, artifact integrity, exact changed-file manifest, collector evidence, target ownership, and normative disposition with production reconciliation. The role hands work off through `running -> awaiting_review` only after all required outputs exist and, for tasks whose runtime gate requires it, passed collector evidence exists. PM or the designated reviewer uses `awaiting_review -> completed` only after reviewing the handoff, confirming required outputs and evidence, and confirming the relevant quality gate is passed. Never propose or use `ready -> completed` or `running -> completed`; neither edge exists. Use `node .sdlc/runtime.cjs transition <run-id> <task-id> <status> --actor pm --reason <reason>` from the current legal state, validate after each transition, and show ordered commands when planning more than one transition.

Use `node .sdlc/runtime.cjs evidence <run-id> <task-id> <command-id>` for configured command IDs only (`sdlc_test`, `sdlc_typecheck`, `sdlc_validate`); inspect the resulting evidence record, then use `quality-gate` to record the audited gate outcome with that evidence. Never turn a summary, code inspection, screenshot claim, or unavailable application into passing evidence.

In a multi-repository workspace, set an assignment's `repository` to the target application repository; for `api_contract`, use the configured `resources.api_contracts.repository` when present. Product changed-file entries and ownership records must carry that repository ID, while coordinator `.sdlc` artifact paths remain portable strings.

## Hold, repair, and finish

Pause only for a declared material Product Owner decision or a genuine repository blocker. For approval, transition `running -> awaiting_approval`, create an `approval-request` bound to the exact later `running` or `completed` action, record `approval-decision`, then pass its ID with `transition --decision`; a pending, rejected, incomplete, differently bound, or already consumed decision does not authorize the edge. Each approval transition consumes its decision exactly once; a later cycle requires a new `DEC-*` ID. Use `ready -> blocked` or another source edge actually supported by the runtime to create a blocker; keep an ineligible pending task pending. Recover only through `blocked -> ready` after every open task blocker is resolved, passing the concrete blocker ID with `--resolve-blocker`, then use a separate `ready -> running` transition. A task may enter `failed` only from a runtime-supported source and only with failure evidence. Recover through `failed -> ready` with `--retry-reason`, then use a separate `ready -> running` transition. Rework from review uses the legal `awaiting_review -> running` edge.

Route a QC defect to its responsible role. Require that role's corrected artifact and collector evidence, then rerun PM integration review and independent `$sdlc-qc` retest; do not reuse the original recommendation.

Do not deploy, use production credentials, perform destructive database/Git work, or override a hard prohibition. Product Owner approval requests are decisions, not authorization to bypass those limits.

After every required task is completed, affected gate is passed with evidence, and no blocker/critical defect remains, create the report from the repository template and run `node .sdlc/runtime.cjs finalize <run-id> --actor pm`. Provide the Product Owner package required by the final-review contract; record only the human Product Owner’s explicit delivery decision with `product-owner-decision`, and only accepted decisions complete the run.

For a PM V5 evaluator stimulus with `request_kind`, return exactly the four ordered sections and typed YAML shapes defined in the orchestration contract. Do not add any other heading or prose. Every planned command must be valid under the actual CLI and ordered from the stimulus state.

## Red flags

- “Obvious” feature, deadline, or implementation claim offered as a BA, gate, QC, or evidence substitute
- Web/mobile dispatched from a draft, missing, or unreviewed OpenAPI contract
- A direct write under `evidence/commands/` or a hand-written passing test result
- A production deploy or prohibited action requested after Product Owner approval
