## Delivery report
```yaml
schema_version: 1
kind: delivery_report
assignment_id: ASN-101
assignment_revision: 1
run_id: PROFILE-001
task_id: BE-001
producer: backend
role: backend
target: backend
stage: api_contract
scenario: contract_ready
revision: 1
disposition: proceed
artifacts:
  - path: .sdlc/runs/PROFILE-001/artifacts/backend/technical-design.md
    artifact_kind: technical_design
    producer: backend
    status: produced
    revision: 1
    sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
writes:
  - path: .sdlc/runs/PROFILE-001/artifacts/backend/technical-design.md
    type: artifact
evidence:
  - evidence_id: EVD-aaaaaaaaaaaaaaaa
    command_key: sdlc_validate
    owner: runtime_collector
    reference: evidence/commands/EVD-aaaaaaaaaaaaaaaa/evidence.json
    document_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    status: passed
transition_request:
  from: running
  to: awaiting_review
observations:
  mode: api_contract
  storage:
    postgresql_role: durable_truth
    redis_roles:
      - cache
      - ephemeral_presence
    redis_authoritative: false
  migration:
    impact: none
    approval_status: not_required
    decision_id: null
  requirement_results:
    - requirement_id: REQ-001
      capability: request
      required: true
      status: documented
    - requirement_id: REQ-002
      capability: response
      required: true
      status: documented
    - requirement_id: REQ-003
      capability: error
      required: true
      status: documented
    - requirement_id: REQ-004
      capability: authentication
      required: true
      status: documented
    - requirement_id: REQ-005
      capability: authorization
      required: true
      status: documented
```
