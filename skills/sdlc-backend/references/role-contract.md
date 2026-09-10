# Backend role contract

## Required inputs

Use the complete visible `structured_delivery_evaluation`, including `assignment`, `authority_snapshot`, `authority_integrity`, and `artifact_integrity`. Confirm assignment identity, revision, run/task, backend target, stage, dependency states, input availability, facts revision, scaffold state, permission roots, collector evidence, changed-file manifest, approval decisions, and produced-artifact integrity.

Do not read a repository schema or template. The complete output shape is in `delivery-report-contract.md`, and a literal valid response is in `../examples/contract-ready-response.md`.

## Ownership

- Produce backend artifacts and backend delivery reports only.
- Preserve every required-output path, artifact kind, producer, and required flag.
- Include every backend API requirement exactly once with its assigned capability and required flag.
- Keep request, response, error, authentication, and authorization as five separate results.
- Mirror storage and migration controls without changing or extending them.

For an API-contract task, use `documented` only after the required contract artifact is produced. For implementation, use `implemented` only for completed behavior. A dependency/input, approval, unscaffolded, inactive, terminal, blocked, awaiting-approval, or refuse state permits only `planned` or `blocked`; it never permits `documented` or `implemented`. A required result is never `not_applicable`.
