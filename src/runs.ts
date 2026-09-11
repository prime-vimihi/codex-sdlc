import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";

import { parseDocument, stringify } from "yaml";

import { agentPolicyDiagnostics, assertTaskAgentDispatch, type AgentPolicy } from "./agents.js";
import { assertProductOwnerAdvisory } from "./product-owner.js";
import { assertAcyclic } from "./graph.js";
import { loadProject, loadWorkflow } from "./config.js";
import { FRAMEWORK_VERSION } from "./constants.js";
import { resolvePathInsideRoot, SdlcPathError } from "./paths.js";
import { validateDocument } from "./schemas.js";
import { validateRepositoryStructuredDelivery, type RepositoryRunSnapshot } from "./delivery-authority-resolver.js";
import {
  acquireRunAuthorityLock,
  assertHeldRunAuthorityLock,
  releaseRunAuthorityLock,
  type HeldRunAuthorityLock,
  type RunAuthorityLockOptions,
} from "./run-authority-lock.js";
import type { RunManifest, Task, TaskRole, TaskStage, TaskStatus, TaskTarget, WorkflowConfig } from "./types.js";
import { resolveWorkspace } from "./workspace.js";

const runIdPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export interface StartRunInput {
  id: string;
  title: string;
  requestFile: string;
  affectedApplications: {
    backend: boolean;
    web: boolean;
    mobile: boolean;
    database: boolean;
    sharedPackages: boolean;
  };
  now: string;
}

export interface ValidationReport {
  valid: boolean;
  diagnostics: string[];
}

export interface StartRunOptions {
  /** Test-only hook for deterministic publication-race coverage. */
  beforeReserve?: (runDirectory: string) => Promise<void> | void;
  /** Test-only hook for cleanup coverage after a successful reservation. */
  afterReserve?: (runDirectory: string) => Promise<void> | void;
}

export async function startRun(root: string, input: StartRunInput, options: StartRunOptions = {}): Promise<string> {
  if (!runIdPattern.test(input.id)) {
    throw new Error(`invalid run ID: ${input.id}`);
  }
  if (input.title.trim() === "") {
    throw new Error("run title must not be empty");
  }
  if (!input.affectedApplications.backend && !input.affectedApplications.web && !input.affectedApplications.mobile) {
    throw new Error("at least one of backend, web, or mobile must be affected in v0.1");
  }
  const project = await loadProject(root);
  await resolveWorkspace(root, project);
  const runsDirectory = await resolvePathInsideRoot(root, ".sdlc/runs", { mustExist: true });
  const requestSource = await resolvePathInsideRoot(root, input.requestFile, { mustExist: true });
  const templatePath = await resolvePathInsideRoot(root, ".sdlc/templates/run-manifest.yaml", { mustExist: true });
  const runDirectory = await resolvePathInsideRoot(root, `.sdlc/runs/${input.id}`);

  try {
    await resolvePathInsideRoot(root, `.sdlc/runs/${input.id}`, { mustExist: true });
    throw new Error(`run directory already exists: ${input.id}`);
  } catch (error) {
    if (!(error instanceof SdlcPathError && error.message.startsWith("path does not exist"))) {
      throw error;
    }
  }

  const temporaryDirectory = await mkdtemp(join(runsDirectory, ".creating-"));
  try {
    const manifestPath = join(temporaryDirectory, "manifest.yaml");
    const requestDestination = join(temporaryDirectory, "request.md");
    const template = await readFile(templatePath, "utf8");
    const manifest = renderManifest(template, input, await loadWorkflow(root), project.agents);
    const validation = await validateManifest(manifest, root, input.id);
    if (!validation.valid) {
      throw new Error(`rendered run manifest is invalid:\n${validation.diagnostics.join("\n")}`);
    }

    await copyFile(requestSource, requestDestination);
    await mkdir(join(temporaryDirectory, "artifacts"), { recursive: true });
    await mkdir(join(temporaryDirectory, "evidence"), { recursive: true });
    await writeManifest(manifestPath, manifest);
    await options.beforeReserve?.(runDirectory);
    let reservedDirectory = false;
    let reservation: Reservation | undefined;
    try {
      await mkdir(runDirectory);
      reservedDirectory = true;
      reservation = await createReservation(runDirectory);
      await options.afterReserve?.(runDirectory);
      await publishTemporaryRun(temporaryDirectory, runDirectory, reservation);
    } catch (error) {
      if (reservation !== undefined) {
        await cleanupReservation(runDirectory, reservation);
      } else if (reservedDirectory) {
        await rmdir(runDirectory).catch(() => undefined);
      }
      if (isAlreadyExists(error)) {
        throw new Error(`run directory already exists: ${input.id}`);
      }
      throw error;
    }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return runDirectory;
}

export async function loadRun(root: string, runId: string, options: RunAuthorityLockOptions = {}): Promise<RunManifest> {
  const lock = await acquireRunAuthorityLock(root, runId, options);
  try {
    return (await loadRunSnapshotUnderLock(root, runId, false, lock)).manifest;
  } finally {
    await releaseRunAuthorityLock(lock);
  }
}

export async function validateRun(root: string, runId: string, options: RunAuthorityLockOptions = {}): Promise<ValidationReport> {
  try {
    await resolveWorkspace(root, await loadProject(root));
    const lock = await acquireRunAuthorityLock(root, runId, options);
    try {
      return await validateStoredRunUnderLock(root, runId, true, lock);
    } finally {
      await releaseRunAuthorityLock(lock);
    }
  } catch (error) {
    return { valid: false, diagnostics: [errorMessage(error)] };
  }
}

async function validateStoredRunUnderLock(
  root: string,
  runId: string,
  structuredDelivery: boolean,
  lock: HeldRunAuthorityLock,
): Promise<ValidationReport> {
  let manifestPath: string;
  try {
    manifestPath = await runManifestPath(root, runId);
  } catch (error) {
    return { valid: false, diagnostics: [errorMessage(error)] };
  }

  let snapshot: RepositoryRunSnapshot;
  try {
    const manifestSource = await readFile(manifestPath, "utf8");
    snapshot = { manifest: parseManifest(manifestSource), manifestSource };
  } catch (error) {
    return { valid: false, diagnostics: [errorMessage(error)] };
  }

  return validateRunSnapshotUnderLock(root, runId, snapshot, structuredDelivery, lock);
}

export async function loadRunSnapshotUnderLock(
  root: string,
  runId: string,
  structuredDelivery: boolean,
  lock: HeldRunAuthorityLock,
): Promise<RepositoryRunSnapshot> {
  await assertHeldRunAuthorityLock(lock, root, runId);
  const manifestPath = await runManifestPath(root, runId);
  const manifestSource = await readFile(manifestPath, "utf8");
  const snapshot = { manifest: parseManifest(manifestSource), manifestSource };
  const report = await validateRunSnapshotUnderLock(root, runId, snapshot, structuredDelivery, lock);
  if (!report.valid) throw new Error(`invalid run ${runId}:\n${report.diagnostics.join("\n")}`);
  return snapshot;
}

export async function validateRunSnapshotUnderLock(
  root: string,
  runId: string,
  snapshot: RepositoryRunSnapshot,
  structuredDelivery: boolean,
  lock: HeldRunAuthorityLock,
): Promise<ValidationReport> {
  await assertHeldRunAuthorityLock(lock, root, runId);
  const diagnostics: string[] = [];
  const { manifest } = snapshot;

  diagnostics.push(...(await reservationDiagnostics(root, runId)));
  diagnostics.push(...(await validateManifest(manifest, root, runId)).diagnostics);
  if (structuredDelivery && diagnostics.length === 0) {
    diagnostics.push(...(await validateRepositoryStructuredDelivery(root, runId, snapshot, lock)).diagnostics);
    const advisory = manifest.tasks.find((task) => task.id === "PO-001");
    if (advisory !== undefined && ["awaiting_review", "completed"].includes(advisory.status)) {
      try { await assertProductOwnerAdvisory(root, runId, manifest); } catch (error) { diagnostics.push(errorMessage(error)); }
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function renderManifest(template: string, input: StartRunInput, workflow: WorkflowConfig, agents?: AgentPolicy): RunManifest {
  const tasks = createTasks(input, workflow, agents);
  const replacements: Record<string, string> = {
    run_id: input.id,
    title: yamlScalar(input.title),
    created_at: yamlScalar(input.now),
    updated_at: yamlScalar(input.now),
    framework_version: FRAMEWORK_VERSION,
    affected_backend: String(input.affectedApplications.backend),
    affected_web: String(input.affectedApplications.web),
    affected_mobile: String(input.affectedApplications.mobile),
    affected_database: String(input.affectedApplications.database),
    affected_shared_packages: String(input.affectedApplications.sharedPackages),
    tasks_yaml: indent(stringify(tasks).trimEnd(), 2),
    api_contract_quality_gate_status: input.affectedApplications.backend ? "pending" : "not_applicable",
    backend_quality_gate_status: input.affectedApplications.backend ? "pending" : "not_applicable",
    web_quality_gate_status: input.affectedApplications.web ? "pending" : "not_applicable",
    mobile_quality_gate_status: input.affectedApplications.mobile ? "pending" : "not_applicable",
  };
  const withTasks = template.replace("tasks: [] # {{tasks_yaml}}", `tasks:\n${replacements.tasks_yaml}`);
  const rendered = withTasks.replace(/{{([a-z_]+)}}/g, (token, key: string) => replacements[key] ?? token);
  if (/{{[^}]+}}/.test(rendered)) {
    throw new Error("run manifest template contains unresolved token");
  }
  const manifest = parseManifest(rendered);
  if (agents !== undefined) manifest.agent_policy = structuredClone(agents);
  return manifest;
}

function createTasks(input: StartRunInput, workflow: WorkflowConfig, agents?: AgentPolicy): Task[] {
  const outputsByStage = new Map(workflow.stages.map((stage) => [stage.id, stage.required_outputs]));
  const tasks: Task[] = [
    createTask("PM-001", "Intake and discovery", "intake", "pm", null, [], outputsByStage, input.now, "ready"),
    createTask("BA-001", "Business requirements", "requirements", "ba", null, ["PM-001"], outputsByStage, input.now),
    createTask("PM-002", "Requirements review", "requirements_review", "pm", null, ["BA-001"], outputsByStage, input.now),
  ];
  const implementationDependencies = ["PM-002"];
  if (input.affectedApplications.backend) {
    tasks.push(
      createTask("BE-001", "API contract", "api_contract", "backend", "backend", ["PM-002"], outputsByStage, input.now),
      createTask("PM-003", "API contract review", "api_contract_review", "pm", null, ["BE-001"], outputsByStage, input.now),
    );
    implementationDependencies.push("PM-003");
  }
  const implementationTasks: Task[] = [];
  if (input.affectedApplications.backend) {
    implementationTasks.push(createTask("BE-002", "Backend implementation", "backend_implementation", "backend", "backend", implementationDependencies, outputsByStage, input.now));
  }
  if (input.affectedApplications.web) {
    implementationTasks.push(createTask("WEB-001", "Web implementation", "web_implementation", "frontend", "web", implementationDependencies, outputsByStage, input.now));
  }
  if (input.affectedApplications.mobile) {
    implementationTasks.push(createTask("MOB-001", "Mobile implementation", "mobile_implementation", "frontend", "mobile", implementationDependencies, outputsByStage, input.now));
  }
  tasks.push(...implementationTasks);
  tasks.push(
    createTask("INT-001", "Integration review", "integration", "pm", "integration", implementationTasks.map((task) => task.id), outputsByStage, input.now),
    createTask("QC-001", "Independent QC", "qc", "qc", "qc", ["INT-001"], outputsByStage, input.now),
  );
  if (agents?.product_owner_review === "advisory") {
    if (!outputsByStage.has("product_owner_advisory")) throw new Error("upgrade the installed workflow before enabling AI Product Owner review");
    tasks.push(createTask("PO-001", "AI Product Owner advisory review", "product_owner_advisory", "po", null, ["QC-001"], outputsByStage, input.now));
  }
  tasks.push(createTask("PM-004", "Product Owner delivery package", "product_owner_review", "pm", null, [agents?.product_owner_review === "advisory" ? "PO-001" : "QC-001"], outputsByStage, input.now));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    task.required_inputs = [...new Set(task.dependencies.flatMap((id) => byId.get(id)?.required_outputs ?? []))];
    if (task.id === "PM-004" && agents?.product_owner_review === "advisory") {
      task.required_inputs = [...new Set([...task.required_inputs, ...(byId.get("QC-001")?.required_outputs ?? [])])];
    }
    if (task.role === "po") {
      task.required_inputs = [...new Set([...task.required_inputs, "request.md", "facts.yaml", ...(byId.get("BA-001")?.required_outputs ?? [])])];
    }
    if (task.role === "backend" || task.role === "frontend") {
      task.required_inputs.push(`tasks/${task.id}.assignment.yaml`);
    }
  }
  return tasks;
}

function createTask(
  id: string,
  title: string,
  stage: TaskStage,
  role: TaskRole,
  target: TaskTarget,
  dependencies: string[],
  outputsByStage: ReadonlyMap<TaskStage, string[]>,
  now: string,
  status: TaskStatus = "pending",
): Task {
  return {
    id,
    title,
    stage,
    role,
    target,
    status,
    dependencies,
    required_inputs: [],
    required_outputs: (outputsByStage.get(stage) ?? []).map((path) => path.replace("{task_id}", id)),
    outputs: [],
    evidence: [],
    transitions: status === "ready" ? [{
      from: "pending",
      to: "ready",
      actor: "system",
      reason: "Initial task has no dependencies",
      at: now,
    }] : [],
    started_at: null,
    completed_at: null,
    commit: null,
    blocker_reason: null,
    failure_reason: null,
  };
}

async function validateManifest(manifest: unknown, root: string, runId: string): Promise<ValidationReport> {
  const diagnostics = [...validateDocument("run", manifest).diagnostics];
  if (!isRecord(manifest) || !Array.isArray(manifest.tasks)) {
    return { valid: false, diagnostics };
  }
  if (!manifest.tasks.every(isRuntimeSafeTask)) {
    return { valid: false, diagnostics: [...diagnostics, ...(await manifestPathDiagnostics(manifest, root, runId))] };
  }
  if (manifest.agent_policy !== undefined) diagnostics.push(...agentPolicyDiagnostics(manifest.agent_policy));
  const tasks = manifest.tasks;
  if (diagnostics.length === 0) {
    for (const task of tasks) {
      if (["running", "awaiting_review", "awaiting_approval", "completed"].includes(task.status)) {
        try { assertTaskAgentDispatch(manifest as unknown as RunManifest, task); } catch (error) { diagnostics.push(errorMessage(error)); }
      }
    }
  }
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      diagnostics.push(`duplicate task ID: ${task.id}`);
    }
    taskIds.add(task.id);
    if (task.status === "blocked" && !isNonEmptyString(task.blocker_reason)) {
      diagnostics.push(`task ${task.id} requires a blocker reason while blocked`);
    }
    if (task.status === "failed" && !isNonEmptyString(task.failure_reason)) {
      diagnostics.push(`task ${task.id} requires a failure reason while failed`);
    }
    if (task.status === "completed" && !isNonEmptyString(task.completed_at)) {
      diagnostics.push(`task ${task.id} requires completed_at while completed`);
    }
  }
  try {
    assertAcyclic(tasks);
  } catch (error) {
    diagnostics.push(errorMessage(error));
  }
  diagnostics.push(...dependencyStateDiagnostics(tasks));
  diagnostics.push(...canonicalGraphDiagnostics(manifest, tasks, await loadWorkflow(root)));
  diagnostics.push(...(await manifestPathDiagnostics(manifest, root, runId)));
  return { valid: diagnostics.length === 0, diagnostics };
}

async function manifestPathDiagnostics(manifest: Record<string, unknown>, root: string, runId: string): Promise<string[]> {
  const diagnostics: string[] = [];
  const request = isRecord(manifest.request) ? manifest.request : undefined;
  const finalResult = isRecord(manifest.final_result) ? manifest.final_result : undefined;
  if (request === undefined || typeof request.file !== "string") {
    diagnostics.push("request is required for run path validation");
  }
  if (finalResult === undefined || typeof finalResult.report !== "string") {
    diagnostics.push("final_result is required for run path validation");
  }
  const paths = [
    ...(request === undefined || typeof request.file !== "string" ? [] : [request.file]),
    ...(finalResult === undefined || typeof finalResult.report !== "string" ? [] : [finalResult.report]),
    ...(Array.isArray(manifest.tasks)
      ? manifest.tasks.flatMap((task) => isRecord(task)
        ? [task.required_inputs, task.required_outputs, task.outputs, task.evidence]
          .flatMap((value) => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [])
        : [])
      : []),
  ];
  for (const path of paths) {
    try {
      await assertRunRelativePath(root, runId, path);
    } catch (error) {
      diagnostics.push(errorMessage(error));
    }
  }
  return diagnostics;
}

async function assertRunRelativePath(root: string, runId: string, candidate: string): Promise<void> {
  if (candidate.trim() === "" || candidate.split(/[\\/]+/).includes("..") || candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)) {
    throw new SdlcPathError(`run path escapes repository root: ${candidate}`);
  }
  const runRoot = join(root, ".sdlc/runs", runId);
  const target = join(runRoot, candidate);
  const fromRun = relative(runRoot, target);
  if (fromRun === ".." || fromRun.startsWith("..")) {
    throw new SdlcPathError(`run path escapes repository root: ${candidate}`);
  }
  await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${candidate}`);
}

function dependencyStateDiagnostics(tasks: Task[]): string[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const activeStatuses: readonly TaskStatus[] = ["ready", "running", "awaiting_review", "awaiting_approval", "blocked", "failed", "completed"];
  return tasks.flatMap((task) => {
    if (!activeStatuses.includes(task.status)) {
      return [];
    }
    const incomplete = task.dependencies.filter((dependencyId) => taskById.get(dependencyId)?.status !== "completed");
    return incomplete.length === 0 ? [] : [`task ${task.id} has incomplete dependencies: ${incomplete.join(", ")}`];
  });
}

function canonicalGraphDiagnostics(manifest: Record<string, unknown>, tasks: Task[], workflow: WorkflowConfig): string[] {
  const affected = affectedApplicationsFromManifest(manifest);
  if (affected === undefined) {
    return [];
  }
  if (!affected.backend && !affected.web && !affected.mobile) {
    return ["at least one of backend, web, or mobile must be affected in v0.1"];
  }
  const expectedTasks = createTasks({
    id: "CANONICAL-001",
    title: "Canonical graph",
    requestFile: "request.md",
    affectedApplications: affected,
    now: "1970-01-01T00:00:00.000Z",
  }, workflow, manifest.agent_policy as AgentPolicy | undefined);
  const expectedById = new Map(expectedTasks.map((task) => [task.id, task]));
  const actualById = new Map(tasks.map((task) => [task.id, task]));
  const diagnostics: string[] = [];
  for (const expected of expectedTasks) {
    const actual = actualById.get(expected.id);
    if (actual === undefined) {
      diagnostics.push(`canonical task is missing: ${expected.id}`);
      continue;
    }
    if (!sameStrings(actual.dependencies, expected.dependencies)) {
      diagnostics.push(`task ${expected.id} dependencies do not match canonical graph`);
    }
    if (!sameStrings(actual.required_inputs, expected.required_inputs) || !sameStrings(actual.required_outputs, expected.required_outputs)) {
      diagnostics.push(`task ${expected.id} artifact contracts do not match canonical workflow`);
    }
    if (actual.stage !== expected.stage || actual.role !== expected.role || actual.target !== expected.target) {
      diagnostics.push(`task ${expected.id} stage, role, or target does not match canonical graph`);
    }
  }
  for (const actual of tasks) {
    if (!expectedById.has(actual.id)) {
      diagnostics.push(`unexpected task outside canonical graph: ${actual.id}`);
    }
  }
  return diagnostics;
}

function affectedApplicationsFromManifest(manifest: Record<string, unknown>): StartRunInput["affectedApplications"] | undefined {
  if (!isRecord(manifest.affected_applications)) {
    return undefined;
  }
  const applications = manifest.affected_applications;
  if (![applications.backend, applications.web, applications.mobile, applications.database, applications.shared_packages].every((value) => typeof value === "boolean")) {
    return undefined;
  }
  return {
    backend: applications.backend as boolean,
    web: applications.web as boolean,
    mobile: applications.mobile as boolean,
    database: applications.database as boolean,
    sharedPackages: applications.shared_packages as boolean,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeSafeTask(value: unknown): value is Task {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.stage === "string"
    && typeof value.status === "string"
    && Array.isArray(value.dependencies)
    && Array.isArray(value.required_inputs)
    && Array.isArray(value.required_outputs)
    && Array.isArray(value.outputs)
    && Array.isArray(value.evidence)
    && value.dependencies.every((entry) => typeof entry === "string")
    && value.required_inputs.every((entry) => typeof entry === "string")
    && value.required_outputs.every((entry) => typeof entry === "string")
    && value.outputs.every((entry) => typeof entry === "string")
    && value.evidence.every((entry) => typeof entry === "string");
}

interface Reservation {
  markerPath: string;
  token: string;
}

async function createReservation(runDirectory: string): Promise<Reservation> {
  const markerPath = join(runDirectory, ".sdlc-reservation");
  const token = randomUUID();
  await writeFile(markerPath, token, { encoding: "utf8", flag: "wx" });
  return { markerPath, token };
}

async function publishTemporaryRun(temporaryDirectory: string, runDirectory: string, reservation: Reservation): Promise<void> {
  await rename(join(temporaryDirectory, "request.md"), join(runDirectory, "request.md"));
  await rename(join(temporaryDirectory, "artifacts"), join(runDirectory, "artifacts"));
  await rename(join(temporaryDirectory, "evidence"), join(runDirectory, "evidence"));
  await rename(join(temporaryDirectory, "manifest.yaml"), join(runDirectory, "manifest.yaml"));
  await rm(reservation.markerPath, { force: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function cleanupReservation(runDirectory: string, reservation: Reservation): Promise<void> {
  try {
    if (await readFile(reservation.markerPath, "utf8") !== reservation.token) {
      return;
    }
  } catch {
    return;
  }
  await rm(runDirectory, { recursive: true, force: true });
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function reservationDiagnostics(root: string, runId: string): Promise<string[]> {
  try {
    const markerPath = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/.sdlc-reservation`);
    await lstat(markerPath);
    return [`run ${runId} is incomplete or unpublished while .sdlc-reservation exists`];
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    return [`unable to determine publication state for ${runId}: ${errorMessage(error)}`];
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function runManifestPath(root: string, runId: string): Promise<string> {
  if (!runIdPattern.test(runId)) {
    throw new Error(`invalid run ID: ${runId}`);
  }
  return resolvePathInsideRoot(root, `.sdlc/runs/${runId}/manifest.yaml`, { mustExist: true });
}

async function writeManifest(path: string, manifest: RunManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const source = stringify(manifest);
  const parsed = parseManifest(source);
  if (JSON.stringify(parsed) !== JSON.stringify(manifest)) {
    throw new Error("rendered manifest did not round-trip safely");
  }
  await writeFile(path, source, { encoding: "utf8", flag: "wx" });
}

function parseManifest(source: string): RunManifest {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("\n"));
  }
  const value = document.toJS();
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error("run manifest must be a YAML object");
  }
  return value as RunManifest;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function indent(value: string, amount: number): string {
  const padding = " ".repeat(amount);
  return value.split("\n").map((line) => `${padding}${line}`).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
