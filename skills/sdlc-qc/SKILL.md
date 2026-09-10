---
name: sdlc-qc
description: Use when an integrated feature needs independent acceptance, API, web, mobile, negative, permission, regression, defect, retest, coverage, or release-readiness verification.
---

# SDLC Quality Assurance

For a multi-repository workspace, resolve each application, command, and changed-file entry through its declared repository ID in `.sdlc/project.yaml` and `.sdlc/local.yaml`. Treat a missing, mismatched, duplicate, or nested checkout mapping as a blocked verification environment; never infer that identical relative paths refer to the same repository.

Independently verify approved requirements. Developer summaries are context, not execution evidence; a result is only passed when QC has direct, reproducible evidence.

## First independent pass

1. Read [role-contract.md](references/role-contract.md) and [test-contract.md](references/test-contract.md). Map every approved REQ and AC to a test case before execution; record a missing identifier as a traceability blocker, never invent one.
2. Execute or observe the available API, web, mobile, negative, boundary, permission, and regression checks. Attach direct evidence for each result.
3. Record every result using only `passed`, `failed`, `blocked`, or `not_tested`. Do not collapse unavailable work into silence or a pass.
4. Open and route defects using [defect-contract.md](references/defect-contract.md). Do not edit product code during the first independent test pass.
5. Retest a fix independently. Recommend release only from coverage, direct evidence, and resolved defect disposition.

## Evidence and recommendation

Treat a verbal "all tests passed" claim as unverified until the command, target environment, timestamp, result, and durable evidence reference are available. If an environment or prerequisite is unavailable, record the test as `blocked` or `not_tested`, include the reason and owner, and preserve its coverage gap.

Use the repository QC templates for `test-plan.md`, `test-cases.md`, `execution-results.md`, `requirement-coverage.md`, `defects.md`, and `qc-recommendation.md`. Keep `changes_requested` when a blocker, critical defect, missing required coverage, or missing execution evidence remains.

## Quick check

| Situation | Required action |
| --- | --- |
| Developer summary only | Record `not_tested`; request reproducible evidence. |
| Mobile environment unavailable | Record `blocked` with impact; do not omit mobile coverage. |
| Defect observed | Record `failed`, route its owner role, and require independent retest. |
| Asked to repair code | Preserve QC independence; send the defect to the responsible role. |

Never manufacture a passed result, evidence reference, completion claim, or release recommendation.
