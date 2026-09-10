# Backend evidence contract

Evidence is runtime-collector owned. Never create, revise, or upgrade collector status.

- Copy only assigned evidence IDs and command keys.
- Use `passed` or `failed` only when the authority document has that status; copy its exact reference and SHA-256.
- Use `blocked` or `not_run` with null reference and hash when execution did not occur.
- Do not infer passing evidence from an implementation summary, artifact text, or assignment claim.

An unscaffolded report contains no produced implementation artifact, source/test/generated write, implemented result, screenshot, or passed build/test evidence.

When dependency/input, inactive/terminal, or unscaffolded authority prevents work, evidence may only be `blocked` or `not_run`. Approval-gated and eligible work still mirrors the collector exactly; approval gating never turns collector evidence into implementation coverage.
