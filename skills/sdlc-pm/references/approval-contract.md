# Approval contract

Request and record a Product Owner decision before material scope change, functionality removal/deferral, destructive database work, breaking public API, authentication or authorization model change, sensitive-data handling change, paid/external service, significant design deviation, mobile identifier change, production deployment, or accepting a critical known limitation.

Create the repository record with `approval-request` only after the task is `awaiting_approval`. Bind it to the exact task and intended `running` or `completed` transition. Record the Product Owner outcome with `approval-decision`, then supply the approved decision ID to `transition --decision`. The runtime rejects missing, pending, rejected, unrelated, or incomplete decisions.

An approval record needs `id`, `requested_by`, `approved_by`, `status`, `decision`, `affected_tasks`, `action`, `requested_at`, and `decided_at`; use `DEC-*` IDs. Routine retries, additional automated tests, formatting, documentation correction, and internal non-product-impact choices continue without Product Owner interruption.

Every new request initializes `consumed_at: null` and `consumed_by_transition: null`. A successful approval transition atomically records both fields. A consumed decision is never reusable, including for the same task and target; request a new decision with a new ID for every later approval cycle.

Approval never overrides prohibited production deployment, production credentials, destructive Git/database action, out-of-scope write, protected path, or security/evidence requirement. Ask for the decision and preserve the blocked/awaiting-approval state; do not perform the prohibited action.
