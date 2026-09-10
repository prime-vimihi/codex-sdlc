import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { portablePathContains, portableRepositoryPathKey } from "./paths.js";

import {
  parseStrictYamlDocument,
  reconcileDeliveryAssignmentAuthority,
  type DeliveryAuthorityReconciliationOptions,
  type ArtifactKind,
  type DeliveryArtifactResult,
  type DeliveryAssignment,
  type DeliveryAuthorityIntegrityInputs,
  type DeliveryAuthoritySnapshot,
  type DeliveryReport,
  type DeliveryResultStatus,
} from "./semantic-contracts.js";
import { validateDocument } from "./schemas.js";
import type { ValidationResult } from "./types.js";

export interface DeliveryArtifactIntegrity {
  path: string;
  artifact_kind: ArtifactKind;
  producer: "backend" | "frontend";
  revision: number;
  sha256: string;
  exists: true;
}

export interface StructuredDeliveryStimulus {
  schema_version: 1;
  kind: "structured_delivery_evaluation";
  scenario_id: string;
  assignment: DeliveryAssignment;
  authority_snapshot: DeliveryAuthoritySnapshot;
  authority_integrity: DeliveryAuthorityIntegrityInputs;
  artifact_integrity: DeliveryArtifactIntegrity[];
}

export interface DeliveryReportPackage extends StructuredDeliveryStimulus {
  report: DeliveryReport;
}

type DeliveryBarrier =
  | "terminal_or_inactive"
  | "dependency_or_input"
  | "approval_required"
  | "frontend_contract_or_gap"
  | "unscaffolded_implementation"
  | "eligible";

interface NormativeDeliveryState {
  disposition: DeliveryReport["disposition"];
  from: DeliveryReport["transition_request"]["from"];
  to: DeliveryReport["transition_request"]["to"];
  barrier: DeliveryBarrier;
}

const stimulusKeys = [
  "schema_version",
  "kind",
  "scenario_id",
  "assignment",
  "authority_snapshot",
  "authority_integrity",
  "artifact_integrity",
] as const;

export function parseStructuredDeliveryStimulus(source: string): StructuredDeliveryStimulus {
  const value = parseStrictYamlDocument(source);
  if (!isRecord(value)) throw new Error("structured delivery stimulus must be a YAML object");
  assertExactKeys(value, stimulusKeys, "structured delivery stimulus");
  if (value.schema_version !== 1) throw new Error("structured delivery stimulus schema_version must be 1");
  if (value.kind !== "structured_delivery_evaluation") throw new Error("structured delivery stimulus kind must be structured_delivery_evaluation");
  if (typeof value.scenario_id !== "string" || value.scenario_id.length === 0) throw new Error("structured delivery stimulus scenario_id is required");

  const assignmentValidation = validateDocument("deliveryAssignment", value.assignment);
  if (!assignmentValidation.valid) throw new Error(`invalid delivery assignment: ${assignmentValidation.diagnostics.join("; ")}`);
  const authorityValidation = validateDocument("deliveryAuthoritySnapshot", value.authority_snapshot);
  if (!authorityValidation.valid) throw new Error(`invalid delivery authority snapshot: ${authorityValidation.diagnostics.join("; ")}`);
  assertAuthorityIntegrity(value.authority_integrity);
  assertArtifactIntegrity(value.artifact_integrity);

  const stimulus = value as unknown as StructuredDeliveryStimulus;
  const canonicalAssignmentHash = sha256Canonical(stimulus.assignment);
  if (stimulus.authority_integrity.assignment_sha256 !== canonicalAssignmentHash) {
    throw new Error(`authority_integrity.assignment_sha256 must bind the complete evaluator assignment; expected ${canonicalAssignmentHash}`);
  }
  const reconciliation = reconcileDeliveryAssignmentAuthority(stimulus.assignment, stimulus.authority_snapshot, stimulus.authority_integrity);
  if (!reconciliation.valid) throw new Error(`assignment authority mismatch: ${reconciliation.diagnostics.join("; ")}`);
  return stimulus;
}

export function parseDeliveryReportEnvelope(source: string): DeliveryReport {
  const normalized = source.replaceAll("\r\n", "\n").trim();
  const prefix = "## Delivery report\n```yaml\n";
  const suffix = "\n```";
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) {
    throw new Error("response must contain exactly the Delivery report YAML envelope");
  }
  const yaml = normalized.slice(prefix.length, -suffix.length);
  if (yaml.includes("```") || yaml.includes("\n## ")) {
    throw new Error("response must contain exactly the Delivery report YAML envelope");
  }
  const value = parseStrictYamlDocument(yaml);
  const validation = validateDocument("deliveryReport", value);
  if (!validation.valid) throw new Error(`invalid delivery report: ${validation.diagnostics.join("; ")}`);
  return value as DeliveryReport;
}

export function reconcileDeliveryReportPackage(
  pkg: DeliveryReportPackage,
  options: DeliveryAuthorityReconciliationOptions = {},
): ValidationResult {
  const diagnostics: string[] = [];
  appendSchemaDiagnostics("assignment", validateDocument("deliveryAssignment", pkg.assignment), diagnostics);
  appendSchemaDiagnostics("authority_snapshot", validateDocument("deliveryAuthoritySnapshot", pkg.authority_snapshot), diagnostics);
  appendSchemaDiagnostics("report", validateDocument("deliveryReport", pkg.report), diagnostics);
  diagnostics.push(...reconcileDeliveryAssignmentAuthority(pkg.assignment, pkg.authority_snapshot, pkg.authority_integrity, options).diagnostics);

  compareScalar(pkg.report.assignment_id, pkg.assignment.assignment_id, "assignment_id", diagnostics);
  compareScalar(pkg.report.assignment_revision, pkg.assignment.revision, "assignment_revision", diagnostics);
  compareScalar(pkg.report.revision, pkg.assignment.revision, "revision", diagnostics);
  compareScalar(pkg.report.run_id, pkg.assignment.run_id, "run_id", diagnostics);
  compareScalar(pkg.report.task_id, pkg.assignment.task_id, "task_id", diagnostics);
  compareScalar(pkg.report.role, pkg.assignment.role, "role", diagnostics);
  compareScalar(pkg.report.target, pkg.assignment.target, "target", diagnostics);
  compareScalar(pkg.report.stage, pkg.assignment.stage, "stage", diagnostics);
  compareScalar(pkg.report.scenario, pkg.assignment.scenario, "scenario", diagnostics);

  const expected = normativeDisposition(pkg.assignment, pkg.authority_snapshot, pkg.report, pkg.artifact_integrity, options);
  reconcileArtifacts(pkg.assignment, pkg.report, pkg.artifact_integrity, expected, diagnostics);
  reconcileWrites(pkg.assignment, pkg.authority_snapshot, pkg.report, expected, diagnostics);
  reconcileEvidence(pkg.assignment, pkg.authority_snapshot, pkg.report, expected, diagnostics);
  reconcileObservations(pkg.assignment, pkg.report, expected, diagnostics);
  reconcileResultArtifactBacking(pkg.assignment, pkg.authority_snapshot, pkg.report, pkg.artifact_integrity, diagnostics);

  compareScalar(pkg.report.disposition, expected.disposition, "disposition", diagnostics);
  compareScalar(pkg.report.transition_request.from, expected.from, "transition_request.from", diagnostics);
  compareScalar(pkg.report.transition_request.to, expected.to, "transition_request.to", diagnostics);
  compareScalar(pkg.assignment.transition_policy.current_status, expected.from, "transition_policy.current_status", diagnostics);
  compareScalar(pkg.assignment.transition_policy.allowed_request, expected.to, "transition_policy.allowed_request", diagnostics);
  compareScalar(
    pkg.assignment.transition_policy.unmet_disposition,
    expected.disposition === "proceed" ? "refuse" : expected.disposition,
    "transition_policy.unmet_disposition",
    diagnostics,
  );

  return { valid: diagnostics.length === 0, diagnostics: unique(diagnostics) };
}

function reconcileArtifacts(
  assignment: DeliveryAssignment,
  report: DeliveryReport,
  integrity: DeliveryArtifactIntegrity[],
  expected: NormativeDeliveryState,
  diagnostics: string[],
): void {
  compareKeyed(assignment.required_outputs, report.artifacts, "path", "artifacts", diagnostics);
  compareKeyed(report.artifacts.filter((artifact) => artifact.status === "produced"), integrity, "path", "artifact_integrity", diagnostics);
  for (const output of assignment.required_outputs) {
    const artifact = report.artifacts.find((candidate) => candidate.path === output.path);
    if (artifact === undefined) continue;
    compareScalar(artifact.artifact_kind, output.artifact_kind, `artifacts[${output.path}].artifact_kind`, diagnostics);
    compareScalar(artifact.producer, output.producer, `artifacts[${output.path}].producer`, diagnostics);
    if (output.required && artifact.status === "not_applicable") diagnostics.push(`required artifact ${output.path} cannot be not_applicable`);
    const legalStatuses = expected.barrier === "eligible" ? ["planned", "produced"] : ["planned", "blocked"];
    if (!legalStatuses.includes(artifact.status)) {
      diagnostics.push(`artifact ${artifact.path} status ${artifact.status} is incompatible with ${expected.barrier}`);
    }
    if (artifact.status === "produced") {
      const expected = integrity.find((candidate) => candidate.path === artifact.path);
      if (expected === undefined) continue;
      compareScalar(expected.exists, true, `artifact_integrity[${artifact.path}].exists`, diagnostics);
      compareScalar(artifact.artifact_kind, expected.artifact_kind, `artifact_integrity[${artifact.path}].artifact_kind`, diagnostics);
      compareScalar(artifact.producer, expected.producer, `artifact_integrity[${artifact.path}].producer`, diagnostics);
      compareScalar(artifact.revision, expected.revision, `artifact_integrity[${artifact.path}].revision`, diagnostics);
      compareScalar(artifact.sha256, expected.sha256, `artifact_integrity[${artifact.path}].sha256`, diagnostics);
    }
  }
  if (assignment.scaffold_status === "application_not_scaffolded") {
    for (const artifact of report.artifacts) {
      if (artifact.status === "produced") diagnostics.push(`unscaffolded report cannot produce artifact ${artifact.path}`);
    }
  }
}

function reconcileWrites(
  assignment: DeliveryAssignment,
  authority: DeliveryAuthoritySnapshot,
  report: DeliveryReport,
  expected: NormativeDeliveryState,
  diagnostics: string[],
): void {
  const reportPaths = report.writes.map((write) => write.path);
  compareScalarSets(authority.changed_files.files, reportPaths, "writes", "path", diagnostics);
  for (const write of report.writes) {
    if (!assignment.allowed_write_roots.some((root) => containsPath(root, write.path))) {
      diagnostics.push(`write path ${write.path} is outside allowed roots`);
    }
    if (!isSelectedTargetPath(assignment, write.path)) {
      diagnostics.push(`write path ${write.path} is not owned by target ${assignment.target}`);
    }
  }
  if (expected.barrier !== "eligible" && report.writes.length > 0) {
    diagnostics.push(`writes are incompatible with ${expected.barrier}`);
  }
  for (const artifact of report.artifacts.filter((candidate) => candidate.status === "produced")) {
    const write = report.writes.find((candidate) => candidate.path === artifact.path);
    if (write === undefined) diagnostics.push(`produced artifact ${artifact.path} is missing from writes`);
    else if (write.type !== "artifact") diagnostics.push(`produced artifact ${artifact.path} must use write type artifact`);
  }
  if (assignment.scaffold_status === "application_not_scaffolded") {
    for (const write of report.writes) {
      if (write.type !== "artifact") diagnostics.push(`unscaffolded report cannot include ${write.type} write ${write.path}`);
    }
  }
}

function reconcileEvidence(
  assignment: DeliveryAssignment,
  authority: DeliveryAuthoritySnapshot,
  report: DeliveryReport,
  expected: NormativeDeliveryState,
  diagnostics: string[],
): void {
  compareKeyed(assignment.available_evidence, report.evidence, "evidence_id", "evidence", diagnostics);
  for (const expectedEvidence of authority.evidence_documents) {
    const actual = report.evidence.find((candidate) => candidate.evidence_id === expectedEvidence.evidence_id);
    if (actual === undefined) continue;
    compareScalar(actual.command_key, expectedEvidence.command_key, `evidence[${expectedEvidence.evidence_id}].command_key`, diagnostics);
    compareScalar(actual.owner, expectedEvidence.owner, `evidence[${expectedEvidence.evidence_id}].owner`, diagnostics);
    compareScalar(actual.status, expectedEvidence.status, `evidence[${expectedEvidence.evidence_id}].status`, diagnostics);
    if (actual.status === "passed" || actual.status === "failed") {
      compareScalar(actual.reference, expectedEvidence.reference, `evidence[${expectedEvidence.evidence_id}].reference`, diagnostics);
      compareScalar(actual.document_sha256, expectedEvidence.document_sha256, `evidence[${expectedEvidence.evidence_id}].document_sha256`, diagnostics);
    }
    if (
      expected.barrier !== "eligible"
      && expected.barrier !== "approval_required"
      && (actual.status === "passed" || actual.status === "failed")
    ) {
      diagnostics.push(`evidence ${expectedEvidence.evidence_id} status ${actual.status} is incompatible with ${expected.barrier}`);
    }
  }
}

function reconcileObservations(
  assignment: DeliveryAssignment,
  report: DeliveryReport,
  expected: NormativeDeliveryState,
  diagnostics: string[],
): void {
  if (assignment.role === "backend" && report.role === "backend") {
    compareScalar(report.observations.mode, assignment.controls.mode, "observations.mode", diagnostics);
    if (!isDeepStrictEqual(report.observations.storage, assignment.controls.storage)) diagnostics.push("observations.storage does not match assignment controls");
    if (!isDeepStrictEqual(report.observations.migration, assignment.controls.migration)) diagnostics.push("observations.migration does not match assignment controls");
    reconcileRequirementResults(assignment, assignment.controls.api_requirements, report.observations.requirement_results, expected, diagnostics);
    return;
  }
  if (assignment.role === "frontend" && report.role === "frontend") {
    compareScalar(report.observations.api_contract_status, assignment.controls.api_contract_status, "observations.api_contract_status", diagnostics);
    reconcileControlledCollection(assignment.controls.gaps, report.observations.gaps, "gap_id", "observations.gaps", diagnostics);
    reconcileControlledCollection(assignment.controls.questions, report.observations.questions, "question_id", "observations.questions", diagnostics);
    reconcileRequirementResults(assignment, assignment.controls.requirements, report.observations.requirement_results, expected, diagnostics);
  }
}

function reconcileControlledCollection<T extends object>(
  expected: readonly T[],
  actual: readonly T[],
  key: string,
  path: string,
  diagnostics: string[],
): void {
  compareKeyed(expected, actual, key, path, diagnostics);
  for (const expectedEntry of expected) {
    const expectedRecord = expectedEntry as Record<string, unknown>;
    const semanticKey = expectedRecord[key];
    const actualEntry = actual.find((candidate) => (candidate as Record<string, unknown>)[key] === semanticKey);
    if (actualEntry !== undefined && !isDeepStrictEqual(actualEntry, expectedEntry)) {
      diagnostics.push(`${path}[${String(semanticKey)}] does not match assignment controls`);
    }
  }
}

function reconcileRequirementResults(
  assignment: DeliveryAssignment,
  requirements: ReadonlyArray<{ requirement_id: string; capability: string; required: boolean }>,
  results: ReadonlyArray<{ requirement_id: string; capability: string; required: boolean; status: DeliveryResultStatus }>,
  expected: NormativeDeliveryState,
  diagnostics: string[],
): void {
  compareKeyed(requirements, results, "requirement_id", "observations.requirement_results", diagnostics);
  for (const requirement of requirements) {
    const result = results.find((candidate) => candidate.requirement_id === requirement.requirement_id);
    if (result === undefined) continue;
    compareScalar(result.capability, requirement.capability, `observations.requirement_results.${requirement.requirement_id}.capability`, diagnostics);
    compareScalar(result.required, requirement.required, `observations.requirement_results.${requirement.requirement_id}.required`, diagnostics);
    if (requirement.required && result.status === "not_applicable") diagnostics.push(`required result ${requirement.requirement_id} cannot be not_applicable`);
    const legalStatuses: DeliveryResultStatus[] = expected.barrier !== "eligible"
      ? requirement.required ? ["planned", "blocked"] : ["planned", "blocked", "not_applicable"]
      : assignment.stage === "api_contract"
        ? requirement.required ? ["planned", "documented"] : ["planned", "documented", "not_applicable"]
        : requirement.required ? ["planned", "implemented"] : ["planned", "implemented", "not_applicable"];
    if (!legalStatuses.includes(result.status)) {
      diagnostics.push(`requirement result ${requirement.requirement_id} status ${result.status} is incompatible with ${expected.barrier}`);
    }
  }
}

function reconcileResultArtifactBacking(
  assignment: DeliveryAssignment,
  authority: DeliveryAuthoritySnapshot,
  report: DeliveryReport,
  integrity: DeliveryArtifactIntegrity[],
  diagnostics: string[],
): void {
  const completedStatus: DeliveryResultStatus = assignment.stage === "api_contract" ? "documented" : "implemented";
  const results = report.observations.requirement_results;
  if (!results.some((result) => result.status === completedStatus)) return;

  const unbackedPaths = assignment.required_outputs
    .filter((output) => output.required)
    .filter((output) => {
      const artifact = report.artifacts.find((candidate) => candidate.path === output.path);
      const actual = integrity.find((candidate) => candidate.path === output.path);
      const write = report.writes.find((candidate) => candidate.path === output.path);
      return artifact?.status !== "produced"
        || artifact.artifact_kind !== output.artifact_kind
        || artifact.producer !== output.producer
        || actual?.exists !== true
        || actual.artifact_kind !== output.artifact_kind
        || actual.producer !== output.producer
        || artifact.revision !== actual.revision
        || artifact.sha256 !== actual.sha256
        || write?.type !== "artifact"
        || !authority.changed_files.files.includes(output.path);
    })
    .map((output) => output.path);

  if (unbackedPaths.length > 0) {
    diagnostics.push(
      `${completedStatus} requirement results require produced required artifacts with matching integrity, artifact writes, and changed-file manifest entries: ${unbackedPaths.join(", ")}`,
    );
  }
}

function normativeDisposition(
  assignment: DeliveryAssignment,
  authority: DeliveryAuthoritySnapshot,
  report: DeliveryReport,
  integrity: DeliveryArtifactIntegrity[],
  options: DeliveryAuthorityReconciliationOptions,
): NormativeDeliveryState {
  const status = authority.task.status;
  if (status !== "running") return { disposition: "refuse", from: status, to: null, barrier: "terminal_or_inactive" };

  const unavailable = assignment.dependencies.some((dependency) => dependency.status !== "completed")
    || assignment.required_inputs.some((input) => input.status !== "available");
  if (unavailable) return { disposition: "blocked", from: status, to: "blocked", barrier: "dependency_or_input" };

  if (assignment.role === "backend" && assignment.controls.migration.impact === "destructive") {
    const approval = authority.approval_decisions.find((decision) => decision.decision_id === assignment.controls.migration.decision_id);
    const approved = options.approvalLifecycle === "repository_runtime"
      ? assignment.controls.migration.approval_status === "approved"
      : approval?.status === "approved" && approval.complete && !approval.consumed;
    if (!approved) return { disposition: "awaiting_approval", from: status, to: "awaiting_approval", barrier: "approval_required" };
  }

  if (assignment.role === "frontend") {
    const unresolvedGap = assignment.controls.gaps.some((gap) => gap.state === "unresolved");
    if (assignment.controls.api_contract_status !== "approved" || unresolvedGap) {
      return { disposition: "blocked", from: status, to: "blocked", barrier: "frontend_contract_or_gap" };
    }
  }

  const implementation = assignment.stage !== "api_contract";
  if (implementation && assignment.scaffold_status === "application_not_scaffolded") {
    return { disposition: "blocked", from: status, to: "blocked", barrier: "unscaffolded_implementation" };
  }

  const complete = requiredArtifactsSatisfied(assignment, report, integrity)
    && requiredResultsSatisfied(assignment, report)
    && requiredEvidenceSatisfied(assignment, report);
  return complete
    ? { disposition: "proceed", from: status, to: "awaiting_review", barrier: "eligible" }
    : { disposition: "proceed", from: status, to: null, barrier: "eligible" };
}

function requiredArtifactsSatisfied(assignment: DeliveryAssignment, report: DeliveryReport, integrity: DeliveryArtifactIntegrity[]): boolean {
  return assignment.required_outputs.filter((output) => output.required).every((output) => {
    const artifact = report.artifacts.find((candidate) => candidate.path === output.path);
    const actual = integrity.find((candidate) => candidate.path === output.path);
    return artifact?.status === "produced" && actual?.exists === true && artifact.sha256 === actual.sha256 && artifact.revision === actual.revision;
  });
}

function requiredResultsSatisfied(assignment: DeliveryAssignment, report: DeliveryReport): boolean {
  if (assignment.role !== report.role) return false;
  const requirements = assignment.role === "backend" ? assignment.controls.api_requirements : assignment.controls.requirements;
  const results = report.role === "backend" ? report.observations.requirement_results : report.observations.requirement_results;
  return requirements.filter((requirement) => requirement.required).every((requirement) => {
    const result = results.find((candidate) => candidate.requirement_id === requirement.requirement_id);
    const allowed = assignment.stage === "api_contract" ? ["documented", "implemented"] : ["implemented"];
    return result !== undefined && allowed.includes(result.status);
  });
}

function requiredEvidenceSatisfied(assignment: DeliveryAssignment, report: DeliveryReport): boolean {
  return assignment.evidence_requirements.filter((requirement) => requirement.required).every((requirement) =>
    report.evidence.some((evidence) => evidence.command_key === requirement.command_key && evidence.owner === "runtime_collector" && evidence.status === "passed"));
}

function appendSchemaDiagnostics(label: string, validation: ValidationResult, diagnostics: string[]): void {
  if (!validation.valid) diagnostics.push(...validation.diagnostics.map((diagnostic) => `${label}: ${diagnostic}`));
}

function compareKeyed<TExpected extends object, TActual extends object>(
  expected: readonly TExpected[],
  actual: readonly TActual[],
  key: string,
  path: string,
  diagnostics: string[],
): void {
  const expectedKeys = new Set(expected.map((entry) => String((entry as Record<string, unknown>)[key])));
  const actualKeys = new Set(actual.map((entry) => String((entry as Record<string, unknown>)[key])));
  for (const value of expectedKeys) if (!actualKeys.has(value)) diagnostics.push(`${path} is missing ${key} ${value}`);
  for (const value of actualKeys) if (!expectedKeys.has(value)) diagnostics.push(`${path} has unexpected ${key} ${value}`);
}

function compareScalarSets(expected: readonly string[], actual: readonly string[], path: string, key: string, diagnostics: string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const value of expectedSet) if (!actualSet.has(value)) diagnostics.push(`${path} is missing ${key} ${value}`);
  for (const value of actualSet) if (!expectedSet.has(value)) diagnostics.push(`${path} has unexpected ${key} ${value}`);
}

function containsPath(root: string, path: string): boolean {
  try {
    return portablePathContains(root, path);
  } catch {
    return false;
  }
}

function isSelectedTargetPath(assignment: DeliveryAssignment, path: string): boolean {
  const targetFolder = assignment.target === "backend" ? "backend" : assignment.target;
  let pathKey: string;
  try { pathKey = portableRepositoryPathKey(path); } catch { return false; }
  if (pathKey === "apps" || pathKey.startsWith("apps/")) {
    return assignment.allowed_write_roots.some((root) => {
      let rootKey: string;
      try { rootKey = portableRepositoryPathKey(root); } catch { return false; }
      const segments = rootKey.split("/");
      const application = segments[0] === "apps" ? segments[1] : undefined;
      const ownsTarget = application === targetFolder || application?.endsWith(`-${targetFolder}`) === true;
      return ownsTarget && containsPath(root, path);
    });
  }
  const artifactRoot = `.sdlc/runs/${assignment.run_id}/artifacts`;
  if (containsPath(artifactRoot, path)) return containsPath(`${artifactRoot}/${targetFolder}`, path);
  return true;
}

function assertAuthorityIntegrity(value: unknown): asserts value is DeliveryAuthorityIntegrityInputs {
  if (!isRecord(value)) throw new Error("authority_integrity must be an object");
  assertExactKeys(value, ["assignment_sha256", "run_sha256", "facts_sha256", "required_inputs", "evidence_documents", "changed_files", "approval_decisions"], "authority_integrity");
  for (const key of ["assignment_sha256", "run_sha256", "facts_sha256"] as const) assertHash(value[key], `authority_integrity.${key}`);
  if (!Array.isArray(value.required_inputs) || !Array.isArray(value.evidence_documents) || !Array.isArray(value.approval_decisions) || !isRecord(value.changed_files)) {
    throw new Error("authority_integrity collections are required");
  }
}

function assertArtifactIntegrity(value: unknown): asserts value is DeliveryArtifactIntegrity[] {
  if (!Array.isArray(value)) throw new Error("artifact_integrity must be an array");
  const paths = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new Error(`artifact_integrity[${index}] must be an object`);
    assertExactKeys(item, ["path", "artifact_kind", "producer", "revision", "sha256", "exists"], `artifact_integrity[${index}]`);
    if (typeof item.path !== "string" || paths.has(item.path)) throw new Error(`artifact_integrity[${index}].path must be unique`);
    paths.add(item.path);
    assertHash(item.sha256, `artifact_integrity[${index}].sha256`);
    if (item.exists !== true || !Number.isInteger(item.revision) || Number(item.revision) < 1) throw new Error(`artifact_integrity[${index}] must describe an existing positive revision`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  const missing = expected.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) throw new Error(`${path} keys invalid; missing=${missing.join(",")}; extra=${extra.join(",")}`);
}

function assertHash(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length !== 64 || [...value].some((character) => !"0123456789abcdef".includes(character))) {
    throw new Error(`${path} must be a lowercase SHA-256`);
  }
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareScalar(actual: unknown, expected: unknown, path: string, diagnostics: string[]): void {
  if (actual !== expected) diagnostics.push(`${path} expected ${String(expected)} but received ${String(actual)}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
