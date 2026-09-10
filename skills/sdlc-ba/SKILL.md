---
name: sdlc-ba
description: Use when an active SDLC run needs feature requirements, typed fact-to-claim reconciliation, user stories, acceptance criteria, business rules, validation, edge cases, assumptions, open questions, or traceability.
---

# SDLC Business Analysis

Create reviewable requirements from the run's typed facts; Product Owner and PM approval remain separate decisions.

1. Read the active run manifest, assigned BA task, immutable request, PM intake artifacts including `facts.yaml`, `.sdlc/project.yaml`, applicable `AGENTS.md`, policies, workflow, and templates. If project documentation is configured in another repository, resolve `resources.documentation` through `.sdlc/local.yaml`; cite it as source material while keeping authoritative BA run artifacts in the coordinator repository.
2. Read [role contract](references/role-contract.md), [requirements contract](references/requirements-contract.md), and [output example](references/output-example.md).
3. Render the seven required BA outputs as separate file-shaped sections in this order: the six Markdown templates, then `artifacts/ba/semantic-claims.yaml`. Give every Markdown artifact its own exact metadata block.
4. Treat `facts.yaml` as the deterministic input truth. Mirror every `approved` or `unresolved` `FACT-*` exactly once as a `CLAIM-*` with the same `source_fact_id`, subject, relation, typed value, and status. Never infer an approved claim from prose, promote an unresolved/proposed fact, cite a missing fact, or create a second claim for one fact.
5. Link claims through the human-readable package: acceptance criteria use `claim_ids`; business-rule, validation-rule, and edge-case rows use `Claim IDs`; traceability maps each requirement to both acceptance criteria and the same claims. A referenced claim must include that row's `REQ-*` in `requirement_ids`.
6. Use stable `REQ-*`, `AC-*`, `BR-*`, `VAL-*`, `EDGE-*`, `CLAIM-*`, `ASM-*`, and `Q-*` IDs. Unresolved claims cite their exact Product Owner `Q-*` entries; approved claims have no question IDs.
7. End with exactly `## Assumptions`, `## Open questions for Product Owner`, `## Required output paths`, and `## Transition request`. List all seven canonical paths and request only `BA-001 running -> awaiting_review` with PM review. Never request or claim `completed`.

Structured claims are authoritative when explanatory prose conflicts with them. Report any prose defect for correction; never alter a claim to match unsupported prose.

Never modify product code, the manifest, facts, policy, schema, workflow, template, or approval state. Never self-approve requirements.

## Red flags — stop and repair

- Fewer or more than seven artifact sections, a preface, or trailing prose
- Missing, duplicate, invented, promoted, or structurally changed fact claim
- Rule-bearing entry without a compatible claim and traceability link
- Unresolved claim without a Product Owner question
- Combined artifact, renamed template column, unstable ID, or malformed YAML
- Any transition other than the PM-review `awaiting_review` handoff
