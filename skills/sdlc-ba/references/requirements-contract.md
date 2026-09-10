# Requirements contract

## Exact response envelope

Return no preface or trailing prose. Use exactly these level-two sections in order:

1. `## \`artifacts/ba/user-stories.md\``
2. `## \`artifacts/ba/acceptance-criteria.md\``
3. `## \`artifacts/ba/business-rules.md\``
4. `## \`artifacts/ba/validation-rules.md\``
5. `## \`artifacts/ba/edge-cases.md\``
6. `## \`artifacts/ba/traceability.md\``
7. `## \`artifacts/ba/semantic-claims.yaml\``
8. `## Assumptions`
9. `## Open questions for Product Owner`
10. `## Required output paths`
11. `## Transition request`

Fence each Markdown artifact as `markdown` and the claims artifact as `yaml`. Start each Markdown document with exactly:

```yaml
---
run_id: "[RUN-ID]"
task_id: "BA-001"
producer: ba
status: draft
revision: 1
---
```

## Typed fact and claim truth

Read the full production-shaped fact package. For every fact whose status is `approved` or `unresolved`, create exactly one claim:

```yaml
schema_version: 1
run_id: "[RUN-ID]"
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
```

Copy `subject`, `relation`, `value`, and `status` structurally; preserve object fields, range boundaries/unit/inclusivity, permission fields, and sorted set order. A claim cites one existing fact. Use stable three-digit IDs. An approved claim has `question_ids: []`; an unresolved claim keeps `value: unresolved`, `status: unresolved`, and cites at least one exact `Q-*` handoff entry. Do not promote `proposed` or `unresolved` facts.

## Exact Markdown contracts

| Artifact | Exact contract |
| --- | --- |
| `user-stories.md` | `REQ ID`, `Actor`, `Need`, `Value`, `Priority`; use `REQ-*`. |
| `acceptance-criteria.md` | One `## AC-*` per criterion, `requirement_id: REQ-*`, `claim_ids: [CLAIM-*]`, separate Given/When/Then lines, and `evidence_expected`. |
| `business-rules.md` | `Rule ID`, `Related REQ`, `Rule`, `Exception`, `Owner`, `Claim IDs`; use `BR-*`. |
| `validation-rules.md` | `Validation ID`, `Related REQ`, `Input`, `Valid behavior`, `Invalid behavior`, `Claim IDs`; use `VAL-*`. |
| `edge-cases.md` | `Edge ID`, `Related REQ`, `Scenario`, `Expected behavior`, `Risk`, `Claim IDs`; use `EDGE-*`. |
| `traceability.md` | `REQ ID`, `Acceptance criteria`, `Claim IDs`, `Contract`, `Implementation`, `Test cases`, `Defects`. |

Each claim referenced by an acceptance criterion or row must contain that entry's `REQ-*` in `requirement_ids`. Each traceability row must list exactly the acceptance criteria and claims linked to that requirement. Each claim must be linked by every requirement it names.

## Material ambiguity

Keep unspecified material behavior unresolved. Use stable entries:

```text
## Assumptions

- ASM-001: [provisional context only]. Impact if false: [affected requirements].

## Open questions for Product Owner

- Q-001: [decision required].
```

Do not encode an unresolved choice as a final, proposed, provisional, or temporary rule. Waiting implementation is not approval.

## Exact footer

```text
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
```
