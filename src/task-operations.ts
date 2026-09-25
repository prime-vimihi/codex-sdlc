import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";

import { stringify } from "yaml";

import { changedFilesForTask, validateChangedFilesAuthorityDocument, type ChangedFilesAuthorityDocument } from "./changed-files-authority.js";
import { loadProject } from "./config.js";
import { documentRevision, readArchivedAssignment, repositoryForTask, resolveApprovalDecisions, resolveArtifactIntegrity, resolvePermissionRoots, resolveRepositoryDeliveryAuthority, resolveRepositoryDeliveryReportPackage, resolveRequiredInputs, workflowOutputs, type RepositoryRunSnapshot, type ResolvedDeliveryAuthority } from "./delivery-authority-resolver.js";
import { reconcileDeliveryReportPackage, type DeliveryArtifactIntegrity } from "./delivery-report-reconciliation.js";
import { readEvidenceReference } from "./evidence-validation.js";
import { mutateRunManifest, publishRunAuthority, readAuthorityVersion } from "./manifest-transaction.js";
import { isPortableRepositoryPath, portablePathContains, resolvePathInsideRoot } from "./paths.js";
import { requiresCollectorEvidence, taskStageContract } from "./quality-gates.js";
import { acquireRunAuthorityLock, releaseRunAuthorityLock } from "./run-authority-lock.js";
import { loadRunSnapshotUnderLock } from "./runs.js";
import { validateDocument } from "./schemas.js";
import { parseStrictYamlDocument, reconcileDeliveryAssignmentAuthority, repositoryPathIdentity, type BackendControls, type CollectorEvidence, type DeliveryAssignment, type DeliveryAuthoritySnapshot, type DeliveryReport, type DeliveryResultStatus, type DeliveryWrite, type FrontendControls, type PortableDeliveryPath } from "./semantic-contracts.js";
import { prepareTransitionContext, transitionTask } from "./transitions.js";
import type { EvidenceRecord, ProjectConfig, RunManifest, Task } from "./types.js";
import { resolveWorkspace, resolveWorkspacePath } from "./workspace.js";
import { assertCompactDeliveryControls } from "./workflow-profile.js";

export interface PrepareTaskInput {
  /** Substantive requirements and decisions, supplied by PM; no mechanical assignment metadata. */
  controls: BackendControls | FrontendControls<string>;
  commandIds: string[];
}

export interface HandoffTaskInput {
  /** Outcomes are the delivery role's assertions, never inferred from the presence of a file. */
  requirementOutcomes: Array<{ requirement_id: string; capability: string; status: DeliveryResultStatus }>;
  /** Explicit task-owned subset of actual Git changes. Unrelated working-tree changes are excluded. */
  changedFiles: Array<{ path: string; repository?: string; type: "source" | "test" | "generated" }>;
}

export interface TaskOperationOptions {
  dryRun?: boolean;
  expectedVersion?: number;
  now?: string;
}

export interface TaskPacket extends ResolvedDeliveryAuthority {
  runId: string;
  taskId: string;
  authorityVersion: number;
  dryRun: boolean;
  taskStatus: Task["status"];
  paths: { assignment: string; report: string; receipt: string; changedFiles: string };
  /** Preparation never dispatches or activates the task. */
  executionAuthorized: boolean;
}

export interface TaskHandoffResult extends TaskPacket {
  report: DeliveryReport;
  artifactIntegrity: DeliveryArtifactIntegrity[];
  alreadyHandedOff: boolean;
}

interface Context {
  root: string;
  runId: string;
  task: Task;
  project: ProjectConfig;
  snapshot: RepositoryRunSnapshot;
  version: number;
}
interface ProductFingerprint { path: string; repository: string; type: "source" | "test" | "generated"; sha256: string }
interface HandoffReceipt {
  schema_version: 1;
  run_id: string;
  task_id: string;
  assignment_revision: number;
  assignment_sha256: string;
  report_sha256: string;
  files: ProductFingerprint[];
}
const execFileAsync = promisify(execFile);
const changedFilesRelative = "evidence/diffs/changed-files.json";

/** Build execution authority; dispatch and ready -> running remain separate, audited operations. */
export async function prepareTask(root: string, runId: string, taskId: string, input: PrepareTaskInput, options: TaskOperationOptions = {}): Promise<TaskPacket> {
  assertClosed(input, ["controls", "commandIds"], "task preparation input");
  const context = await captureContext(root, runId, taskId, options);
  if (!["ready", "running"].includes(context.task.status)) throw new Error(`cannot prepare ${taskId} while ${context.task.status}`);
  const paths = taskPaths(context);
  if (await optionalSource(root, paths.report) !== undefined) throw new Error("a current delivery report exists; use handoff retry or the repair workflow before revising this assignment");
  const previous = await readAssignment(context);
  const assignment = await buildAssignment(context, input, previous);
  const changed = await readChangedFiles(context);
  const resolved = await buildAuthority(context, assignment, changed.document, changed.source);
  assertValid(reconcileDeliveryAssignmentAuthority(resolved.assignment, resolved.authoritySnapshot, resolved.authorityIntegrity, { approvalLifecycle: "repository_runtime" }), "prepared assignment");
  if (!options.dryRun && !isDeepStrictEqual(previous, assignment)) {
    const published = await publishRunAuthority(root, runId, [{ path: `tasks/${taskId}.assignment.yaml`, source: assignmentSource(assignment) }], { expectedVersion: context.version });
    context.version = published.authorityVersion;
    return packet(context, await resolveRepositoryDeliveryAuthority(root, paths.assignment), false);
  }
  return packet(context, options.dryRun || previous === undefined ? resolved : await resolveRepositoryDeliveryAuthority(root, paths.assignment), options.dryRun ?? false);
}

/** Publish a file-backed handoff and request review. Never approves or completes a task. */
export async function handoffTask(root: string, runId: string, taskId: string, input: HandoffTaskInput, options: TaskOperationOptions = {}): Promise<TaskHandoffResult> {
  assertClosed(input, ["requirementOutcomes", "changedFiles"], "task handoff input");
  const context = await captureContext(root, runId, taskId, options);
  if (!["running", "awaiting_review"].includes(context.task.status)) throw new Error(`cannot hand off ${taskId} while ${context.task.status}`);
  const paths = taskPaths(context);
  const existing = await resolveRepositoryDeliveryAuthority(root, paths.assignment);
  assertEligible(context, existing.assignment.controls);
  const products = await inspectProductWrites(context, existing.assignment, input.changedFiles);
  const existingReport = await optionalSource(root, paths.report);
  if (existingReport !== undefined) {
    const resolved = await resolveRepositoryDeliveryReportPackage(root, paths.assignment);
    assertReportPackage(resolved);
    const currentEvidence = (await collectorEvidence(context, resolved.assignment.evidence_requirements.map((entry) => entry.command_key))).map((entry) => entry.authority);
    if (!isDeepStrictEqual(currentEvidence, resolved.assignment.available_evidence)) throw new Error("collector evidence changed since publication; repair the task before handing off again");
    assertOutcomes(resolved.assignment, input.requirementOutcomes, resolved.report);
    const receiptSource = await optionalSource(root, paths.receipt);
    if (receiptSource === undefined) throw new Error("handoff retry requires its runtime receipt; use the manual review flow for a manually published report");
    const receipt = JSON.parse(receiptSource) as HandoffReceipt;
    const expected = receiptFor(context, resolved.assignment, existingReport, products.fingerprints);
    if (!isDeepStrictEqual(receipt, expected)) throw new Error("handoff files or report changed since publication; repair the task before handing off again");
    if (!options.dryRun && context.task.status === "running") await requestReview(context, receipt, options);
    const current = options.dryRun ? resolved : await resolveRepositoryDeliveryReportPackage(root, paths.assignment);
    return { ...packet(context, current, options.dryRun ?? false), report: current.report, artifactIntegrity: current.artifactIntegrity, alreadyHandedOff: true };
  }
  if (context.task.status === "awaiting_review") throw new Error("awaiting_review task is missing its current handoff report");
  const assignment = await buildAssignment(context, { controls: existing.assignment.controls, commandIds: existing.assignment.evidence_requirements.map((entry) => entry.command_key) }, existing.assignment);
  await assertFreshPassedEvidence(context, assignment, products.latestModified);
  const artifacts = await Promise.all(assignment.required_outputs.map(async (output) => {
    const source = await readSource(root, output.path);
    return { path: output.path, artifact_kind: output.artifact_kind, producer: output.producer, status: "produced" as const, revision: documentRevision(source, output.path), sha256: sha256(source) };
  }));
  const writes: DeliveryWrite[] = [...products.writes, ...artifacts.map((artifact) => ({ path: artifact.path, type: "artifact" as const }))];
  for (const write of writes) assertWriteScope(context, assignment, write);
  const priorChanged = await readChangedFiles(context);
  const document = mergeChangedFiles(context, assignment, priorChanged.document, writes);
  await validateChangedFilesAuthorityDocument(root, document, context.snapshot.manifest, context.project);
  const changedSource = JSON.stringify(document, null, 2) + "\n";
  const resolved = await buildAuthority(context, assignment, document, changedSource);
  const outcomes = deriveOutcomes(assignment, input.requirementOutcomes);
  const observations = assignment.role === "backend"
    ? { mode: assignment.controls.mode, storage: assignment.controls.storage, migration: assignment.controls.migration, requirement_results: outcomes }
    : { api_contract_status: assignment.controls.api_contract_status, gaps: assignment.controls.gaps, questions: assignment.controls.questions, requirement_results: outcomes };
  const report = {
    schema_version: 1, kind: "delivery_report", assignment_id: assignment.assignment_id, assignment_revision: assignment.revision,
    run_id: runId, task_id: taskId, ...(assignment.repository === undefined ? {} : { repository: assignment.repository }),
    revision: assignment.revision, role: assignment.role, producer: assignment.role, target: assignment.target, stage: assignment.stage, scenario: assignment.scenario,
    disposition: "proceed", transition_request: { from: "running", to: "awaiting_review" }, artifacts, writes,
    evidence: assignment.available_evidence.map((entry) => entry.status === "passed" || entry.status === "failed" ? entry : { ...entry, reference: null, document_sha256: null }), observations,
  } as DeliveryReport;
  const artifactIntegrity = await resolveArtifactIntegrity(root, report);
  assertReportPackage({ ...resolved, report, artifactIntegrity });
  const reportSource = stringify(report, { aliasDuplicateObjects: false });
  const receipt = receiptFor(context, assignment, reportSource, products.fingerprints);
  assertReportScope(context, assignment);
  if (!options.dryRun) {
    const publication = await publishRunAuthority(root, runId, [
      { path: `tasks/${taskId}.assignment.yaml`, source: assignmentSource(assignment) },
      { path: changedFilesRelative, source: changedSource },
      { path: `artifacts/${context.task.target}/${taskId}-delivery-report.yaml`, source: reportSource },
      { path: `tasks/${taskId}.handoff.json`, source: JSON.stringify(receipt, null, 2) + "\n" },
    ], { expectedVersion: context.version, beforeRelease: () => assertFingerprintsUnchanged(context, assignment, receipt.files) });
    context.version = publication.authorityVersion;
    await requestReview(context, receipt, options);
  }
  const current = options.dryRun ? { ...resolved, report, artifactIntegrity } : await resolveRepositoryDeliveryReportPackage(root, paths.assignment);
  return { ...packet(context, current, options.dryRun ?? false), report: current.report, artifactIntegrity: current.artifactIntegrity, alreadyHandedOff: false };
}

async function captureContext(root: string, runId: string, taskId: string, options: TaskOperationOptions): Promise<Context> {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(runId) || !/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(taskId)) throw new Error("task operations require canonical run and task IDs");
  const lock = await acquireRunAuthorityLock(root, runId);
  try {
    const version = await readAuthorityVersion(root, runId);
    if (options.expectedVersion !== undefined && options.expectedVersion !== version) throw new Error(`stale authority version: expected ${options.expectedVersion} but actual ${version}`);
    const snapshot = await loadRunSnapshotUnderLock(root, runId, false, lock);
    const task = snapshot.manifest.tasks.find((entry) => entry.id === taskId);
    if (task === undefined) throw new Error(`unknown task ${taskId}`);
    taskStageContract(task);
    if (task.role !== "backend" && task.role !== "frontend") throw new Error("automatic task preparation/handoff supports backend and frontend tasks only");
    const project = await loadProject(root);
    return { root, runId, task, project, snapshot, version };
  } finally { await releaseRunAuthorityLock(lock); }
}

async function buildAssignment(context: Context, input: PrepareTaskInput, previous?: DeliveryAssignment): Promise<DeliveryAssignment> {
  const { root, runId, task, project, snapshot } = context;
  assertEligible(context, input.controls);
  if (!Array.isArray(input.commandIds) || input.commandIds.some((id) => typeof id !== "string" || !Object.hasOwn(project.commands, id))) throw new Error("task commandIds must name configured project commands");
  if (new Set(input.commandIds).size !== input.commandIds.length) throw new Error("duplicate task command ID");
  if (requiresCollectorEvidence(task) && input.commandIds.length === 0) throw new Error("implementation preparation requires at least one configured verification command");
  const factsSource = await readSource(root, `.sdlc/runs/${runId}/facts.yaml`);
  const facts = parseStrictYamlDocument(factsSource) as { revision: number; run_id: string; producer: string };
  assertValid(validateDocument("facts", facts), "task facts");
  if (facts.run_id !== runId || facts.producer !== "pm") throw new Error("facts identity does not match the selected run");
  const requiredInputs = await resolveRequiredInputs(root, runId, task);
  if (requiredInputs.some((entry) => !entry.exists)) throw new Error("task preparation requires all required inputs to exist");
  const application = project.applications[task.target!];
  if (application === undefined) throw new Error(`task target ${task.target} is not configured`);
  if (application.lifecycle === "planned") throw new Error("task preparation requires a scaffolded application; scaffold it and update project lifecycle first");
  const repository = repositoryForTask(project, task);
  const archived = await readArchivedAssignment(root, runId, task.id, snapshot.manifest);
  if (previous !== undefined && archived !== undefined && previous.revision <= archived.revision) throw new Error("current assignment is from an archived repair cycle");
  const assignment = {
    schema_version: 1, kind: "delivery_assignment", assignment_id: previous?.assignment_id ?? archived?.assignment_id ?? `ASN-${BigInt(`0x${sha256(`${runId}:${task.id}`).slice(0, 16)}`)}`,
    run_id: runId, task_id: task.id, producer: "pm", revision: previous?.revision ?? (archived?.revision ?? 0) + 1,
    role: task.role, target: task.target, stage: task.stage, scenario: task.stage === "api_contract" ? "contract_ready" : "full_task",
    ...(project.workspace?.mode === "multi-repository" ? { repository } : {}),
    facts_revision: facts.revision, facts_sha256: sha256(factsSource), task_status: "running", scaffold_status: "scaffolded",
    dependencies: task.dependencies.map((id) => ({ task_id: id, status: snapshot.manifest.tasks.find((entry) => entry.id === id)!.status })),
    required_inputs: requiredInputs.map((entry) => ({ ...entry, status: "available" })), required_outputs: workflowOutputs(runId, task),
    allowed_write_roots: [application.root, `.sdlc/runs/${runId}/artifacts/${task.target}`, ...(task.stage === "api_contract" ? [project.resources?.api_contracts?.root ?? "packages/api-contracts/openapi.yaml", ...(project.resources?.api_contracts ? [] : ["packages/api-contracts/generated"])] : [])],
    available_evidence: (await collectorEvidence(context, input.commandIds)).map((entry) => entry.authority),
    evidence_requirements: input.commandIds.map((command_key) => ({ command_key, required: true, owner: "runtime_collector" })),
    transition_policy: { current_status: "running", allowed_request: "awaiting_review", unmet_disposition: "refuse" }, controls: structuredClone(input.controls),
  } as DeliveryAssignment;
  const roots = await resolvePermissionRoots(root, runId, task, project, assignment);
  if (!roots.includes(application.root) && task.stage !== "api_contract") throw new Error(`permissions policy does not authorize configured application root ${application.root}`);
  if (roots.includes(".") && application.root !== ".") throw new Error("task preparation cannot widen write scope to the repository root");
  assignment.allowed_write_roots = roots;
  assertReportScope(context, assignment);
  if (previous !== undefined && !isDeepStrictEqual(previous, assignment)) assignment.revision = previous.revision + 1;
  assertValid(validateDocument("deliveryAssignment", assignment), "prepared assignment");
  return assignment;
}

function assertEligible(context: Context, controls: PrepareTaskInput["controls"]): void {
  const { task, snapshot } = context;
  assertCompactDeliveryControls(snapshot.manifest, controls);
  if (task.dependencies.some((id) => snapshot.manifest.tasks.find((entry) => entry.id === id)?.status !== "completed")) throw new Error("task has incomplete dependencies");
  if (snapshot.manifest.blockers.some((entry) => entry.task_id === task.id && entry.status === "open")) throw new Error("task has an unresolved blocker");
  if (snapshot.manifest.decisions?.some((entry) => entry.affected_tasks.includes(task.id) && ["pending", "rejected", "deferred"].includes(entry.status))) throw new Error("task has an unresolved approval");
  if (task.role === "backend") {
    if (!("mode" in controls)) throw new Error("backend task requires backend controls");
    if (controls.mode !== (task.stage === "api_contract" ? "api_contract" : "implementation")) throw new Error("backend controls mode does not match task stage");
    if (controls.migration.impact === "destructive") {
      const migration = controls.migration;
      const decision = snapshot.manifest.decisions?.find((entry) => entry.id === migration.decision_id);
      if (migration.approval_status !== "approved" || decision?.status !== "approved" || decision.approved_by !== "product-owner"
        || decision.action !== `transition:${task.id}:running` || !decision.affected_tasks.includes(task.id)
        || !decision.decision || !decision.decided_at || !decision.consumed_at || decision.consumed_by_transition !== `${task.id}:awaiting_approval->running`
        || !task.transitions.some((entry) => entry.from === "awaiting_approval" && entry.to === "running" && entry.at === decision.consumed_at)) {
        throw new Error("task has an unresolved destructive migration approval; complete the bound runtime approval/resume flow first");
      }
    }
  } else {
    if (!("api_contract_status" in controls)) throw new Error("frontend task requires frontend controls");
    if (controls.api_contract_status !== "approved" || controls.gaps.some((entry) => entry.state === "unresolved") || controls.questions.some((entry) => entry.status !== "resolved")) throw new Error("task has an unresolved API/design gap or question");
  }
}

async function collectorEvidence(context: Context, commandIds: string[]): Promise<Array<{ authority: CollectorEvidence; record: EvidenceRecord }>> {
  const latest = new Map<string, { authority: CollectorEvidence; record: EvidenceRecord }>();
  for (const reference of context.task.evidence) {
    const { record, source } = await readEvidenceReference({ root: context.root, runId: context.runId, manifest: context.snapshot.manifest, reference, project: context.project, owner: context.task.role, expectedTask: context.task, expectedStage: context.task.stage });
    if (!commandIds.includes(record.command_id)) continue;
    const previous = latest.get(record.command_id);
    if (previous !== undefined && previous.record.completed_at > record.completed_at) continue;
    latest.set(record.command_id, { record, authority: { evidence_id: record.id, command_key: record.command_id, owner: "runtime_collector", reference, document_sha256: sha256(source), status: record.result_status } });
  }
  return commandIds.flatMap((id) => latest.has(id) ? [latest.get(id)!] : []);
}

async function assertFreshPassedEvidence(context: Context, assignment: DeliveryAssignment, latestModified: number): Promise<void> {
  const actual = await collectorEvidence(context, assignment.evidence_requirements.map((entry) => entry.command_key));
  for (const requirement of assignment.evidence_requirements.filter((entry) => entry.required)) {
    const evidence = actual.find((entry) => entry.record.command_id === requirement.command_key);
    if (evidence === undefined || evidence.record.result_status !== "passed") throw new Error(`missing passed collector evidence for ${requirement.command_key}`);
    // A check can read the input near its start and finish after a later edit.
    // Completion time therefore cannot establish that it verified these bytes.
    if (Date.parse(evidence.record.started_at) < latestModified) throw new Error(`stale collector evidence for ${requirement.command_key}: product files changed after verification started`);
  }
}

async function buildAuthority(context: Context, assignment: DeliveryAssignment, document: ChangedFilesAuthorityDocument, changedSource: string): Promise<ResolvedDeliveryAuthority> {
  const { root, runId, task, snapshot, project } = context;
  const paths = taskPaths(context);
  const changedFiles = { path: changedFilesRelative, sha256: sha256(changedSource), files: changedFilesForTask(document, task, project, assignment.required_outputs.map((entry) => entry.path)) };
  const authoritySnapshot: DeliveryAuthoritySnapshot = {
    schema_version: 1, kind: "delivery_authority_snapshot", captured_at: snapshot.manifest.run.updated_at ?? snapshot.manifest.run.created_at ?? "1970-01-01T00:00:00.000Z",
    assignment: { path: paths.assignment, assignment_id: assignment.assignment_id, revision: assignment.revision, sha256: sha256(assignmentSource(assignment)) },
    run: { path: `.sdlc/runs/${runId}/manifest.yaml`, run_id: runId, sha256: sha256(snapshot.manifestSource) },
    task: { task_id: task.id, role: task.role, target: task.target, stage: task.stage, status: assignment.task_status, dependencies: assignment.dependencies, ...(assignment.repository === undefined ? {} : { repository: assignment.repository }) } as DeliveryAuthoritySnapshot["task"],
    facts: { path: `.sdlc/runs/${runId}/facts.yaml`, producer: "pm", revision: assignment.facts_revision, sha256: assignment.facts_sha256! },
    required_inputs: await resolveRequiredInputs(root, runId, task), workflow: { required_outputs: workflowOutputs(runId, task), permission_roots: await resolvePermissionRoots(root, runId, task, project, assignment) },
    evidence_documents: assignment.available_evidence, changed_files: changedFiles, approval_decisions: resolveApprovalDecisions(snapshot.manifest, task),
  };
  return { assignment, authoritySnapshot, authorityIntegrity: { assignment_sha256: authoritySnapshot.assignment.sha256, run_sha256: authoritySnapshot.run.sha256, facts_sha256: authoritySnapshot.facts.sha256, required_inputs: authoritySnapshot.required_inputs, evidence_documents: authoritySnapshot.evidence_documents, changed_files: changedFiles, approval_decisions: authoritySnapshot.approval_decisions } };
}

async function inspectProductWrites(context: Context, assignment: DeliveryAssignment, files: HandoffTaskInput["changedFiles"]) {
  if (!Array.isArray(files)) throw new Error("changedFiles must be an explicit task-owned file inventory");
  const workspace = await resolveWorkspace(context.root, context.project);
  const repository = repositoryForTask(context.project, context.task);
  const dirtyByRepository = new Map<string, Set<string>>();
  const fingerprints: ProductFingerprint[] = [];
  const writes: DeliveryWrite[] = [];
  let latestModified = 0;
  for (const file of files) {
    assertClosed(file, ["path", "type"], "changed file", ["repository"]);
    if (!["source", "test", "generated"].includes(file.type)) throw new Error("product changed files require source, test, or generated type");
    if (!isPortableRepositoryPath(file.path) || file.path.startsWith(".sdlc/")) throw new Error(`invalid product changed-file path ${file.path}`);
    const selectedRepository = file.repository ?? repository;
    if (selectedRepository !== repository) throw new Error(`changed-file repository ${selectedRepository} is outside task repository ${repository}`);
    const write: DeliveryWrite = { path: file.path, type: file.type, ...(assignment.repository === undefined ? {} : { repository: selectedRepository }) };
    assertWriteScope(context, assignment, write);
    const absolute = await resolveWorkspacePath(workspace, selectedRepository, file.path);
    const info = await lstat(absolute).catch((error: unknown) => {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`deleted or missing product files are unsupported by changed-file authority: ${file.path}`);
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`product changed file must be an existing regular file: ${file.path}`);
    let dirty = dirtyByRepository.get(selectedRepository);
    if (dirty === undefined) {
      const cwd = await resolveWorkspacePath(workspace, selectedRepository, ".");
      const [tracked, untracked] = await Promise.all([
        execFileAsync("git", ["diff", "HEAD", "--name-only", "-z", "--"], { cwd, maxBuffer: 8 * 1024 * 1024 }),
        execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, maxBuffer: 8 * 1024 * 1024 }),
      ]);
      dirty = new Set((tracked.stdout + untracked.stdout).split("\0").filter(Boolean));
      dirtyByRepository.set(selectedRepository, dirty);
    }
    if (!dirty.has(file.path)) throw new Error(`product file is not an actual Git change: ${file.path}`);
    const source = await readFile(absolute);
    const afterRead = await lstat(absolute);
    if (!afterRead.isFile() || info.dev !== afterRead.dev || info.ino !== afterRead.ino
      || info.size !== afterRead.size || info.mtimeMs !== afterRead.mtimeMs || info.ctimeMs !== afterRead.ctimeMs) {
      throw new Error(`product file changed during handoff inspection: ${file.path}`);
    }
    fingerprints.push({ path: file.path, repository: selectedRepository, type: file.type, sha256: sha256(source) });
    writes.push(write);
    latestModified = Math.max(latestModified, info.mtimeMs);
  }
  const identities = fingerprints.map((entry) => repositoryPathIdentity(entry));
  if (new Set(identities).size !== identities.length) throw new Error("duplicate product changed-file path");
  fingerprints.sort((left, right) => repositoryPathIdentity(left).localeCompare(repositoryPathIdentity(right)));
  writes.sort((left, right) => left.path.localeCompare(right.path));
  return { fingerprints, writes, latestModified };
}

function assertWriteScope(context: Context, assignment: DeliveryAssignment, write: DeliveryWrite): void {
  if (!isPortableRepositoryPath(write.path) || !assignment.allowed_write_roots.some((root) => portablePathContains(root, write.path))) throw new Error(`write path is outside task allowed roots: ${write.path}`);
  const artifactRoot = `.sdlc/runs/${context.runId}/artifacts/${context.task.target}`;
  if (write.type === "artifact") {
    if (!portablePathContains(artifactRoot, write.path) || !assignment.required_outputs.some((entry) => entry.path === write.path)) throw new Error(`artifact path is outside task output inventory: ${write.path}`);
  } else {
    const applicationRoot = context.project.applications[context.task.target!]?.root;
    const contractRoot = context.project.resources?.api_contracts?.root;
    const roots = [applicationRoot, ...(context.task.stage === "api_contract" ? [contractRoot ?? "packages/api-contracts/openapi.yaml", ...(contractRoot ? [] : ["packages/api-contracts/generated"])] : [])].filter((entry): entry is string => entry !== undefined);
    if (!roots.some((root) => portablePathContains(root, write.path))) throw new Error(`product path is outside selected application/contract scope: ${write.path}`);
  }
}

function assertReportScope(context: Context, assignment: DeliveryAssignment): void {
  const relative = `artifacts/${context.task.target}/${context.task.id}-delivery-report.yaml`;
  const canonical = `.sdlc/runs/${context.runId}/${relative}`;
  if (!context.task.required_outputs.includes(relative) || !assignment.allowed_write_roots.some((root) => portablePathContains(root, canonical))) throw new Error("canonical delivery report is outside task output/write authority");
}

function mergeChangedFiles(context: Context, assignment: DeliveryAssignment, prior: ChangedFilesAuthorityDocument, writes: DeliveryWrite[]): ChangedFilesAuthorityDocument {
  const paths = writes.map((write): PortableDeliveryPath => write.repository === undefined ? write.path : { repository: write.repository, path: write.path });
  const identities = new Set(paths.map(repositoryPathIdentity));
  const priorTaskFiles = changedFilesForTask(prior, context.task, context.project, assignment.required_outputs.map((entry) => entry.path));
  if (priorTaskFiles.some((entry) => !identities.has(repositoryPathIdentity(entry)))) throw new Error("handoff omits a previously recorded task-owned changed file");
  for (const owner of prior.ownership) {
    if (owner.task_id !== context.task.id && identities.has(repositoryPathIdentity(owner.repository === undefined ? owner.path : { repository: owner.repository, path: owner.path }))) throw new Error(`changed file is already owned by another task: ${owner.path}`);
  }
  return {
    files: [...prior.files.filter((entry) => !identities.has(repositoryPathIdentity(entry))), ...paths],
    ownership: [...prior.ownership.filter((entry) => !identities.has(repositoryPathIdentity(entry.repository === undefined ? entry.path : { repository: entry.repository, path: entry.path }))), ...writes.map((write) => ({ path: write.path, ...(write.repository === undefined ? {} : { repository: write.repository }), task_id: context.task.id }))],
  };
}

function deriveOutcomes(assignment: DeliveryAssignment, outcomes: HandoffTaskInput["requirementOutcomes"]) {
  if (!Array.isArray(outcomes)) throw new Error("requirementOutcomes must be an explicit requirement outcome inventory");
  for (const outcome of outcomes) assertClosed(outcome, ["requirement_id", "capability", "status"], "requirement outcome");
  const requirements = assignment.role === "backend" ? assignment.controls.api_requirements : assignment.controls.requirements;
  const keys = outcomes.map((entry) => `${entry.requirement_id}\0${entry.capability}`);
  if (new Set(keys).size !== keys.length || keys.length !== requirements.length) throw new Error("requirement outcomes must exactly match assignment requirement/capability pairs");
  return requirements.map((requirement) => {
    const outcome = outcomes.find((entry) => entry.requirement_id === requirement.requirement_id && entry.capability === requirement.capability);
    if (outcome === undefined) throw new Error(`missing outcome for ${requirement.requirement_id}/${requirement.capability}`);
    return { requirement_id: requirement.requirement_id, capability: requirement.capability, required: requirement.required, status: outcome.status };
  });
}

function assertOutcomes(assignment: DeliveryAssignment, outcomes: HandoffTaskInput["requirementOutcomes"], report: DeliveryReport): void {
  if (!isDeepStrictEqual(deriveOutcomes(assignment, outcomes), report.observations.requirement_results)) throw new Error("handoff outcomes changed since publication");
}

async function readAssignment(context: Context): Promise<DeliveryAssignment | undefined> {
  const source = await optionalSource(context.root, taskPaths(context).assignment);
  if (source === undefined) return undefined;
  const value = parseStrictYamlDocument(source) as DeliveryAssignment;
  assertValid(validateDocument("deliveryAssignment", value), "existing assignment");
  if (value.run_id !== context.runId || value.task_id !== context.task.id || value.role !== context.task.role || value.target !== context.task.target || value.stage !== context.task.stage) throw new Error("existing assignment has conflicting task identity");
  return value;
}

async function readChangedFiles(context: Context): Promise<{ document: ChangedFilesAuthorityDocument; source: string }> {
  const source = await optionalSource(context.root, taskPaths(context).changedFiles);
  if (source === undefined) return { document: { files: [], ownership: [] }, source: JSON.stringify({ files: [] }) };
  const document = await validateChangedFilesAuthorityDocument(context.root, JSON.parse(source), context.snapshot.manifest, context.project);
  return { document, source };
}

function receiptFor(context: Context, assignment: DeliveryAssignment, reportSource: string, files: ProductFingerprint[]): HandoffReceipt {
  return { schema_version: 1, run_id: context.runId, task_id: context.task.id, assignment_revision: assignment.revision, assignment_sha256: sha256(assignmentSource(assignment)), report_sha256: sha256(reportSource), files };
}

async function assertFingerprintsUnchanged(context: Context, assignment: DeliveryAssignment, files: ProductFingerprint[]): Promise<void> {
  const current = await inspectProductWrites(context, assignment, files.map(({ path, repository, type }) => ({ path, repository, type })));
  if (!isDeepStrictEqual(current.fingerprints, files)) throw new Error("product files changed during handoff; retry verification and handoff");
}

async function requestReview(context: Context, receipt: HandoffReceipt, options: TaskOperationOptions): Promise<void> {
  const { root, runId, task } = context;
  const transaction = await mutateRunManifest(root, runId, async (manifest) => {
    if (await readAuthorityVersion(root, runId) !== context.version) throw new Error("stale authority version before handoff transition");
    const current = manifest.tasks.find((entry) => entry.id === task.id)!;
    if (current.status !== "running") throw new Error("task state changed before handoff transition");
    const assignmentSourceActual = await readSource(root, taskPaths(context).assignment);
    const assignment = parseStrictYamlDocument(assignmentSourceActual) as DeliveryAssignment;
    if (sha256(assignmentSourceActual) !== receipt.assignment_sha256 || sha256(await readSource(root, taskPaths(context).report)) !== receipt.report_sha256) throw new Error("handoff authority changed before transition");
    await assertFingerprintsUnchanged(context, assignment, receipt.files);
    const request = { taskId: task.id, to: "awaiting_review" as const, actor: task.role, reason: "File-backed delivery handoff prepared for independent review", at: options.now ?? new Date().toISOString() };
    Object.assign(manifest, transitionTask(manifest, request, await prepareTransitionContext(root, runId, manifest, request)));
  });
  context.version = transaction.authorityVersion;
  context.task = transaction.manifest.tasks.find((entry) => entry.id === task.id)!;
  context.snapshot = { manifest: transaction.manifest, manifestSource: stringify(transaction.manifest, { aliasDuplicateObjects: false }) };
}

function packet(context: Context, resolved: ResolvedDeliveryAuthority, dryRun: boolean): TaskPacket {
  return { ...resolved, runId: context.runId, taskId: context.task.id, authorityVersion: context.version, dryRun, taskStatus: context.task.status, paths: taskPaths(context), executionAuthorized: !dryRun && context.task.status === "running" };
}
function taskPaths(context: Context): TaskPacket["paths"] {
  const base = `.sdlc/runs/${context.runId}`;
  return { assignment: `${base}/tasks/${context.task.id}.assignment.yaml`, report: `${base}/artifacts/${context.task.target}/${context.task.id}-delivery-report.yaml`, receipt: `${base}/tasks/${context.task.id}.handoff.json`, changedFiles: `${base}/${changedFilesRelative}` };
}
function assertReportPackage(value: ResolvedDeliveryAuthority & { report: DeliveryReport; artifactIntegrity: DeliveryArtifactIntegrity[] }): void {
  assertValid(reconcileDeliveryReportPackage({ schema_version: 1, kind: "structured_delivery_evaluation", scenario_id: `task-${value.assignment.task_id}`, assignment: value.assignment, authority_snapshot: value.authoritySnapshot, authority_integrity: value.authorityIntegrity, artifact_integrity: value.artifactIntegrity, report: value.report }, { approvalLifecycle: "repository_runtime" }), "handoff report");
}
function assertValid(value: { valid: boolean; diagnostics: unknown[] }, label: string): void { if (!value.valid) throw new Error(`${label} is invalid: ${value.diagnostics.join("; ")}`); }
function assertClosed(value: unknown, keys: string[], label: string, optional: string[] = []): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...keys, ...optional].includes(key))) throw new Error(`${label} has missing or unsupported fields`);
}
function assignmentSource(assignment: DeliveryAssignment): string { return stringify(assignment, { aliasDuplicateObjects: false }); }
function sha256(source: string | Buffer): string { return createHash("sha256").update(source).digest("hex"); }
async function readSource(root: string, path: string): Promise<string> { return readFile(await resolvePathInsideRoot(root, path, { mustExist: true }), "utf8"); }
async function optionalSource(root: string, path: string): Promise<string | undefined> {
  try { return await readFile(await resolvePathInsideRoot(root, path), "utf8"); }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
