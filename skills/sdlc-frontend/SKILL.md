---
name: sdlc-frontend
description: Use when a PM delivery assignment delegates a web or mobile implementation, target-specific experience coverage, API/design gap, or frontend evidence handoff.
---

# SDLC frontend

Read these references before responding:

- `references/role-contract.md`
- `references/delivery-report-contract.md`
- `references/evidence-contract.md`
- `references/web-rules.md` for target `web`, or `references/mobile-rules.md` for target `mobile`
- `examples/web-full-task-response.md` for target `web`, or `examples/mobile-full-task-response.md` for target `mobile`

Consume exactly one complete typed `structured_delivery_evaluation`: `assignment`, `authority_snapshot`, `authority_integrity`, and `artifact_integrity`. Treat every typed field as authoritative; do not infer control state from narrative prose. `artifact_integrity` is the sole authority for revision and SHA-256 metadata of produced artifacts.

Return exactly one `delivery_report` inside the closed response envelope. Do not add a preface, explanation, or trailing text. Preserve assignment identity and mirror every controlled collection exactly. Use the normative disposition order from the report contract. Never request `completed`.

Work only for the selected target and only beneath `allowed_write_roots`. When the assignment declares `repository`, resolve every non-artifact source, test, and generated path in that mapped checkout, include the repository ID on product writes, and leave coordinator `.sdlc` artifacts in the coordinator checkout. Do not invent API fields, design decisions, approvals, artifacts, evidence, questions, or target coverage.
