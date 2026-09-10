import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";

import { portableRepositoryPathKey } from "./paths.js";
import type { ValidationResult } from "./types.js";

export type FactRelation = "equals" | "range" | "set" | "permission" | "decision_status";

export type FactStatus = "approved" | "unresolved" | "proposed" | "out_of_scope";

export interface SemanticFact {
  id: `FACT-${string}`;
  subject: string;
  relation: FactRelation;
  value: unknown;
  status: FactStatus;
}

export interface SemanticClaim extends Omit<SemanticFact, "id"> {
  id: `CLAIM-${string}`;
  source_fact_id: `FACT-${string}`;
  requirement_ids: `REQ-${string}`[];
  question_ids: `Q-${string}`[];
}

export type DeliveryRole = "backend" | "frontend";
export type DeliveryTarget = "backend" | "web" | "mobile";
export type DeliveryStage = "api_contract" | "backend_implementation" | "web_implementation" | "mobile_implementation";
export type TaskStatus = "pending" | "ready" | "running" | "awaiting_review" | "awaiting_approval" | "blocked" | "failed" | "completed" | "cancelled";
export type DeliveryScenario =
  | "pending_dependency" | "contract_ready" | "destructive_migration" | "durable_storage" | "unscaffolded_implementation"
  | "api_gap" | "design_gap" | "unscaffolded" | "target_isolation" | "evidence_boundary" | "full_task";
export type ArtifactKind = "technical_design" | "openapi" | "database_impact" | "security_impact" | "implementation_summary" | "delivery_report" | "source" | "test" | "generated" | "screenshot";
export type DeliveryResultStatus = "planned" | "documented" | "implemented" | "blocked" | "not_applicable";
export interface RepositoryPath { repository: string; path: string }
export type PortableDeliveryPath = string | RepositoryPath;

export interface DeliveryDependency { task_id: string; status: TaskStatus }
export interface DeliveryInput {
  path: string;
  status: "available" | "missing" | "blocked";
  producer?: "pm" | "ba" | "backend" | "frontend" | "qc";
  revision?: number;
  exists?: boolean;
  sha256?: string | null;
}
export interface RequiredDeliveryOutput { path: string; artifact_kind: ArtifactKind; producer: DeliveryRole; required: boolean }
export interface CollectorEvidence {
  evidence_id: string;
  command_key: string;
  owner: "runtime_collector";
  reference: string;
  document_sha256: string;
  status: "passed" | "failed" | "blocked" | "not_run";
}
export interface EvidenceRequirement { command_key: string; required: boolean; owner: "runtime_collector" }
export type DeliveryTransitionPolicy =
  | { current_status: "running"; allowed_request: null; unmet_disposition: "refuse" }
  | { current_status: "running"; allowed_request: "blocked"; unmet_disposition: "blocked" }
  | { current_status: "running"; allowed_request: "awaiting_approval"; unmet_disposition: "awaiting_approval" }
  | { current_status: "running"; allowed_request: "awaiting_review"; unmet_disposition: "refuse" }
  | { current_status: Exclude<TaskStatus, "running">; allowed_request: null; unmet_disposition: "refuse" };
export interface StorageControl {
  postgresql_role: "durable_truth";
  redis_roles: Array<"cache" | "ephemeral_presence" | "rate_limit" | "queue" | "pubsub">;
  redis_authoritative: false;
}
export type MigrationControl =
  | { impact: "none" | "additive"; approval_status: "not_required"; decision_id: null }
  | { impact: "destructive"; approval_status: "pending" | "approved" | "rejected"; decision_id: string };
export type BackendCapability = "request" | "response" | "error" | "authentication" | "authorization";
export type WebCapability = string;
export type MobileCapability = string;
type SourceReferenceKind = "fact" | "claim" | "contract";
declare const canonicalSourceReferenceIdBrand: unique symbol;
type CanonicalSourceReferenceId<TKind extends SourceReferenceKind> = string & {
  readonly [canonicalSourceReferenceIdBrand]: TKind;
};
export type FactReferenceId = CanonicalSourceReferenceId<"fact">;
export type ClaimReferenceId = CanonicalSourceReferenceId<"claim">;
export type ContractReferenceId = CanonicalSourceReferenceId<"contract">;
const canonicalSourceReferencePatterns = {
  fact: /^FACT-[0-9]+$/,
  claim: /^CLAIM-[0-9]+$/,
  contract: /^CONTRACT-[0-9]+$/,
} as const satisfies Record<SourceReferenceKind, RegExp>;

export function parseFactReferenceId(value: string): FactReferenceId {
  return parseCanonicalSourceReferenceId("fact", value);
}

export function parseClaimReferenceId(value: string): ClaimReferenceId {
  return parseCanonicalSourceReferenceId("claim", value);
}

export function parseContractReferenceId(value: string): ContractReferenceId {
  return parseCanonicalSourceReferenceId("contract", value);
}

function parseCanonicalSourceReferenceId<TKind extends SourceReferenceKind>(
  kind: TKind,
  value: string,
): CanonicalSourceReferenceId<TKind> {
  const pattern = canonicalSourceReferencePatterns[kind];
  if (!isCanonicalSourceReferenceId(kind, value)) {
    throw new Error(`invalid ${kind} reference ID ${JSON.stringify(value)}; expected ${pattern.source}`);
  }
  return value;
}

function isCanonicalSourceReferenceId<TKind extends SourceReferenceKind>(
  kind: TKind,
  value: string,
): value is CanonicalSourceReferenceId<TKind> {
  return canonicalSourceReferencePatterns[kind].test(value);
}

export type BackendSourceReference =
  | { kind: "fact"; reference: FactReferenceId }
  | { kind: "claim"; reference: ClaimReferenceId }
  | { kind: "contract"; reference: ContractReferenceId };
export type FrontendSourceReference = BackendSourceReference | { kind: "design"; reference: `DESIGN-${string}` };
export interface BackendRequirement<TCapability extends BackendCapability = BackendCapability> {
  requirement_id: string;
  capability: TCapability;
  required: boolean;
  source_references: BackendSourceReference[];
}
export type BackendRequirementInventory = [
  BackendRequirement<"request">,
  BackendRequirement<"response">,
  BackendRequirement<"error">,
  BackendRequirement<"authentication">,
  BackendRequirement<"authorization">,
];
export interface FrontendRequirementParameters {
  breakpoints?: string[];
  minimum_size?: number;
  unit?: "px" | "dp" | "sp" | "percent";
  platforms?: Array<"web" | "android" | "ios">;
  maximum_text_scale?: number;
}
export interface FrontendRequirement<TCapability extends WebCapability | MobileCapability> {
  requirement_id: string;
  capability: TCapability;
  required: boolean;
  parameters: FrontendRequirementParameters;
  source_references: FrontendSourceReference[];
}
interface DeliveryGapBase { gap_id: string; kind: "api" | "design" }
export type DeliveryGap =
  | DeliveryGapBase & { state: "unresolved"; question_ids: string[]; resolution_reference: null }
  | DeliveryGapBase & { state: "approved" | "rejected"; question_ids: []; resolution_reference: string };
export interface DeliveryQuestion { question_id: string; topic: string; status: "open" | "resolved" }
export interface BackendControls {
  mode: "api_contract" | "implementation";
  api_requirements: BackendRequirementInventory;
  storage: StorageControl;
  migration: MigrationControl;
}
export interface FrontendControls<TCapability extends WebCapability | MobileCapability> {
  api_contract_status: "approved" | "missing" | "blocked";
  gaps: DeliveryGap[];
  questions: DeliveryQuestion[];
  requirements: Array<FrontendRequirement<TCapability>>;
}

interface DeliveryAssignmentBase {
  schema_version: 1;
  kind: "delivery_assignment";
  assignment_id: string;
  run_id: string;
  task_id: string;
  repository?: string;
  producer: "pm";
  revision: number;
  facts_revision: number;
  facts_sha256?: string;
  task_status: TaskStatus;
  scaffold_status: "application_not_scaffolded" | "scaffolded";
  dependencies: DeliveryDependency[];
  required_inputs: DeliveryInput[];
  required_outputs: RequiredDeliveryOutput[];
  allowed_write_roots: string[];
  available_evidence: CollectorEvidence[];
  evidence_requirements: EvidenceRequirement[];
  transition_policy: DeliveryTransitionPolicy;
}
type BackendTuple =
  | { role: "backend"; target: "backend"; stage: "api_contract"; scenario: "pending_dependency" | "contract_ready" | "destructive_migration" | "durable_storage" }
  | { role: "backend"; target: "backend"; stage: "backend_implementation"; scenario: "unscaffolded_implementation" | "full_task" };
type WebTuple = { role: "frontend"; target: "web"; stage: "web_implementation"; scenario: "api_gap" | "design_gap" | "unscaffolded" | "target_isolation" | "evidence_boundary" | "full_task" };
type MobileTuple = { role: "frontend"; target: "mobile"; stage: "mobile_implementation"; scenario: "api_gap" | "design_gap" | "unscaffolded" | "target_isolation" | "evidence_boundary" | "full_task" };
export type BackendDeliveryAssignment = DeliveryAssignmentBase & BackendTuple & { controls: BackendControls };
export type WebDeliveryAssignment = DeliveryAssignmentBase & WebTuple & { controls: FrontendControls<WebCapability> };
export type MobileDeliveryAssignment = DeliveryAssignmentBase & MobileTuple & { controls: FrontendControls<MobileCapability> };
export type DeliveryAssignment = BackendDeliveryAssignment | WebDeliveryAssignment | MobileDeliveryAssignment;

interface DeliveryArtifactResultBase {
  path: string;
  artifact_kind: ArtifactKind;
  producer: DeliveryRole;
}
export type DeliveryArtifactResult =
  | DeliveryArtifactResultBase & { status: "produced"; revision: number; sha256: string }
  | DeliveryArtifactResultBase & { status: "planned" | "blocked" | "not_applicable"; revision: null; sha256: null };
export interface DeliveryWrite { path: string; repository?: string; type: "source" | "test" | "artifact" | "generated" }
type DeliveryEvidenceResultBase = Omit<CollectorEvidence, "reference" | "document_sha256" | "status">;
export type DeliveryEvidenceResult =
  | DeliveryEvidenceResultBase & { status: "passed" | "failed"; reference: string; document_sha256: string }
  | DeliveryEvidenceResultBase & { status: "blocked" | "not_run"; reference: null; document_sha256: null };
export interface DeliveryRequirementResult<TCapability extends BackendCapability | WebCapability | MobileCapability> {
  requirement_id: string;
  capability: TCapability;
  required: boolean;
  status: DeliveryResultStatus;
}
export type BackendRequirementResultInventory = [
  DeliveryRequirementResult<"request">,
  DeliveryRequirementResult<"response">,
  DeliveryRequirementResult<"error">,
  DeliveryRequirementResult<"authentication">,
  DeliveryRequirementResult<"authorization">,
];
export interface BackendObservations {
  mode: "api_contract" | "implementation";
  storage: StorageControl;
  migration: MigrationControl;
  requirement_results: BackendRequirementResultInventory;
}
export interface FrontendObservations<TCapability extends WebCapability | MobileCapability> {
  api_contract_status: "approved" | "missing" | "blocked";
  gaps: DeliveryGap[];
  questions: DeliveryQuestion[];
  requirement_results: Array<DeliveryRequirementResult<TCapability>>;
}
interface DeliveryReportEnvelope {
  schema_version: 1;
  kind: "delivery_report";
  assignment_id: string;
  assignment_revision: number;
  run_id: string;
  task_id: string;
  repository?: string;
  revision: number;
  artifacts: DeliveryArtifactResult[];
  writes: DeliveryWrite[];
  evidence: DeliveryEvidenceResult[];
}
type DeliveryDispositionTransition =
  | { disposition: "proceed"; transition_request: { from: "running"; to: "awaiting_review" | null } }
  | { disposition: "blocked"; transition_request: { from: "running"; to: "blocked" } }
  | { disposition: "awaiting_approval"; transition_request: { from: "running"; to: "awaiting_approval" } }
  | { disposition: "refuse"; transition_request: { from: TaskStatus; to: null } };
type DeliveryReportBase = DeliveryReportEnvelope & DeliveryDispositionTransition;
export type BackendDeliveryReport = DeliveryReportBase & BackendTuple & { producer: "backend"; observations: BackendObservations };
export type WebDeliveryReport = DeliveryReportBase & WebTuple & { producer: "frontend"; observations: FrontendObservations<WebCapability> };
export type MobileDeliveryReport = DeliveryReportBase & MobileTuple & { producer: "frontend"; observations: FrontendObservations<MobileCapability> };
export type DeliveryReport = BackendDeliveryReport | WebDeliveryReport | MobileDeliveryReport;

export interface DeliveryAuthoritySnapshot {
  schema_version: 1;
  kind: "delivery_authority_snapshot";
  captured_at: string;
  assignment: { path: string; assignment_id: string; revision: number; sha256: string };
  run: { path: string; run_id: string; sha256: string };
  task: DeliveryAuthorityTask;
  facts: { path: string; producer: "pm"; revision: number; sha256: string };
  required_inputs: DeliveryAuthorityInput[];
  workflow: { required_outputs: RequiredDeliveryOutput[]; permission_roots: string[] };
  evidence_documents: CollectorEvidence[];
  changed_files: DeliveryAuthorityChangedFiles;
  approval_decisions: DeliveryAuthorityApproval[];
}
interface DeliveryAuthorityTaskBase { task_id: string; repository?: string; status: TaskStatus; dependencies: DeliveryDependency[] }
export type DeliveryAuthorityTask =
  | DeliveryAuthorityTaskBase & { role: "backend"; target: "backend"; stage: "api_contract" | "backend_implementation" }
  | DeliveryAuthorityTaskBase & { role: "frontend"; target: "web"; stage: "web_implementation" }
  | DeliveryAuthorityTaskBase & { role: "frontend"; target: "mobile"; stage: "mobile_implementation" };
type DeliveryAuthorityInputBase = { path: string; producer: "pm" | "ba" | "backend" | "frontend" | "qc"; revision: number };
export type DeliveryAuthorityInput =
  | DeliveryAuthorityInputBase & { exists: true; sha256: string }
  | DeliveryAuthorityInputBase & { exists: false; sha256: null };
interface DeliveryAuthorityApprovalBase {
  decision_id: string;
  producer: "product-owner";
  binding: { run_id: string; task_id: string; action: "destructive_migration" | `transition:${string}:running` | `transition:${string}:completed` };
  sha256: string;
}
export type DeliveryAuthorityApproval =
  | DeliveryAuthorityApprovalBase & { status: "pending"; complete: false; approved_by: null; consumed: false; consumed_at: null }
  | DeliveryAuthorityApprovalBase & { status: "approved"; complete: true; approved_by: "product-owner"; consumed: false; consumed_at: null }
  | DeliveryAuthorityApprovalBase & { status: "approved"; complete: true; approved_by: "product-owner"; consumed: true; consumed_at: string }
  | DeliveryAuthorityApprovalBase & { status: "rejected"; complete: true; approved_by: "product-owner"; consumed: false; consumed_at: null };
export interface DeliveryAuthorityChangedFiles { path: string; sha256: string; files: PortableDeliveryPath[] }
export interface DeliveryAuthorityIntegrityInputs {
  assignment_sha256: string;
  run_sha256: string;
  facts_sha256: string;
  required_inputs: DeliveryAuthorityInput[];
  evidence_documents: CollectorEvidence[];
  changed_files: DeliveryAuthorityChangedFiles;
  approval_decisions: DeliveryAuthorityApproval[];
}
export interface DeliveryAuthorityResolutionRequest { repository_root: string; assignment_path: string }
export interface DeliveryAuthoritySnapshotResolver {
  resolve(request: DeliveryAuthorityResolutionRequest): Promise<DeliveryAuthoritySnapshot>;
}
export interface DeliveryAuthorityReconciliationOptions {
  approvalLifecycle?: "assignment_snapshot" | "repository_runtime";
}

/**
 * Reconciles a schema-valid PM assignment with a schema-valid frozen authority
 * snapshot. Hashes and authority-owned collections are supplied independently
 * from the snapshot so callers must bind claims to bytes loaded from disk.
 */
export function reconcileDeliveryAssignmentAuthority(
  assignment: DeliveryAssignment,
  authority: DeliveryAuthoritySnapshot,
  integrity: DeliveryAuthorityIntegrityInputs,
  options: DeliveryAuthorityReconciliationOptions = {},
): ValidationResult {
  const diagnostics: string[] = [];
  const canonicalRunRoot = `.sdlc/runs/${assignment.run_id}`;

  compareScalar(authority.assignment.path, `${canonicalRunRoot}/tasks/${assignment.task_id}.assignment.yaml`, "assignment.path", diagnostics);
  compareScalar(authority.assignment.assignment_id, assignment.assignment_id, "assignment.assignment_id", diagnostics);
  compareScalar(authority.assignment.revision, assignment.revision, "assignment.revision", diagnostics);
  compareScalar(authority.assignment.sha256, integrity.assignment_sha256, "assignment.sha256", diagnostics);

  compareScalar(authority.run.path, `${canonicalRunRoot}/manifest.yaml`, "run.path", diagnostics);
  compareScalar(authority.run.run_id, assignment.run_id, "run.run_id", diagnostics);
  compareScalar(authority.run.sha256, integrity.run_sha256, "run.sha256", diagnostics);

  compareScalar(authority.task.task_id, assignment.task_id, "task.task_id", diagnostics);
  compareScalar(authority.task.role, assignment.role, "task.role", diagnostics);
  compareScalar(authority.task.target, assignment.target, "task.target", diagnostics);
  compareScalar(authority.task.stage, assignment.stage, "task.stage", diagnostics);
  compareScalar(authority.task.repository, assignment.repository, "task.repository", diagnostics);
  compareScalar(authority.task.status, assignment.task_status, "task.status", diagnostics);
  compareKeyedRecords(
    authority.task.dependencies,
    assignment.dependencies,
    "task_id",
    "task.dependencies",
    ["status"],
    diagnostics,
  );

  compareScalar(authority.facts.path, `${canonicalRunRoot}/facts.yaml`, "facts.path", diagnostics);
  compareScalar(authority.facts.producer, "pm", "facts.producer", diagnostics);
  compareScalar(authority.facts.revision, assignment.facts_revision, "facts.revision", diagnostics);
  if (assignment.facts_sha256 !== undefined) compareScalar(authority.facts.sha256, assignment.facts_sha256, "facts.sha256", diagnostics);
  compareScalar(authority.facts.sha256, integrity.facts_sha256, "facts.sha256", diagnostics);

  compareKeyedRecords(authority.required_inputs, assignment.required_inputs, "path", "required_inputs", [], diagnostics);
  for (const input of assignment.required_inputs) {
    const resolved = authority.required_inputs.find((candidate) => candidate.path === input.path);
    if (resolved === undefined) continue;
    compareScalar(resolved.exists, input.status === "available", `required_inputs[${input.path}].exists`, diagnostics);
    if (input.producer !== undefined) compareScalar(resolved.producer, input.producer, `required_inputs[${input.path}].producer`, diagnostics);
    if (input.revision !== undefined) compareScalar(resolved.revision, input.revision, `required_inputs[${input.path}].revision`, diagnostics);
    if (input.exists !== undefined) compareScalar(resolved.exists, input.exists, `required_inputs[${input.path}].exists`, diagnostics);
    if (input.sha256 !== undefined) compareScalar(resolved.sha256, input.sha256, `required_inputs[${input.path}].sha256`, diagnostics);
  }
  compareKeyedRecords(
    authority.required_inputs,
    integrity.required_inputs,
    "path",
    "required_inputs",
    ["producer", "revision", "exists", "sha256"],
    diagnostics,
  );

  compareKeyedRecords(
    authority.workflow.required_outputs,
    assignment.required_outputs,
    "path",
    "workflow.required_outputs",
    ["artifact_kind", "producer", "required"],
    diagnostics,
  );
  compareScalarSets(
    authority.workflow.permission_roots.map(normalizeRepositoryPath),
    assignment.allowed_write_roots.map(normalizeRepositoryPath),
    "workflow.permission_roots",
    diagnostics,
  );

  compareKeyedRecords(
    authority.evidence_documents,
    assignment.available_evidence,
    "evidence_id",
    "evidence_documents",
    ["command_key", "owner", "reference", "document_sha256", "status"],
    diagnostics,
  );
  compareKeyedRecords(
    authority.evidence_documents,
    integrity.evidence_documents,
    "evidence_id",
    "evidence_documents",
    ["command_key", "owner", "reference", "document_sha256", "status"],
    diagnostics,
  );
  compareScalar(authority.changed_files.path, integrity.changed_files.path, "changed_files.path", diagnostics);
  compareScalar(authority.changed_files.sha256, integrity.changed_files.sha256, "changed_files.sha256", diagnostics);
  compareScalarSets(authority.changed_files.files, integrity.changed_files.files, "changed_files.files", diagnostics);

  compareKeyedRecords(
    authority.approval_decisions,
    integrity.approval_decisions,
    "decision_id",
    "approval_decisions",
    ["producer", "status", "complete", "approved_by", "consumed", "consumed_at", "sha256"],
    diagnostics,
  );
  for (const expected of integrity.approval_decisions) {
    const actual = authority.approval_decisions.find((candidate) => candidate.decision_id === expected.decision_id);
    if (actual === undefined) continue;
    compareScalar(actual.binding.run_id, expected.binding.run_id, `approval_decisions[${expected.decision_id}].binding.run_id`, diagnostics);
    compareScalar(actual.binding.task_id, expected.binding.task_id, `approval_decisions[${expected.decision_id}].binding.task_id`, diagnostics);
    compareScalar(actual.binding.action, expected.binding.action, `approval_decisions[${expected.decision_id}].binding.action`, diagnostics);
  }
  reconcileMigrationApproval(assignment, authority, diagnostics, options);

  return { valid: diagnostics.length === 0, diagnostics };
}

function reconcileMigrationApproval(
  assignment: DeliveryAssignment,
  authority: DeliveryAuthoritySnapshot,
  diagnostics: string[],
  options: DeliveryAuthorityReconciliationOptions,
): void {
  if (assignment.role !== "backend" || assignment.controls.migration.impact !== "destructive") return;
  const migration = assignment.controls.migration;
  const approval = authority.approval_decisions.find((candidate) => candidate.decision_id === migration.decision_id);
  if (approval === undefined) {
    if (options.approvalLifecycle !== "repository_runtime" || migration.approval_status !== "pending") {
      diagnostics.push(`approval_decisions is missing destructive migration decision ${migration.decision_id}`);
    }
    return;
  }
  if (options.approvalLifecycle !== "repository_runtime"
    || migration.approval_status !== "pending"
    || !(["pending", "approved", "rejected"] as const).includes(approval.status)) {
    compareScalar(approval.status, migration.approval_status, `approval_decisions[${migration.decision_id}].status`, diagnostics);
  }
  compareScalar(approval.binding.run_id, assignment.run_id, `approval_decisions[${migration.decision_id}].binding.run_id`, diagnostics);
  compareScalar(approval.binding.task_id, assignment.task_id, `approval_decisions[${migration.decision_id}].binding.task_id`, diagnostics);
  const canonicalAction = `transition:${assignment.task_id}:running`;
  if (approval.binding.action !== canonicalAction && approval.binding.action !== "destructive_migration") {
    diagnostics.push(`approval_decisions[${migration.decision_id}].binding.action expected ${canonicalAction} but received ${approval.binding.action}`);
  }
  if (approval.consumed && options.approvalLifecycle !== "repository_runtime") {
    diagnostics.push(`approval_decisions[${migration.decision_id}].consumed must be false before execution`);
  }
}

function compareKeyedRecords<TActual extends object, TExpected extends object>(
  actual: readonly TActual[],
  expected: readonly TExpected[],
  key: string,
  path: string,
  fields: readonly string[],
  diagnostics: string[],
): void {
  const actualByKey = new Map(actual.map((entry) => [String((entry as Record<string, unknown>)[key]), entry]));
  const expectedByKey = new Map(expected.map((entry) => [String((entry as Record<string, unknown>)[key]), entry]));
  for (const expectedKey of expectedByKey.keys()) {
    if (!actualByKey.has(expectedKey)) diagnostics.push(`${path} is missing key ${expectedKey}`);
  }
  for (const actualKey of actualByKey.keys()) {
    if (!expectedByKey.has(actualKey)) diagnostics.push(`${path} has unexpected key ${actualKey}`);
  }
  for (const [expectedKey, expectedEntry] of expectedByKey.entries()) {
    const actualEntry = actualByKey.get(expectedKey);
    if (actualEntry === undefined) continue;
    for (const field of fields) {
      compareScalar(
        (actualEntry as Record<string, unknown>)[field],
        (expectedEntry as Record<string, unknown>)[field],
        `${path}[${expectedKey}].${field}`,
        diagnostics,
      );
    }
  }
}

function compareScalarSets(actual: readonly unknown[], expected: readonly unknown[], path: string, diagnostics: string[]): void {
  const actualSet = new Set(actual.map(semanticIdentity));
  const expectedSet = new Set(expected.map(semanticIdentity));
  for (const value of expectedSet) {
    if (!actualSet.has(value)) diagnostics.push(`${path} is missing value ${value}`);
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) diagnostics.push(`${path} has unexpected value ${value}`);
  }
}

function compareScalar(actual: unknown, expected: unknown, path: string, diagnostics: string[]): void {
  if (actual !== expected) diagnostics.push(`${path} expected ${String(expected)} but received ${String(actual)}`);
}

function normalizeRepositoryPath(path: PortableDeliveryPath): string {
  try {
    return repositoryPathIdentity(path);
  } catch {
    // Schema diagnostics own malformed-input reporting; preserve a distinct
    // comparison identity so reconciliation remains total and cannot accept it.
    return `invalid:${JSON.stringify(path)}`;
  }
}

export function repositoryPathIdentity(value: PortableDeliveryPath): string {
  return typeof value === "string"
    ? portableRepositoryPathKey(value)
    : `${value.repository}::${portableRepositoryPathKey(value.path)}`;
}

function semanticIdentity(value: unknown): string {
  if (typeof value === "string") return portableRepositoryPathKey(value);
  if (value !== null && typeof value === "object" && "repository" in value && "path" in value
    && typeof value.repository === "string" && typeof value.path === "string") {
    return repositoryPathIdentity(value as RepositoryPath);
  }
  return JSON.stringify(value);
}

export function parseStrictYamlDocument(source: string): unknown {
  const documents = parseAllDocuments(source, { uniqueKeys: true, merge: false });
  if (documents.length !== 1) throw new Error(`expected exactly one YAML document, received ${documents.length}`);
  const document = documents[0];
  const diagnostics = [...document.errors, ...document.warnings].map((entry) => entry.message);
  if (diagnostics.length > 0) throw new Error(`invalid strict YAML: ${diagnostics.join("; ")}`);
  if (document.contents === null) throw new Error("strict YAML document must not be empty");
  assertNoYamlIndirection(document.contents);
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

/** Reads the revision authority used by YAML/Markdown delivery artifacts. */
export function structuredDocumentRevision(value: unknown, path: string): number | undefined {
  if (!isRecordValue(value)) return undefined;
  const metadata = value["x-sdlc-metadata"];
  const candidate = path.endsWith("openapi.yaml") && isRecordValue(metadata)
    ? metadata.revision
    : value.revision;
  return Number.isInteger(candidate) && Number(candidate) >= 1 ? Number(candidate) : undefined;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoYamlIndirection(node: unknown): void {
  if (isAlias(node)) throw new Error("YAML aliases are not allowed");
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === "<<") throw new Error("YAML merge keys are not allowed");
      assertNoYamlIndirection(pair.key);
      assertNoYamlIndirection(pair.value);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) assertNoYamlIndirection(item);
  }
}
