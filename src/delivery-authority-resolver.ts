import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  parseStrictYamlDocument,
  reconcileDeliveryAssignmentAuthority,
  structuredDocumentRevision,
  type ArtifactKind,
  type CollectorEvidence,
  type DeliveryArtifactResult,
  type DeliveryAssignment,
  type DeliveryAuthorityApproval,
  type DeliveryAuthorityChangedFiles,
  type DeliveryAuthorityInput,
  type DeliveryAuthorityIntegrityInputs,
  type DeliveryAuthoritySnapshot,
  type DeliveryAuthoritySnapshotResolver,
  type DeliveryReport,
  type RequiredDeliveryOutput,
} from "./semantic-contracts.js";
import {
  reconcileDeliveryReportPackage,
  type DeliveryArtifactIntegrity,
  type DeliveryReportPackage,
} from "./delivery-report-reconciliation.js";
import { readEvidenceReference } from "./evidence-validation.js";
import { changedFilesForTask, validateChangedFilesAuthorityDocument } from "./changed-files-authority.js";
import {
  isPortableRepositoryPath,
  resolvePathInsideRoot,
} from "./paths.js";
import { loadProject } from "./config.js";
import { repositoryForApplication } from "./workspace.js";
import { validateDocument } from "./schemas.js";
import {
  acquireRunAuthorityLock,
  assertHeldRunAuthorityLock,
  releaseRunAuthorityLock,
  type HeldRunAuthorityLock,
  type RunAuthorityLockOptions,
} from "./run-authority-lock.js";
import type { EvidenceRecord, ProjectConfig, RunManifest, SdlcDecision, Task, TaskRole, ValidationResult } from "./types.js";

const assignmentPathPattern = /^\.sdlc\/runs\/([A-Z][A-Z0-9]*-[0-9]+)\/tasks\/([A-Z][A-Z0-9]*-[0-9]+)\.assignment\.yaml$/;
const changedFilesPath = "evidence/diffs/changed-files.json";

export interface ResolvedDeliveryAuthority {
  assignment: DeliveryAssignment;
  authoritySnapshot: DeliveryAuthoritySnapshot;
  authorityIntegrity: DeliveryAuthorityIntegrityInputs;
}

export interface ResolvedDeliveryReportPackage extends ResolvedDeliveryAuthority {
  report: DeliveryReport;
  artifactIntegrity: DeliveryArtifactIntegrity[];
}

export interface RepositoryRunSnapshot {
  manifest: RunManifest;
  manifestSource: string;
}

/** Builds the production delivery authority snapshot exclusively from repository-owned bytes. */
export class RepositoryDeliveryAuthoritySnapshotResolver implements DeliveryAuthoritySnapshotResolver {
  public async resolve(request: { repository_root: string; assignment_path: string }): Promise<DeliveryAuthoritySnapshot> {
    return (await resolveRepositoryDeliveryAuthority(request.repository_root, request.assignment_path)).authoritySnapshot;
  }
}

export async function resolveRepositoryDeliveryAuthority(
  root: string,
  assignmentPath: string,
  options: RunAuthorityLockOptions = {},
): Promise<ResolvedDeliveryAuthority> {
  const normalizedAssignmentPath = normalizeRepositoryPath(assignmentPath);
  const match = assignmentPathPattern.exec(normalizedAssignmentPath);
  if (match === null) throw new Error(`delivery assignment path is not canonical: ${assignmentPath}`);
  const [, runId] = match;
  const lock = await acquireRunAuthorityLock(root, runId, options);
  try {
    return await resolveRepositoryDeliveryAuthorityUnderLock(root, normalizedAssignmentPath, lock);
  } finally {
    await releaseRunAuthorityLock(lock);
  }
}

async function resolveRepositoryDeliveryAuthorityUnderLock(
  root: string,
  assignmentPath: string,
  lock: HeldRunAuthorityLock,
  snapshot?: RepositoryRunSnapshot,
): Promise<ResolvedDeliveryAuthority> {
  const normalizedAssignmentPath = normalizeRepositoryPath(assignmentPath);
  const match = assignmentPathPattern.exec(normalizedAssignmentPath);
  if (match === null) throw new Error(`delivery assignment path is not canonical: ${assignmentPath}`);
  const [, runId, taskId] = match;
  await assertHeldRunAuthorityLock(lock, root, runId);

  const assignmentSource = await readRepositoryFile(root, normalizedAssignmentPath);
  const assignmentValue = parseStrictYamlDocument(assignmentSource);
  assertSchema("deliveryAssignment", assignmentValue, `${taskId} delivery assignment`);
  const assignment = assignmentValue as DeliveryAssignment;
  assertRepositoryAssignmentBindings(assignment);

  const manifestPath = `.sdlc/runs/${runId}/manifest.yaml`;
  const manifestSource = snapshot?.manifestSource ?? await readRepositoryFile(root, manifestPath);
  const manifestValue = parseStrictYamlDocument(manifestSource);
  if (snapshot !== undefined && JSON.stringify(manifestValue) !== JSON.stringify(snapshot.manifest)) {
    throw new Error(`${runId} run snapshot manifest does not match its captured bytes`);
  }
  assertSchema("run", manifestValue, `${runId} run manifest`);
  const manifest = manifestValue as RunManifest;
  if (manifest.run.id !== runId) throw new Error(`delivery assignment path run ${runId} does not match manifest run ${manifest.run.id}`);
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error(`delivery assignment task ${taskId} does not exist in run ${runId}`);
  assertDeliveryTask(task);

  const factsPath = `.sdlc/runs/${runId}/facts.yaml`;
  const factsSource = await readRepositoryFile(root, factsPath);
  const factsValue = parseStrictYamlDocument(factsSource);
  assertSchema("facts", factsValue, `${runId} facts`);
  const facts = factsValue as { run_id: string; producer: string; revision: number };
  if (facts.run_id !== runId || facts.producer !== "pm") throw new Error(`${runId} facts identity does not match active run`);

  const project = await loadProject(root);
  const taskRepository = repositoryForTask(project, task);
  if (project.workspace?.mode === "multi-repository" && assignment.repository !== taskRepository) {
    throw new Error(`${task.id} delivery assignment repository must be ${taskRepository}`);
  }
  assertConfiguredEvidenceRequirements(assignment, project);
  const requiredInputs = await resolveRequiredInputs(root, runId, task);
  const evidenceDocuments = await resolveEvidenceDocuments(root, runId, manifest, task, assignment, project);
  const approvalDecisions = resolveApprovalDecisions(manifest, task);
  assertRepositoryApprovalLifecycle(assignment, manifest, task);
  const requiredOutputs = workflowOutputs(runId, task);
  const permissionRoots = await resolvePermissionRoots(root, runId, task, project, assignment);
  const changedFiles = await resolveChangedFiles(root, runId, manifest, task, project, requiredOutputs.map((output) => output.path));
  const assignmentHash = sha256(assignmentSource);
  const runHash = sha256(manifestSource);
  const factsHash = sha256(factsSource);

  const authoritySnapshot: DeliveryAuthoritySnapshot = {
    schema_version: 1,
    kind: "delivery_authority_snapshot",
    captured_at: manifest.run.updated_at ?? manifest.run.created_at ?? "1970-01-01T00:00:00.000Z",
    assignment: {
      path: normalizedAssignmentPath,
      assignment_id: assignment.assignment_id,
      revision: assignment.revision,
      sha256: assignmentHash,
    },
    run: { path: manifestPath, run_id: runId, sha256: runHash },
    task: {
      task_id: task.id,
      role: task.role,
      target: task.target,
      stage: task.stage,
      ...(project.workspace?.mode === "multi-repository" ? { repository: taskRepository } : {}),
      status: assignment.task_status,
      dependencies: task.dependencies.map((dependencyId) => ({
        task_id: dependencyId,
        status: manifest.tasks.find((candidate) => candidate.id === dependencyId)?.status ?? "pending",
      })),
    } as DeliveryAuthoritySnapshot["task"],
    facts: { path: factsPath, producer: "pm", revision: facts.revision, sha256: factsHash },
    required_inputs: requiredInputs,
    workflow: { required_outputs: requiredOutputs, permission_roots: permissionRoots },
    evidence_documents: evidenceDocuments,
    changed_files: changedFiles,
    approval_decisions: approvalDecisions,
  };
  assertSchema("deliveryAuthoritySnapshot", authoritySnapshot, `${taskId} delivery authority snapshot`);

  const authorityIntegrity: DeliveryAuthorityIntegrityInputs = {
    assignment_sha256: assignmentHash,
    run_sha256: runHash,
    facts_sha256: factsHash,
    required_inputs: structuredClone(requiredInputs),
    evidence_documents: structuredClone(evidenceDocuments),
    changed_files: structuredClone(changedFiles),
    approval_decisions: structuredClone(approvalDecisions),
  };
  const reconciliation = reconcileDeliveryAssignmentAuthority(assignment, authoritySnapshot, authorityIntegrity, { approvalLifecycle: "repository_runtime" });
  if (!reconciliation.valid) throw new Error(`${taskId} delivery assignment authority mismatch: ${reconciliation.diagnostics.join("; ")}`);

  return { assignment, authoritySnapshot, authorityIntegrity };
}

export async function resolveRepositoryDeliveryReportPackage(
  root: string,
  assignmentPath: string,
  options: RunAuthorityLockOptions = {},
): Promise<ResolvedDeliveryReportPackage> {
  const normalizedAssignmentPath = normalizeRepositoryPath(assignmentPath);
  const match = assignmentPathPattern.exec(normalizedAssignmentPath);
  if (match === null) throw new Error(`delivery assignment path is not canonical: ${assignmentPath}`);
  const lock = await acquireRunAuthorityLock(root, match[1], options);
  try {
    const authority = await resolveRepositoryDeliveryAuthorityUnderLock(root, normalizedAssignmentPath, lock);
    return await resolveRepositoryDeliveryReportPackageUnderLock(root, normalizedAssignmentPath, lock, authority);
  } finally {
    await releaseRunAuthorityLock(lock);
  }
}

async function resolveRepositoryDeliveryReportPackageUnderLock(
  root: string,
  assignmentPath: string,
  lock: HeldRunAuthorityLock,
  resolvedAuthority?: ResolvedDeliveryAuthority,
): Promise<ResolvedDeliveryReportPackage> {
  const match = assignmentPathPattern.exec(normalizeRepositoryPath(assignmentPath));
  if (match === null) throw new Error(`delivery assignment path is not canonical: ${assignmentPath}`);
  await assertHeldRunAuthorityLock(lock, root, match[1]);
  const authority = resolvedAuthority ?? await resolveRepositoryDeliveryAuthorityUnderLock(root, assignmentPath, lock);
  const reportPath = canonicalReportPath(authority.assignment);
  const reportSource = await readRepositoryFile(root, reportPath);
  const reportValue = parseStrictYamlDocument(reportSource);
  assertSchema("deliveryReport", reportValue, `${authority.assignment.task_id} delivery report`);
  const report = reportValue as DeliveryReport;
  const artifactIntegrity = await resolveArtifactIntegrity(root, report);
  return { ...authority, report, artifactIntegrity };
}

/** Validates all activated delivery assignments/reports present in one active run. */
export async function validateRepositoryStructuredDelivery(
  root: string,
  runId: string,
  snapshot: RepositoryRunSnapshot,
  lock: HeldRunAuthorityLock,
): Promise<ValidationResult> {
  await assertHeldRunAuthorityLock(lock, root, runId);
  const { manifest } = snapshot;
  const diagnostics: string[] = [];
  for (const task of manifest.tasks.filter(isDeliveryTask)) {
    const assignmentPath = `.sdlc/runs/${runId}/tasks/${task.id}.assignment.yaml`;
    const reportPath = canonicalTaskReportPath(runId, task);
    const assignmentExists = await repositoryFileExists(root, assignmentPath);
    const reportExists = await repositoryFileExists(root, reportPath);
    const assignmentRequired = task.status === "running" || task.status === "awaiting_review" || task.status === "completed";
    const reportRequired = task.status === "awaiting_review" || task.status === "completed";
    if (!assignmentExists && !reportExists) {
      if (assignmentRequired) diagnostics.push(`${task.id} is ${task.status} but its canonical delivery assignment is missing`);
      if (reportRequired) diagnostics.push(`${task.id} is ${task.status} but its canonical delivery report is missing`);
      if (reportRequired) diagnostics.push(...(await missingRequiredOutputDiagnostics(root, runId, task)));
      continue;
    }
    if (!assignmentExists) {
      diagnostics.push(`${task.id} delivery report exists without its canonical delivery assignment`);
      continue;
    }
    try {
      const authority = await resolveRepositoryDeliveryAuthorityUnderLock(root, assignmentPath, lock, snapshot);
      diagnostics.push(...assignmentStateDiagnostics(task, authority.assignment));
      if (reportExists) {
        const reportPackage = await resolveRepositoryDeliveryReportPackageUnderLock(root, assignmentPath, lock, authority);
        const pkg: DeliveryReportPackage = {
          schema_version: 1,
          kind: "structured_delivery_evaluation",
          scenario_id: `repository-${runId}-${task.id}`,
          assignment: reportPackage.assignment,
          authority_snapshot: reportPackage.authoritySnapshot,
          authority_integrity: reportPackage.authorityIntegrity,
          artifact_integrity: reportPackage.artifactIntegrity,
          report: reportPackage.report,
        };
        const reconciliation = reconcileDeliveryReportPackage(pkg, { approvalLifecycle: "repository_runtime" });
        diagnostics.push(...reconciliation.diagnostics.map((entry) => `${task.id} delivery report: ${entry}`));
        diagnostics.push(...deliveryStateDiagnostics(task, reportPackage.report));
      } else if (reportRequired) {
        diagnostics.push(`${task.id} is ${task.status} but its canonical delivery report is missing`);
      }
      if (reportRequired) diagnostics.push(...(await missingRequiredOutputDiagnostics(root, runId, task)));
    } catch (error) {
      diagnostics.push(errorMessage(error));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics: [...new Set(diagnostics)] };
}

async function resolveRequiredInputs(root: string, runId: string, task: Task): Promise<DeliveryAuthorityInput[]> {
  const ownAssignment = `tasks/${task.id}.assignment.yaml`;
  return Promise.all(task.required_inputs.filter((path) => path !== ownAssignment).map(async (runPath) => {
    const repositoryPath = `.sdlc/runs/${runId}/${runPath}`;
    const exists = await repositoryFileExists(root, repositoryPath);
    const base = { path: repositoryPath, producer: producerForRunPath(runPath), revision: 1 } as const;
    if (!exists) return { ...base, exists: false, sha256: null } as DeliveryAuthorityInput;
    const source = await readRepositoryFile(root, repositoryPath);
    return { ...base, revision: documentRevision(source, repositoryPath), exists: true, sha256: sha256(source) } as DeliveryAuthorityInput;
  }));
}

async function resolveEvidenceDocuments(
  root: string,
  runId: string,
  manifest: RunManifest,
  task: Task,
  assignment: DeliveryAssignment,
  project: ProjectConfig,
): Promise<CollectorEvidence[]> {
  return Promise.all(assignment.available_evidence.map(async ({ reference }) => {
    if (!task.evidence.includes(reference)) throw new Error(`${task.id} delivery assignment evidence is not recorded by the task: ${reference}`);
    const { record, source } = await readEvidenceReference({ root, runId, manifest, reference, project, owner: task.role, expectedTask: task, expectedStage: task.stage });
    return evidenceAuthority(record, reference, source);
  }));
}

function evidenceAuthority(record: EvidenceRecord, reference: string, source: string): CollectorEvidence {
  return {
    evidence_id: record.id,
    command_key: record.command_id,
    owner: "runtime_collector",
    reference,
    document_sha256: sha256(source),
    status: record.result_status,
  };
}

async function resolveChangedFiles(
  root: string,
  runId: string,
  manifest: RunManifest,
  task: Task,
  project: ProjectConfig,
  taskOutputPaths: readonly string[],
): Promise<DeliveryAuthorityChangedFiles> {
  const repositoryPath = `.sdlc/runs/${runId}/${changedFilesPath}`;
  if (!(await repositoryFileExists(root, repositoryPath))) {
    return { path: changedFilesPath, sha256: sha256(JSON.stringify({ files: [] })), files: [] };
  }
  const source = await readRepositoryFile(root, repositoryPath);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`changed-files manifest is invalid JSON: ${errorMessage(error)}`);
  }
  const document = await validateChangedFilesAuthorityDocument(root, value, manifest, project);
  const files = changedFilesForTask(document, task, project, taskOutputPaths);
  return { path: changedFilesPath, sha256: sha256(source), files };
}

async function resolvePermissionRoots(
  root: string,
  runId: string,
  task: Task,
  project: ProjectConfig,
  assignment: DeliveryAssignment,
): Promise<string[]> {
  const source = await readRepositoryFile(root, ".sdlc/policies/permissions.yaml");
  const value = parseStrictYamlDocument(source);
  if (!isRecord(value) || !isRecord(value.roles) || !isRecord(value.roles[task.role])) {
    throw new Error(`permissions policy is missing role ${task.role}`);
  }
  const rolePolicy = value.roles[task.role];
  const paths = rolePolicy.write_paths;
  if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string")) {
    throw new Error(`permissions policy write paths are invalid for role ${task.role}`);
  }
  const requestedRoots = new Set(assignment.allowed_write_roots);
  const legacyRoots = paths
    .map((path) => normalizePermissionPolicyRoot(path, runId))
    .filter((path) => project.workspace?.mode !== "multi-repository" || path.startsWith(".sdlc/"))
    .filter((path) => isTargetPermissionRoot(task, path, project, runId))
    .filter((path) => !isSharedContractRoot(path, project) || requestedRoots.has(path));
  const locations: unknown[] = Array.isArray(rolePolicy.write_locations) ? rolePolicy.write_locations : [];
  const repository = repositoryForTask(project, task);
  const locationRoots: string[] = locations.flatMap((location: unknown) => isRecord(location)
    && location.repository === repository && typeof location.path === "string"
    ? [normalizePermissionPolicyRoot(location.path, runId)] : [])
    .filter((path: string) => isTargetPermissionRoot(task, path, project, runId));
  return [...new Set([...legacyRoots, ...locationRoots])];
}

export function normalizePermissionPolicyRoot(path: string, runId: string): string {
  return path === "**"
    ? "."
    : path.replace(".sdlc/runs/*/", `.sdlc/runs/${runId}/`).replace(/\/\*\*$/u, "");
}

function assertConfiguredEvidenceRequirements(assignment: DeliveryAssignment, project: ProjectConfig): void {
  for (const requirement of assignment.evidence_requirements) {
    if (!(requirement.command_key in project.commands)) {
      throw new Error(`${assignment.task_id} delivery assignment requires unconfigured command ${requirement.command_key}`);
    }
  }
}

function isSharedContractRoot(path: string, project: ProjectConfig): boolean {
  const configured = project.resources?.api_contracts?.root;
  return configured === undefined
    ? path === "packages/api-contracts/openapi.yaml" || path === "packages/api-contracts/generated"
    : path === configured;
}

function resolveApprovalDecisions(manifest: RunManifest, task: Task): DeliveryAuthorityApproval[] {
  return (manifest.decisions ?? [])
    .filter((decision) => (
      decision.action === "destructive_migration"
      || decision.action === `transition:${task.id}:running`
      || decision.action === `transition:${task.id}:completed`
    ) && decision.affected_tasks.includes(task.id))
    .map((decision) => approvalAuthority(manifest.run.id, task.id, decision));
}

function assertRepositoryApprovalLifecycle(assignment: DeliveryAssignment, manifest: RunManifest, task: Task): void {
  if (assignment.role !== "backend" || assignment.controls.migration.impact !== "destructive") return;
  const migration = assignment.controls.migration;
  const decision = manifest.decisions?.find((candidate) => candidate.id === migration.decision_id);
  const resumeTransitions = task.transitions.filter((transition) => transition.from === "awaiting_approval" && (transition.to === "running" || transition.to === "completed"));
  for (const transition of resumeTransitions) {
    const consumption = `${task.id}:awaiting_approval->${transition.to}`;
    const consumedDecision = manifest.decisions?.find((candidate) => candidate.status === "approved"
      && candidate.affected_tasks.includes(task.id)
      && candidate.action === `transition:${task.id}:${transition.to}`
      && candidate.consumed_at === transition.at
      && candidate.consumed_by_transition === consumption);
    if (consumedDecision === undefined) {
      throw new Error(`${task.id} approval transition ${consumption} has no exact consumed decision authority`);
    }
  }
  if (decision === undefined) {
    if (migration.approval_status !== "pending" || (resumeTransitions.length > 0 && assignment.revision <= 1)) {
      throw new Error(`${task.id} destructive migration decision ${migration.decision_id} is missing from its approval lifecycle`);
    }
    if (task.status !== "running" && task.status !== "awaiting_approval") {
      throw new Error(`${task.id} cannot await a not-yet-requested destructive decision from ${task.status}`);
    }
    return;
  }
  const canonicalAction = `transition:${task.id}:running`;
  if (decision.action !== canonicalAction || !decision.affected_tasks.includes(task.id)) {
    throw new Error(`${task.id} destructive migration decision ${decision.id} is not bound to ${canonicalAction}`);
  }
  if (decision.status === "pending") {
    if (task.status !== "awaiting_approval" || decision.consumed_at !== null || decision.consumed_by_transition !== null) {
      throw new Error(`${task.id} pending destructive migration decision ${decision.id} is outside its awaiting_approval lifecycle`);
    }
    return;
  }
  if (decision.status === "rejected") {
    if (task.status !== "awaiting_approval" || decision.consumed_at !== null || decision.consumed_by_transition !== null) {
      throw new Error(`${task.id} rejected destructive migration decision ${decision.id} is outside its awaiting_approval lifecycle`);
    }
    return;
  }
  if (decision.status !== "approved" || decision.approved_by !== "product-owner" || decision.decision === null || decision.decided_at === null) {
    throw new Error(`${task.id} destructive migration decision ${decision.id} is not a complete Product Owner decision`);
  }
  if (decision.consumed_at === null || decision.consumed_by_transition === null) {
    if (task.status !== "awaiting_approval") throw new Error(`${task.id} unconsumed destructive migration decision ${decision.id} requires awaiting_approval`);
    return;
  }
  const expectedConsumption = `${task.id}:awaiting_approval->running`;
  if (decision.consumed_by_transition !== expectedConsumption) {
    throw new Error(`${task.id} destructive migration decision ${decision.id} has invalid consumption binding ${decision.consumed_by_transition}`);
  }
  const consumedTransition = resumeTransitions.find((transition) => transition.to === "running" && transition.at === decision.consumed_at);
  if (consumedTransition === undefined) {
    throw new Error(`${task.id} destructive migration decision ${decision.id} consumption has no exact manifest transition`);
  }
  if (task.status === "awaiting_approval") {
    throw new Error(`${task.id} consumed destructive migration decision ${decision.id} requires a revised assignment with a fresh decision ID`);
  } else if (task.status !== "running" && task.status !== "completed") {
    throw new Error(`${task.id} consumed destructive migration decision ${decision.id} is incompatible with ${task.status}`);
  }
}

function approvalAuthority(runId: string, taskId: string, decision: SdlcDecision): DeliveryAuthorityApproval {
  if (!/^DEC-[A-Z0-9-]+$/.test(decision.id)) throw new Error(`destructive migration decision ID is not canonical: ${decision.id}`);
  if (decision.status === "deferred") throw new Error(`destructive migration decision ${decision.id} cannot be deferred`);
  const consumed = decision.consumed_at !== null;
  const base = {
    decision_id: decision.id,
    producer: "product-owner" as const,
    binding: { run_id: runId, task_id: taskId, action: decision.action as DeliveryAuthorityApproval["binding"]["action"] },
    sha256: sha256(JSON.stringify(decision)),
  };
  if (decision.status === "pending") return { ...base, status: "pending", complete: false, approved_by: null, consumed: false, consumed_at: null };
  if (decision.status === "rejected") return { ...base, status: "rejected", complete: true, approved_by: "product-owner", consumed: false, consumed_at: null };
  if (decision.approved_by !== "product-owner") throw new Error(`destructive migration decision ${decision.id} is not approved by product-owner`);
  return consumed
    ? { ...base, status: "approved", complete: true, approved_by: "product-owner", consumed: true, consumed_at: decision.consumed_at! }
    : { ...base, status: "approved", complete: true, approved_by: "product-owner", consumed: false, consumed_at: null };
}

function workflowOutputs(runId: string, task: Task): RequiredDeliveryOutput[] {
  return task.required_outputs
    .filter((path) => !path.endsWith("-delivery-report.yaml"))
    .map((path) => ({
      path: `.sdlc/runs/${runId}/${path}`,
      artifact_kind: artifactKind(path),
      producer: task.role as "backend" | "frontend",
      required: true,
    }));
}

async function resolveArtifactIntegrity(root: string, report: DeliveryReport): Promise<DeliveryArtifactIntegrity[]> {
  return Promise.all(report.artifacts.filter(isProducedArtifact).map(async (artifact) => {
    const source = await readRepositoryFile(root, artifact.path);
    return {
      path: artifact.path,
      artifact_kind: artifact.artifact_kind,
      producer: artifact.producer,
      revision: documentRevision(source, artifact.path),
      sha256: sha256(source),
      exists: true as const,
    };
  }));
}

function isProducedArtifact(artifact: DeliveryArtifactResult): artifact is Extract<DeliveryArtifactResult, { status: "produced" }> {
  return artifact.status === "produced";
}

function canonicalReportPath(assignment: DeliveryAssignment): string {
  return `.sdlc/runs/${assignment.run_id}/artifacts/${assignment.target}/${assignment.task_id}-delivery-report.yaml`;
}

function canonicalTaskReportPath(runId: string, task: Task): string {
  return `.sdlc/runs/${runId}/artifacts/${task.target}/${task.id}-delivery-report.yaml`;
}

function assertRepositoryAssignmentBindings(assignment: DeliveryAssignment): void {
  if (assignment.facts_sha256 === undefined) throw new Error(`${assignment.task_id} delivery assignment is missing facts_sha256`);
  for (const input of assignment.required_inputs) {
    if (input.producer === undefined || input.revision === undefined || input.exists === undefined || input.sha256 === undefined) {
      throw new Error(`${assignment.task_id} delivery assignment required input ${input.path} is missing producer/revision/exists/sha256 authority binding`);
    }
    if (input.exists !== (input.status === "available")) throw new Error(`${assignment.task_id} delivery assignment required input ${input.path} existence does not match status`);
    if ((input.exists && input.sha256 === null) || (!input.exists && input.sha256 !== null)) {
      throw new Error(`${assignment.task_id} delivery assignment required input ${input.path} hash does not match existence`);
    }
  }
}

async function missingRequiredOutputDiagnostics(root: string, runId: string, task: Task): Promise<string[]> {
  const diagnostics: string[] = [];
  for (const path of task.required_outputs) {
    if (!(await repositoryFileExists(root, `.sdlc/runs/${runId}/${path}`))) diagnostics.push(`${task.id} required output is missing: ${path}`);
  }
  return diagnostics;
}

function deliveryStateDiagnostics(task: Task, report: DeliveryReport): string[] {
  if (task.status === report.transition_request.from) return [];
  const requested = report.transition_request.to;
  if (requested === null) return [`${task.id} delivery report has no transition request for current state ${task.status}`];
  const handoffRecorded = task.transitions.some((transition) => transition.from === report.transition_request.from && transition.to === requested);
  if (!handoffRecorded) return [`${task.id} manifest does not record the delivery report transition ${report.transition_request.from} -> ${requested}`];
  if (task.status === requested) return [];
  if (task.status === "completed" && requested === "awaiting_review" && task.transitions.some((transition) => transition.from === "awaiting_review" && transition.to === "completed")) return [];
  return [`${task.id} current state ${task.status} is not derived from delivery report transition ${report.transition_request.from} -> ${requested}`];
}

export function assignmentStateDiagnostics(task: Task, assignment: DeliveryAssignment): string[] {
  if (task.status === assignment.task_status) return [];
  // The PM publishes execution authority before the atomic ready -> running
  // manifest transition. During that bounded activation window the assignment
  // intentionally describes the state in which the delivery role will run.
  if (task.status === "ready" && assignment.task_status === "running") return [];
  if (task.status === "running" && assignment.task_status === "ready" && task.transitions.some((transition) => transition.from === "ready" && transition.to === "running")) return [];
  if ((task.status === "awaiting_review" || task.status === "awaiting_approval" || task.status === "blocked" || task.status === "completed") && assignment.task_status === "running") return [];
  return [`${task.id} current state ${task.status} is not derived from assignment state ${assignment.task_status}`];
}

function assertDeliveryTask(task: Task): asserts task is Task & { role: "backend" | "frontend"; target: "backend" | "web" | "mobile"; stage: "api_contract" | "backend_implementation" | "web_implementation" | "mobile_implementation" } {
  if (!isDeliveryTask(task)) throw new Error(`task ${task.id} is not an activated backend/frontend delivery task`);
}

function isDeliveryTask(task: Task): task is Task & { role: "backend" | "frontend"; target: "backend" | "web" | "mobile"; stage: "api_contract" | "backend_implementation" | "web_implementation" | "mobile_implementation" } {
  return (task.role === "backend" && task.target === "backend" && (task.stage === "api_contract" || task.stage === "backend_implementation"))
    || (task.role === "frontend" && task.target === "web" && task.stage === "web_implementation")
    || (task.role === "frontend" && task.target === "mobile" && task.stage === "mobile_implementation");
}

function artifactKind(path: string): ArtifactKind {
  const name = path.split("/").at(-1) ?? "";
  if (name === "technical-design.md") return "technical_design";
  if (name === "openapi.yaml") return "openapi";
  if (name === "database-impact.md") return "database_impact";
  if (name === "security-impact.md") return "security_impact";
  if (name === "implementation-summary.md") return "implementation_summary";
  if (name.endsWith("-delivery-report.yaml")) return "delivery_report";
  throw new Error(`workflow output has no structured delivery artifact kind: ${path}`);
}

function producerForRunPath(path: string): Exclude<TaskRole, never> {
  if (path.startsWith("artifacts/ba/")) return "ba";
  if (path.startsWith("artifacts/backend/")) return "backend";
  if (path.startsWith("artifacts/web/") || path.startsWith("artifacts/mobile/")) return "frontend";
  if (path.startsWith("artifacts/qc/")) return "qc";
  return "pm";
}

function isTargetPermissionRoot(task: Task, path: string, project: ProjectConfig, runId: string): boolean {
  const artifactRoot = `.sdlc/runs/${runId}/artifacts/${task.target}`;
  if (task.role === "backend") {
    if (path === project.applications.backend?.root || path === artifactRoot) return true;
    return task.stage === "api_contract"
      && (project.resources?.api_contracts?.root === path || path === "packages/api-contracts/openapi.yaml" || path === "packages/api-contracts/generated");
  }
  if (task.target === "web") return path === project.applications.web?.root || path === artifactRoot;
  return path === project.applications.mobile?.root || path === artifactRoot;
}

function repositoryForTask(project: ProjectConfig, task: Task): string {
  if (task.stage === "api_contract" && project.resources?.api_contracts !== undefined) {
    return project.resources.api_contracts.repository;
  }
  if (task.target === "backend" || task.target === "web" || task.target === "mobile") {
    return repositoryForApplication(project, task.target);
  }
  return project.workspace?.coordinator ?? "coordinator";
}

function documentRevision(source: string, path: string): number {
  let value: unknown;
  try {
    if (path.endsWith(".yaml") || path.endsWith(".yml")) value = parseStrictYamlDocument(source);
    else {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
      if (match === null) throw new Error("missing YAML frontmatter");
      value = parseStrictYamlDocument(match[1]);
    }
  } catch (error) {
    throw new Error(`unable to read revision for ${path}: ${errorMessage(error)}`);
  }
  const revision = structuredDocumentRevision(value, path);
  if (revision === undefined) throw new Error(`${path} must declare a positive revision`);
  return revision;
}

async function readRepositoryFile(root: string, path: string): Promise<string> {
  const absolutePath = await resolvePathInsideRoot(root, path, { mustExist: true });
  return readFile(absolutePath, "utf8");
}

async function repositoryFileExists(root: string, path: string): Promise<boolean> {
  try {
    const absolutePath = await resolvePathInsideRoot(root, path);
    return (await lstat(absolutePath)).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function normalizeRepositoryPath(path: string): string {
  if (!isPortableRepositoryPath(path)) throw new Error(`invalid portable repository path: ${path}`);
  return path;
}

function assertSchema(name: "run" | "facts" | "deliveryAssignment" | "deliveryReport" | "deliveryAuthoritySnapshot", value: unknown, label: string): void {
  const validation = validateDocument(name, value);
  if (!validation.valid) throw new Error(`${label} is invalid: ${validation.diagnostics.join("; ")}`);
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
