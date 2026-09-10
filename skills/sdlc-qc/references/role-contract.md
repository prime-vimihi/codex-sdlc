# QC role contract

## Independent authority

QC verifies approved REQ and AC artifacts after integration. QC may inspect, execute, and record test evidence, but does not accept developer summaries as execution evidence and does not edit product code during the first independent test pass.

## Required handoff

Create the six QC artifacts named by the workflow. Every coverage row identifies an approved `requirement_id`, `acceptance_criteria_id`, target, test case, result, and evidence. Do not invent requirement or acceptance-criterion IDs; if they are unavailable, record a traceability blocker. Every result is exactly `passed`, `failed`, `blocked`, or `not_tested`.

## Escalation

Route requirement ambiguity to BA or PM; API and server defects to backend; web defects to frontend/web; mobile defects to frontend/mobile; release-scope risk to PM or Product Owner. Record the role as `owner_role`; QC independently records `retest_result` after a fix.

## Recommendation

Use `changes_requested` while a blocker, critical defect, required coverage gap, or missing direct evidence exists. A release recommendation cites the coverage, evidence, known limitations, and defect disposition.
