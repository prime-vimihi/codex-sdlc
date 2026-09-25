# Runtime-assisted delivery (1.0.0)

This helper flow supports both Full and Compact implementations. Select the saved profile first; [Compact](compact-workflow.md) has a different BA/QC artifact inventory and combines integration with independent QC. The assignment scenario `full_task` names an implementation contract and does not select the Full workflow profile.

Use this path for ordinary delivery on a 1.0.0 runtime. It preserves the existing task graph and independent review, while the runtime constructs mechanical authority metadata. Helpers serve eligible concrete tasks. Use the existing lower-level planning/hold workflow for missing dependencies, application scaffolding, or material approvals that preparation refuses; a refused helper call never authorizes a pending action. Legacy evaluator stimuli keep their specified response envelopes; do not use an evaluator envelope as the normal user-facing workflow.

## Readiness and scope

Read the selected coordinator's instructions and project configuration. Before starting implementation, identify the actual application (for example, customer web versus admin portal), services, and acceptance fixtures. Inspect the local selection:

```sh
node .sdlc/runtime.cjs preflight --applications backend,web --expect-root web=apps/platform --json
```

Replace application/root values with the user's actual selected project. Add `--require-file <path>` for an agreed local fixture, or `repository:path` for a mapped checkout. This operation never starts services or executes tests, and a ready result proves only its listed local checks. Live services, database connectivity, populated data, and host model availability remain explicitly unchecked. Establish their evidence before relying on them. Never seed persistent data silently or treat a fixture file as proof of a live database result.

Start/resume the run normally. Run IDs use uppercase `PROJECT-001` form. Retain approved facts, all required BA artifacts, requirements/API review, and target-scoped assignments. Do not create extra business requirements to populate technical capability slots: several capabilities may cite the same real `REQ-*`.

## Prepare the assignment

Provide semantic controls and verification command IDs as a strict JSON object on standard input. The runtime fills identity, revisions, hashes, dependencies, input/output inventories, permitted roots, and available evidence. Example frontend input (replace facts, requirements, and capabilities with actual reviewed ones):

```json
{
  "controls": {
    "api_contract_status": "approved",
    "gaps": [],
    "questions": [],
    "requirements": [
      {"requirement_id":"REQ-001","capability":"requested_behavior","required":true,"parameters":{},"source_references":[{"kind":"fact","reference":"FACT-001"}]}
    ]
  },
  "commandIds": ["sdlc_test", "sdlc_typecheck", "web_build"]
}
```

Backend controls retain `mode`, the five API capabilities, storage roles, and migration impact/approval fields from the backend contract. Capability names remain unique; requirement IDs may repeat across different capabilities. Supply actual semantic decisions, not guessed approval states. Select checks that prove the task's obligations, including its build where required; configuration validation alone does not prove application behavior.

```sh
node .sdlc/runtime.cjs prepare-task RUN-001 WEB-001 --dry-run --json < task-input.json
node .sdlc/runtime.cjs prepare-task RUN-001 WEB-001 --json < task-input.json
```

The packet includes assignment and authoritative metadata plus canonical paths. Preparation does not activate a task or launch an agent. Treat `authorityVersion` as an optimistic concurrency token; `--expected-version` rejects a stale caller. Do not read runtime source code to regenerate this packet.

## Dispatch and execute

Obtain `agent-plan` from actual host capabilities. Launch a bounded child with that plan, initially waiting. Then pass the real returned agent ID and unchanged plan in the usual dispatch JSON to:

```sh
node .sdlc/runtime.cjs activate-task RUN-001 WEB-001 --reason "Reviewed inputs and successful host dispatch" --json < dispatch.json
```

This records the dispatch and performs the legal ready-to-running transition. Only after success send the child its activation message. It never launches an LLM or verifies a model through self-identification. Unreported actual model/effort remains null. An exact retry is idempotent. If activation fails after recording dispatch, keep the child waiting, fix the reported prerequisite, and retry; do not assume it started. Already-running task replacement uses the existing documented resume/agent-dispatch flow.

While implementing, produce the required substantive artifacts with their canonical metadata. Keep product changes uncommitted through automatic handoff so the runtime can compare the explicit task-owned file list with Git changes. Unrelated dirty files stay outside the assignment.

```sh
node .sdlc/runtime.cjs check-task RUN-001 WEB-001 --json
```

This runs the assignment's required commands in order, under the existing execution/network-policy requirements. It stops on failure and reports remaining checks as not run. It records execution evidence, not gate approval. Non-delivery tasks select declared checks explicitly with repeatable `--command`. Rework product changes before re-running applicable checks; do not bypass network-policy enforcement by setting an attestation without the harness enforcing it.

## Hand off without retyping metadata

Provide a strict JSON object with substantive requirement outcomes and the actual task-owned Git changes:

```json
{
  "requirementOutcomes": [{"requirement_id":"REQ-001","capability":"requested_behavior","status":"implemented"}],
  "changedFiles": [{"path":"apps/platform/src/app/(portal)/example/page.tsx","type":"source"}]
}
```

Every assigned requirement/capability pair needs its own outcome. Use `documented` for contract work and `implemented` only for implemented behavior. In a multi-repository workspace include the assigned `repository` on each product change. Declare real source/test/generated changes; artifacts and their metadata are collected by the runtime.

```sh
node .sdlc/runtime.cjs handoff-task RUN-001 WEB-001 --json < outcomes.json
```

The runtime validates existing artifacts, current passed collector evidence, ownership, actual selected Git changes, and report reconciliation; publishes the report, changed-file inventory, and a deterministic handoff receipt; and requests `awaiting_review`. It never requests `completed`. A retry must match the saved report, outcomes, and source fingerprints. `--dry-run` validates without publication or transition.

The initial automatic path supports existing changed regular files, including new untracked files. Deleted files and already-committed-only changes are not silently accepted; report the limitation and preserve accurate changed-file/evidence records. Do not invent files, omit task changes, or claim a manual fallback verifies cases the runtime cannot represent.

Return the saved report path, task status, and any diagnostics rather than echoing the entire metadata envelope. PM independently reviews the substantive result and appropriate evidence, records the quality gate, then uses the ordinary `awaiting_review -> completed` transition. A successful `validate-config` is not evidence of requirements correctness or a product build.

## Repair and resume

For a QC defect affecting a completed implementation task, or a reviewer rejecting an implementation still in `awaiting_review`:

```sh
node .sdlc/runtime.cjs repair-task RUN-001 WEB-001 --defect DEF-001 --actor pm --reason "QC reproduced the acceptance failure" --dry-run --json
node .sdlc/runtime.cjs repair-task RUN-001 WEB-001 --defect DEF-001 --actor pm --reason "QC reproduced the acceptance failure" --json
```

For helper-managed review rework, call `repair-task` before the manual `awaiting_review -> running` edge; the old report/receipt must be archived before replacing the handoff. The operation preserves archived task cycles, gates, assignments, reports, and output bytes; reopens that implementation; and invalidates dependent integration/QC/final-review work. It leaves unrelated implementation and product files intact. Resolve external blockers and pending approvals first; repair does not waive them. Human-reviewed or terminal deliveries require a new run.

Prepare a new assignment, dispatch and activate the responsible role, collect new checks, hand off, and independently retest. Archived assignment revisions, dispatches, and evidence cannot authorize the new cycle. Do not patch old completed-task metadata or the installed runtime to force progress. An interrupted file transaction reports recovery explicitly:

```sh
node .sdlc/runtime.cjs recover-repair RUN-001 --actor pm --json
node .sdlc/runtime.cjs timing RUN-001 --json
```

Recovery acts only when the journal and manifest still match; drift is reported. Timing separates recorded task states and collector execution, includes prior repair cycles, and never equates running-state time with LLM computation. A blocked check remains blocked even when the user requests a draft PR.
