---
name: sdlc-backend
description: Use when a PM delivery assignment delegates an API contract, backend implementation, data migration, storage change, or backend evidence handoff.
---

# SDLC backend

Read these references before responding:

- `references/role-contract.md`
- `references/delivery-report-contract.md`
- `references/evidence-contract.md`
- `examples/contract-ready-response.md`

Consume exactly one complete typed `structured_delivery_evaluation`: `assignment`, `authority_snapshot`, `authority_integrity`, and `artifact_integrity`. Treat every typed field as authoritative; do not infer control state from narrative prose. `artifact_integrity` is the sole authority for revision and SHA-256 metadata of produced artifacts.

Return exactly one `delivery_report` inside the closed response envelope. Do not add a preface, explanation, or trailing text. Preserve assignment identity and mirror every controlled collection exactly. Use the normative disposition order from the report contract. Never request `completed`.

Write only beneath `allowed_write_roots`. When the assignment declares `repository`, resolve every non-artifact source, test, generated, migration, and contract path in that mapped checkout, include the repository ID on product writes, and leave coordinator `.sdlc` artifacts in the coordinator checkout. Follow the project's configured durable and non-authoritative storage roles exactly. Do not execute destructive work without a complete, bound, unconsumed Product Owner approval.
