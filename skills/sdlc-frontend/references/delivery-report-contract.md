# Structured delivery report contract

Return only `## Delivery report`, then one fenced `yaml` document. Add no other text, document, YAML alias, merge key, duplicate key, or custom tag.

Use this complete closed shape; every shown key is required and no other key is allowed:

````markdown
## Delivery report
```yaml
schema_version: 1
kind: delivery_report
assignment_id: <assignment.assignment_id>
assignment_revision: <assignment.revision>
run_id: <assignment.run_id>
task_id: <assignment.task_id>
producer: frontend
role: frontend
target: <web|mobile>
stage: <web_implementation|mobile_implementation>
scenario: <assignment.scenario>
revision: <assignment.revision>
disposition: <proceed|blocked|awaiting_approval|refuse>
artifacts:
  - path: <required_outputs[].path>
    artifact_kind: <required_outputs[].artifact_kind>
    producer: frontend
    status: <planned|produced|blocked|not_applicable>
    revision: <positive integer or null>
    sha256: <64 lowercase hex characters or null>
writes:
  - path: <authority_snapshot.changed_files.files[] entry>
    type: <source|test|artifact|generated>
evidence:
  - evidence_id: <available_evidence[].evidence_id>
    command_key: <available_evidence[].command_key>
    owner: runtime_collector
    reference: <authority reference or null>
    document_sha256: <authority SHA-256 or null>
    status: <passed|failed|blocked|not_run>
transition_request:
  from: <authority_snapshot.task.status>
  to: <blocked|awaiting_approval|awaiting_review|null>
observations:
  api_contract_status: <assignment.controls.api_contract_status>
  gaps: <exact assignment.controls.gaps array>
  questions: <exact assignment.controls.questions array>
  requirement_results:
    - requirement_id: <assignment.controls.requirements[].requirement_id>
      capability: <assigned target capability>
      required: <assigned required flag>
      status: <planned|implemented|blocked|not_applicable>
```
````

Repeat the artifact, write, evidence, and requirement-result entries once per corresponding typed item. Copy full gap/question objects exactly. Empty collections are `[]`.

## Exact reconciliation rules

- Mirror identity, selected target, stage, scenario, API status, gaps, questions, and keyed collections exactly.
- `artifacts` has exactly one entry per `required_outputs` path. A required entry cannot be `not_applicable`.
- A `produced` artifact copies `revision` and `sha256` from the matching `artifact_integrity` entry. `artifact_integrity` is authoritative; never calculate, invent, or copy these values from prose. A non-produced artifact uses null revision and hash.
- `writes` is exactly `authority_snapshot.changed_files.files`. A produced artifact has an `artifact` write. No prerequisite-barred package may claim writes.
- `evidence` is exactly the collector-owned authority collection. `passed` or `failed` copies its exact reference and SHA-256; `blocked` or `not_run` uses null reference and hash.
- Results preserve requirement ID, selected-target capability, and required flag. Frontend implementation uses `implemented`, never `documented`.

## Normative state table

| First matching authority state | Disposition and transition | Required results | Required artifacts | Writes | Evidence |
|---|---|---|---|---|---|
| Task status is not `running` | `refuse`, current status to null | `planned` or `blocked` | `planned` or `blocked` | none | `blocked` or `not_run` |
| Dependency incomplete or input unavailable | `blocked`, `running` to `blocked` | `planned` or `blocked` | `planned` or `blocked` | none | `blocked` or `not_run` |
| API contract is not approved or any API/design gap is unresolved | `blocked`, `running` to `blocked` | `planned` or `blocked` | `planned` or `blocked` | none | `blocked` or `not_run` |
| Implementation is unscaffolded | `blocked`, `running` to `blocked` | `planned` or `blocked` | `planned` or `blocked` | none | `blocked` or `not_run` |
| Eligible but incomplete | `proceed`, `running` to null | `planned` or `implemented` | `planned` or `produced` | exact manifest | exact collector state |
| Every required artifact/result/evidence is satisfied | `proceed`, `running` to `awaiting_review` | `implemented` | `produced` | exact manifest | required commands `passed` |

`transition_policy.current_status`, `allowed_request` (including null), and `unmet_disposition` must equal this computation. For `proceed`, `unmet_disposition` is `refuse`; otherwise it equals the computed non-proceed disposition. Never request `completed`.
