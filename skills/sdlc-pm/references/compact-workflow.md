# Opt-in Compact workflow

Use Compact only for a new, bounded feature using established implementation and authorization patterns. Full remains the default. A saved run's profile and reviewed requirements cannot be changed in place. Workflow selection is independent of `--save-my-token` and `--normal`, which continue to configure role models.

## Eligibility and start

Resolve the selected application and preflight its commands, services, and acceptance fixtures. Assess scope from the request and repository; do not fill false risk flags merely to select a shorter workflow. Unknown scope, migrations, breaking APIs, authorization changes, new sensitive-data exposure, or substantial cross-system uncertainty require Full. An additive endpoint can qualify when it follows established permissions and does not break an existing contract.

`$sdlc --compact <feature request>` routes to this workflow. `/sdlc` remains chat shorthand rather than a registered native slash command. Without `--compact`, start Full. A bare Compact request without a feature does not create a run or change project defaults.

Save a strict JSON assessment inside the coordinator, for example `.sdlc/requests/change-assessment.json`:

```json
{
  "bounded_scope": true,
  "existing_patterns": true,
  "migrations": false,
  "breaking_api": false,
  "authorization_changes": false,
  "sensitive_data_exposure": false,
  "cross_system_uncertainty": false,
  "rationale": "A bounded change using existing application, permission, and data patterns."
}
```

Every value is an assessment to establish, not a default to assume. Start only after confirming the example applies:

```sh
node .sdlc/runtime.cjs start --id CHANGE-001 --title "Requested change" --request .sdlc/requests/change.md --applications web --profile compact --assessment .sdlc/requests/change-assessment.json --json
```

The runtime freezes Compact revision 1 and the assessment into this run. Missing or higher-risk assessments fail without creating a run. If new information makes Compact unsuitable, preserve this history and start a new Full run with the original request, new findings, and references to reusable work; never remove gates or rewrite the saved profile to force progress.

## Graph and ownership

`PM-001 → BA-001 → affected BE-002 / WEB-001 / MOB-001 → QC-001 → optional PO-001 → PM-004 → human decision`.

PM records request facts and reviews the BA handoff directly; separate PM requirements/API-review tasks and a separate backend contract task are omitted. The reviewed specification contains the applicable API change. QC independently verifies the integrated result, so both integration and QC gates remain required, even though a separate INT-001 task is omitted. Implementation still uses the existing target boundaries and sequential scheduling. Only PM completes tasks; roles cannot approve their own completion.

## One BA specification

PM-001 produces approved `facts.yaml`; request and manifest are created by the runtime. Resolve open facts before Compact specification review. BA-001 supplies the following semantic input to `compact-spec`, using actual fact/requirement IDs:

```json
{
  "scope": {
    "summary": "Update the existing status display",
    "in_scope": ["Existing status output"],
    "out_of_scope": ["New permissions, data collection, and API contracts"]
  },
  "requirements": [{"id":"REQ-001","description":"Show the approved status","fact_ids":["FACT-001"]}],
  "acceptance_criteria": [{"id":"AC-001","requirement_id":"REQ-001","given":"The existing feature","when":"The status is read","then":"The approved status is returned","evidence_types":["command"]}],
  "api_change": {"kind":"unchanged","description":"The existing API shape is preserved"}
}
```

```sh
node .sdlc/runtime.cjs compact-spec CHANGE-001 --json < specification-input.json
```

BA must be running. The helper writes `artifacts/ba/specification.yaml` and derives `semantic-claims.yaml` and `acceptance-criteria.md` from approved facts. Do not separately author seven Full-mode documents or manually edit generated views. Every requirement needs acceptance criteria and factual support; unresolved/proposed facts, missing references, duplicate IDs, and unsupported API changes are rejected.

Select required evidence types up front: `command`, `api`, `ui`, `live_database`, or `observation`. A UI fixture cannot replace required database evidence. Do not downgrade evidence after discovering an unavailable environment.

BA requests `awaiting_review`. PM reviews scope, facts, acceptance tests, API assumptions, and eligibility, then records:

```sh
node .sdlc/runtime.cjs quality-gate CHANGE-001 requirements passed --actor pm --reason "Reviewed specification and applicable API behavior" --evidence artifacts/ba/specification.yaml
node .sdlc/runtime.cjs transition CHANGE-001 BA-001 completed --actor pm --reason "Specification approved for implementation"
```

The review binds exact specification/fact/generated-view hashes. Later edits invalidate the review rather than silently changing approved scope. A dummy configuration command is not a substitute for this review.

## Implementation

Use [runtime-assisted delivery](task-operations.md): prepare the affected assignments from reviewed controls, launch actual role agents, record activation, collect checks, and hand off. Compact does not alter model selection, file ownership, evidence freshness, or reviewer approval. Backend controls with migration impact are rejected even if the original assessment claimed none. Keep unresolved gaps blocked.

## One independent QC record

QC-001 integrates the delivered work and executes its own checks while running. Use `check-task` with actual configured command IDs. Record direct observations under `artifacts/qc/evidence/` as YAML with matching run/task/producer, positive revision, evidence type, observation time, environment, procedure, actual result, and passed/failed status. The full shape is `CompactObservation` in the runtime; recorded commands are referenced directly through their canonical evidence JSON paths.

Supply one result per acceptance criterion to `compact-qc`:

```json
{
  "results": [{"ac_id":"AC-001","status":"passed","evidence":[{"type":"command","reference":"evidence/commands/EVD-0123456789abcdef/evidence.json"}],"notes":"Independent execution confirmed the approved behavior."}],
  "defects": []
}
```

The reference above is illustrative; use only evidence returned by actual execution. Allowed result statuses are `passed`, `failed`, `blocked`, and `not_tested`. Defects declare their ID, affected `ac_ids`, open/resolved status, severity, and summary. The runtime derives readiness, hashes, and `artifacts/qc/summary.md`; do not claim readiness yourself or author six Full-mode QC documents.

```sh
node .sdlc/runtime.cjs compact-qc CHANGE-001 --json < qc-input.json
```

Both authoring helpers support `--dry-run` and `--expected-version`. Publishing does not pass a gate or complete a task. Readiness requires every AC to pass with every declared evidence type, all latest QC checks to pass, and no open defects. Developer evidence, superseded command results, future timestamps, missing observations, and request/spec/self citations cannot satisfy independent QC.

Once ready, QC hands off to `awaiting_review`; PM reviews the integrated result and records both integration and QC gates using current passed QC collector references, then completes QC. Optional AI PO advice and final human acceptance follow the existing flow. `finalize` only prepares the human review.

## Rework

For product changes, use `repair-task` on the affected implementation. It preserves the profile and reviewed specification, archives prior implementation/QC artifacts, and invalidates both integration and QC gates. Collect fresh evidence and rebuild the QC record after repair.

Extra QC checks are refused before execution after handoff or gate approval. For a still-uncompleted QC review, return QC to running and reset both integration/QC gates to pending before collecting more evidence; republish verification afterward. Do not run checks and review transitions concurrently. Completed deliveries require the existing repair/new-run rules. A failed or blocked result remains explicit; elapsed time never authorizes skipping it.
