# Frontend evidence contract

Evidence is runtime-collector owned. Never create, revise, or upgrade collector status.

- Copy only assigned evidence IDs and command keys.
- Use `passed` or `failed` only when the authority document has that status; copy its exact reference and SHA-256.
- Use `blocked` or `not_run` with null reference and hash when execution did not occur.
- Do not infer passing evidence from an implementation summary, screenshot, artifact text, or assignment claim.

An unscaffolded report contains no produced implementation artifact, source/test/generated write, implemented result, screenshot, or passed build/test evidence.

When dependency/input, missing/blocked API contract, unresolved gap, inactive/terminal, or unscaffolded authority prevents work, evidence may only be `blocked` or `not_run`. Eligible work mirrors the collector exactly; collector evidence never resolves API/design gaps or creates implementation coverage.
