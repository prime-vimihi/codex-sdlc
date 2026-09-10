---
run_id: "[RUN-ID]"
task_id: "[TASK-ID]"
producer: pm
status: pending
revision: 1
---

# Decision DEC-001

decision_id: DEC-001
topic: Describe the decision needing a recorded outcome.
requested_by: pm
approved_by: product-owner
status: pending
decision: Record the approved, rejected, or deferred outcome.
affected_tasks: ["[TASK-ID]"]
action: transition:[TASK-ID]:completed
requested_at: "[ISO-8601]"
decided_at: "[ISO-8601]"
consumed_at: null
consumed_by_transition: null

## Context

Record the options, evidence, and delivery impact.
