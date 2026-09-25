import { isDeepStrictEqual } from "node:util";

import type { RunManifest, TaskStage } from "./types.js";
import type { BackendControls, FrontendControls } from "./semantic-contracts.js";

export interface CompactAssessment {
  bounded_scope: true;
  existing_patterns: true;
  migrations: false;
  breaking_api: false;
  authorization_changes: false;
  sensitive_data_exposure: false;
  cross_system_uncertainty: false;
  rationale: string;
}

export interface WorkflowProfile {
  name: "compact";
  revision: 1;
  assessment: CompactAssessment;
}

/** Revision 1 is a frozen contract, independent of installed Full workflow edits. */
export const compactOutputs: Readonly<Partial<Record<TaskStage, readonly string[]>>> = Object.freeze({
  intake: Object.freeze(["request.md", "manifest.yaml", "facts.yaml"]),
  requirements: Object.freeze(["artifacts/ba/specification.yaml", "artifacts/ba/semantic-claims.yaml", "artifacts/ba/acceptance-criteria.md"]),
  backend_implementation: Object.freeze(["artifacts/backend/implementation-summary.md", "artifacts/backend/{task_id}-delivery-report.yaml"]),
  web_implementation: Object.freeze(["artifacts/web/implementation-summary.md", "artifacts/web/{task_id}-delivery-report.yaml"]),
  mobile_implementation: Object.freeze(["artifacts/mobile/implementation-summary.md", "artifacts/mobile/{task_id}-delivery-report.yaml"]),
  qc: Object.freeze(["artifacts/qc/verification.yaml", "artifacts/qc/summary.md"]),
  product_owner_advisory: Object.freeze(["artifacts/po/advisory-review.yaml"]),
  product_owner_review: Object.freeze(["final-report.md"]),
});

export function resolveWorkflowProfile(profile?: "compact" | "full", assessment?: CompactAssessment): WorkflowProfile | undefined {
  if (profile === undefined || profile === "full") {
    if (assessment !== undefined) throw new Error("an assessment is valid only with the Compact workflow profile");
    return undefined;
  }
  if (profile !== "compact") throw new Error(`unknown workflow profile: ${String(profile)}`);
  const result = { name: "compact", revision: 1, assessment };
  assertWorkflowProfile(result);
  return structuredClone(result);
}

export function assertWorkflowProfile(value: unknown): asserts value is WorkflowProfile {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "assessment,name,revision" || value.name !== "compact" || value.revision !== 1) throw new Error("unsupported or invalid frozen workflow profile");
  const assessment = value.assessment;
  const required = { bounded_scope: true, existing_patterns: true, migrations: false, breaking_api: false, authorization_changes: false, sensitive_data_exposure: false, cross_system_uncertainty: false };
  if (!isRecord(assessment) || Object.keys(assessment).sort().join(",") !== [...Object.keys(required), "rationale"].sort().join(",")
    || Object.entries(required).some(([key, expected]) => assessment[key] !== expected)
    || typeof assessment.rationale !== "string" || !assessment.rationale.trim()) {
    throw new Error("Compact requires a complete low-risk assessment with bounded scope and existing patterns; uncertain or higher-risk work requires a new Full run");
  }
}

export function isCompactRun(manifest: Pick<RunManifest, "workflow_profile">): boolean { return manifest.workflow_profile?.name === "compact"; }

export function assertCompactDeliveryControls(manifest: RunManifest, controls: BackendControls | FrontendControls<string>): void {
  if (isCompactRun(manifest) && "migration" in controls && controls.migration.impact !== "none") {
    throw new Error("Compact excludes migrations; start a new Full run before changing migration scope");
  }
}

/** Generic manifest writes must not turn a saved run into a different workflow. */
export function assertFrozenWorkflowProfile(previous: RunManifest, next: RunManifest): void {
  if (!isDeepStrictEqual(previous.workflow_profile, next.workflow_profile)) throw new Error("workflow profile is immutable; escalate by starting a new Full run");
  if (previous.compact_review !== undefined && !isDeepStrictEqual(previous.compact_review, next.compact_review)) throw new Error("reviewed Compact specification bindings are immutable; start a new run for changed requirements");
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
