# QC test contract

## Status values

| Result | Meaning |
| --- | --- |
| `passed` | QC executed the check and attached direct evidence of the expected result. |
| `failed` | QC executed or observed a reproducible mismatch and opened a defect. |
| `blocked` | A prerequisite or environment prevents execution; state impact, owner, and unblock condition. |
| `not_tested` | The case has not been executed; state the reason and needed evidence. |

Developer summaries are context, not execution evidence. Direct evidence names the command or observable action, environment/target, timestamp, outcome, and durable path or artifact.

## Minimum coverage

For each in-scope REQ and AC, define a positive case and applicable negative, boundary, permission, API, web, mobile, and regression cases. Record an explicit result and evidence reference for every planned case, including unavailable work. Do not change product code to make a first-pass result pass.
