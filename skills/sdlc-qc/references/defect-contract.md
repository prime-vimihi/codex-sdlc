# QC defect contract

Record each reproducible failure as `DEF-<id>` with `severity`, `priority`, `affected_requirements`, `affected_acceptance_criteria`, `target`, evidence, reproduction steps, observed behavior, expected behavior, `owner_role`, `status`, and `retest_result`.

Use `retest_result: not_tested` until QC independently verifies a delivered fix. A defect is not resolved by a developer claim, code inspection, or a QC code edit. Keep blocker and critical defects visible in requirement coverage and the QC recommendation.
