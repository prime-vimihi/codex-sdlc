# Compact seven-artifact example

Input facts for this fictional run include approved `FACT-001 feature.example = true` and unresolved `FACT-002 feature.copy decision_status = unresolved`.

## `artifacts/ba/user-stories.md`

```markdown
---
run_id: "DEMO-001"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---

# User stories

| REQ ID | Actor | Need | Value | Priority |
| --- | --- | --- | --- | --- |
| REQ-001 | A member | Use the example feature. | Receive the approved outcome. | must_have |
```

## `artifacts/ba/acceptance-criteria.md`

```markdown
---
run_id: "DEMO-001"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---

# Acceptance criteria

## AC-001

requirement_id: REQ-001
claim_ids: [CLAIM-001, CLAIM-002]

Given a member uses the feature
When the approved behavior occurs
Then the observable result follows the approved claim and unresolved copy is not invented

evidence_expected: Verify the approved behavior and absence of invented copy.
```

## `artifacts/ba/business-rules.md`

```markdown
---
run_id: "DEMO-001"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---

# Business rules

| Rule ID | Related REQ | Rule | Exception | Owner | Claim IDs |
| --- | --- | --- | --- | --- | --- |
| BR-001 | REQ-001 | The example behavior is enabled. | None approved. | product-owner | CLAIM-001 |
```

## `artifacts/ba/validation-rules.md`

```markdown
---
run_id: "DEMO-001"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---

# Validation rules

| Validation ID | Related REQ | Input | Valid behavior | Invalid behavior | Claim IDs |
| --- | --- | --- | --- | --- | --- |
| VAL-001 | REQ-001 | Example input | Apply the approved behavior. | Do not invent unresolved copy. | CLAIM-001, CLAIM-002 |
```

## `artifacts/ba/edge-cases.md`

```markdown
---
run_id: "DEMO-001"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---

# Edge cases

| Edge ID | Related REQ | Scenario | Expected behavior | Risk | Claim IDs |
| --- | --- | --- | --- | --- | --- |
| EDGE-001 | REQ-001 | Exact copy is needed. | Ask the Product Owner; do not select copy. | Unapproved behavior. | CLAIM-002 |
```

## `artifacts/ba/traceability.md`

```markdown
---
run_id: "DEMO-001"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---

# Traceability matrix

| REQ ID | Acceptance criteria | Claim IDs | Contract | Implementation | Test cases | Defects |
| --- | --- | --- | --- | --- | --- | --- |
| REQ-001 | AC-001 | CLAIM-001, CLAIM-002 | pending | pending | pending | pending |
```

## `artifacts/ba/semantic-claims.yaml`

```yaml
schema_version: 1
run_id: DEMO-001
task_id: BA-001
producer: ba
revision: 1
claims:
  - id: CLAIM-001
    source_fact_id: FACT-001
    subject: feature.example
    relation: equals
    value: true
    status: approved
    requirement_ids: [REQ-001]
    question_ids: []
  - id: CLAIM-002
    source_fact_id: FACT-002
    subject: feature.copy
    relation: decision_status
    value: unresolved
    status: unresolved
    requirement_ids: [REQ-001]
    question_ids: [Q-001]
```

## Assumptions

- ASM-001: No behavior beyond the typed facts is assumed. Impact if false: REQ-001 needs review.

## Open questions for Product Owner

- Q-001: What exact copy is approved?

## Required output paths

- `artifacts/ba/user-stories.md`
- `artifacts/ba/acceptance-criteria.md`
- `artifacts/ba/business-rules.md`
- `artifacts/ba/validation-rules.md`
- `artifacts/ba/edge-cases.md`
- `artifacts/ba/traceability.md`
- `artifacts/ba/semantic-claims.yaml`

## Transition request

- BA-001 `running -> awaiting_review`; PM review required. BA does not approve or complete this task.
