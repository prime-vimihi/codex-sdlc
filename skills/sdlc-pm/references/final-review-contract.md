# Final Product Owner review contract

Before finalization, confirm from the manifest that every mandatory task is completed, every affected quality gate is `passed` with collector evidence, all required outputs exist, Product Owner review/final result remain pending, and no open blocker or blocker/critical defect remains.

Render `final-report.md` from the repository template. The Product Owner package includes delivered scope and REQ coverage, affected applications, commits, command and quality-gate evidence, defects and disposition, known limitations/deferred items with `DEC-*` references, material decisions, and the next Product Owner action.

Then run `node .sdlc/runtime.cjs finalize <run-id> --actor pm`; the command prepares—not completes—the Product Owner review. The Product Owner records the outcome with `node .sdlc/runtime.cjs product-owner-decision <run-id> <decision> --actor product-owner --comments <comments>`. Do not claim product completion unless that operation records `accepted` or `accepted_with_limitations` and the manifest reaches `completed`.

`deferred` is resumable, not terminal: keep the run and current stage at `product_owner_review`, keep Product Owner review and final result ready, retain comments/timestamp/history, and allow a later recorded Product Owner decision. Accepted outcomes complete; changes requested or rejection keep their existing terminal failed result unless a separately approved reopen workflow exists.
