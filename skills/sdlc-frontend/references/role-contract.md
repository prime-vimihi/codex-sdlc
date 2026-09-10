# Frontend role contract

## Required inputs

Use the complete visible `structured_delivery_evaluation`, including `assignment`, `authority_snapshot`, `authority_integrity`, and `artifact_integrity`. Confirm assignment identity, revision, run/task, selected target, stage, dependency states, input availability, facts revision, scaffold state, permission roots, API status, gaps, questions, collector evidence, changed-file manifest, and produced-artifact integrity.

Do not read a repository schema or template. The complete output shape is in `delivery-report-contract.md`; literal web and mobile responses are in `../examples/`.

## Ownership

- Produce frontend artifacts and the selected web or mobile delivery report only.
- Preserve every required-output path, artifact kind, producer, and required flag.
- Mirror API-contract status, gaps, and questions exactly; do not resolve or approve them.
- Include every target-specific requirement exactly once with its capability and required flag.
- Do not include paths, capabilities, or outputs owned by the other frontend target.

Use `implemented` only for completed target behavior. A dependency/input, missing or blocked API contract, unresolved API/design gap, unscaffolded, inactive, terminal, blocked, awaiting-approval, or refuse state permits only `planned` or `blocked`; it never permits `implemented` or `documented`. A required result is never `not_applicable`.
