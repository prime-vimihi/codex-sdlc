import { createHash } from "node:crypto";
import { loadProject } from "./config.js";
import { assertEvidenceReference } from "./evidence-validation.js";
import { resolvePathInsideRoot, SdlcPathError } from "./paths.js";
import { assertAcyclic, findReadyTaskIds } from "./graph.js";
import { qualityGateForTask, requiresCollectorEvidence } from "./quality-gates.js";
import type { QualityGate, RunManifest, SdlcDecision, Task, TaskStatus } from "./types.js";

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["ready", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["awaiting_review", "awaiting_approval", "blocked", "failed", "cancelled"],
  awaiting_review: ["completed", "running", "blocked", "failed"],
  awaiting_approval: ["running", "completed", "blocked", "cancelled"],
  blocked: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  completed: [],
  cancelled: [],
};

export interface TransitionRequest {
  taskId: string;
  to: TaskStatus;
  actor: string;
  reason: string;
  at: string;
}

export interface TransitionContext {
  existingInputPaths: readonly string[];
  existingOutputPaths: readonly string[];
  evidencePaths: readonly string[];
  passedEvidencePaths: readonly string[];
  qualityGateStatuses: Readonly<Record<string, QualityGate["status"]>>;
  resolvedBlockerIds: readonly string[];
  retryReasons: Readonly<Record<string, string>>;
  blocker: { id: string } | null;
  approvalDecision: SdlcDecision | null;
}

export interface TransitionPreparationOptions {
  resolveBlockerId?: string;
  retryReason?: string;
  decisionId?: string;
}

export class SdlcTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SdlcTransitionError";
  }
}

/** Indicates syntactically valid CLI options used with an incompatible state transition. */
export class SdlcTransitionUsageError extends SdlcTransitionError {
  public constructor(message: string) {
    super(message);
    this.name = "SdlcTransitionUsageError";
  }
}

/**
 * Builds the transition facts from the repository state. Keeping this beside
 * the pure transition engine prevents CLI adapters from inventing workflow
 * state or bypassing its audit rules.
 */
export async function prepareTransitionContext(
  root: string,
  runId: string,
  manifest: RunManifest,
  request: TransitionRequest,
  options: TransitionPreparationOptions = {},
): Promise<TransitionContext> {
  const task = manifest.tasks.find((candidate) => candidate.id === request.taskId);
  if (task === undefined) throw new SdlcTransitionError(`Task ${request.taskId} does not exist`);
  assertPreparationOptions(task.status, request.to, options);

  const references = [...new Set([...task.required_inputs, ...task.required_outputs, ...task.outputs, ...task.evidence])];
  const existingOutputPaths: string[] = [];
  for (const reference of references) {
    try {
      await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${reference}`, { mustExist: true });
      existingOutputPaths.push(reference);
    } catch (error) {
      if (error instanceof SdlcPathError && error.message.startsWith("path does not exist")) continue;
      throw error;
    }
  }

  const evidencePaths = [...new Set(task.evidence)];
  const passedEvidencePaths: string[] = [];
  if (evidencePaths.length > 0) {
    const project = await loadProject(root);
    for (const reference of evidencePaths) {
      try {
        const evidence = await assertEvidenceReference({
          root,
          runId,
          manifest,
          reference,
          project,
          owner: task.id,
          expectedTask: task,
        });
        if (evidence.result_status === "passed" && evidence.exit_code === 0) {
          passedEvidencePaths.push(reference);
        }
      } catch (error) {
        throw new SdlcTransitionError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const resolvedBlockerIds = resolveBlockers(manifest, task.id, task.status, request.to, options.resolveBlockerId);
  return {
    existingInputPaths: existingOutputPaths.filter((path) => task.required_inputs.includes(path)),
    existingOutputPaths,
    evidencePaths,
    passedEvidencePaths,
    qualityGateStatuses: Object.fromEntries(Object.entries(manifest.quality_gates).map(([id, gate]) => [id, gate.status])),
    resolvedBlockerIds,
    retryReasons: task.status === "failed" && request.to === "ready" && options.retryReason !== undefined
      ? { [task.id]: options.retryReason }
      : {},
    blocker: request.to === "blocked" ? { id: nextBlockerId(manifest, runId, task.id, request.reason, request.at) } : null,
    approvalDecision: options.decisionId === undefined ? null : manifest.decisions?.find((decision) => decision.id === options.decisionId) ?? null,
  };
}

function assertPreparationOptions(
  sourceStatus: TaskStatus,
  targetStatus: TaskStatus,
  options: TransitionPreparationOptions,
): void {
  if (options.resolveBlockerId !== undefined && !(sourceStatus === "blocked" && targetStatus === "ready")) {
    throw new SdlcTransitionUsageError("--resolve-blocker is valid only for a blocked-to-ready transition");
  }
  if (options.retryReason !== undefined && !(sourceStatus === "failed" && targetStatus === "ready")) {
    throw new SdlcTransitionUsageError("--retry-reason is valid only for a failed-to-ready transition");
  }
  if (options.decisionId !== undefined && !(sourceStatus === "awaiting_approval" && (targetStatus === "running" || targetStatus === "completed"))) {
    throw new SdlcTransitionUsageError("--decision is valid only for an approval transition");
  }
}

function resolveBlockers(
  manifest: RunManifest,
  taskId: string,
  sourceStatus: TaskStatus,
  targetStatus: TaskStatus,
  requestedBlockerId: string | undefined,
): string[] {
  if (sourceStatus !== "blocked" || targetStatus !== "ready") return [];
  if (requestedBlockerId === undefined || requestedBlockerId.trim() === "") {
    return [];
  }
  const blocker = manifest.blockers.find((candidate) => candidate.id === requestedBlockerId);
  if (blocker === undefined || blocker.task_id !== taskId || blocker.status !== "open") {
    throw new SdlcTransitionError(`Task ${taskId} cannot resolve blocker ${requestedBlockerId}`);
  }
  return [blocker.id];
}

function nextBlockerId(manifest: RunManifest, runId: string, taskId: string, reason: string, at: string): string {
  const base = `BLK-${createHash("sha256").update(`${runId}\u0000${taskId}\u0000${reason}\u0000${at}`).digest("hex").slice(0, 12)}`;
  const existing = new Set(manifest.blockers.map((blocker) => blocker.id));
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export function transitionTask(
  manifest: RunManifest,
  request: TransitionRequest,
  context: TransitionContext,
): RunManifest {
  const result = structuredClone(manifest);
  assertAcyclic(result.tasks);

  const task = result.tasks.find((candidate) => candidate.id === request.taskId);
  if (task === undefined) {
    throw new SdlcTransitionError(`Task ${request.taskId} does not exist`);
  }
  const sourceStatus = task.status;
  assertTransitionIsLegal(task, request, result.tasks);
  assertTransitionConditions(task, request, result, context);
  const auditReason = sourceStatus === "failed" && request.to === "ready"
    ? `${request.reason} (retry reason: ${context.retryReasons[task.id]})`
    : request.reason;

  task.status = request.to;
  task.transitions.push({
    from: sourceStatus,
    to: request.to,
    actor: request.actor,
    reason: auditReason,
    at: request.at,
  });
  if (sourceStatus === "ready" && request.to === "running" && task.started_at === null) {
    task.started_at = request.at;
  }
  if (request.to === "awaiting_review") {
    task.outputs = [...new Set([...task.outputs, ...task.required_outputs])];
  }
  if (request.to === "blocked") {
    task.blocker_reason = request.reason;
    result.blockers.push({
      id: context.blocker!.id,
      task_id: task.id,
      description: request.reason,
      status: "open",
    });
  }
  if (request.to === "failed") {
    task.failure_reason = request.reason;
    task.evidence = [...new Set([...task.evidence, ...context.evidencePaths])];
  }
  if (request.to === "completed") {
    task.completed_at = request.at;
    task.evidence = [...new Set([...task.evidence, ...context.evidencePaths])];
    activateReadyDependents(result, request.at);
  }
  if (sourceStatus === "blocked" && request.to === "ready") {
    for (const blocker of result.blockers) {
      if (blocker.task_id === task.id && context.resolvedBlockerIds.includes(blocker.id)) {
        blocker.status = "resolved";
      }
    }
  }
  if (sourceStatus === "awaiting_approval" && (request.to === "running" || request.to === "completed")) {
    const decisionId = context.approvalDecision!.id;
    const decision = result.decisions?.find((candidate) => candidate.id === decisionId);
    if (decision === undefined) {
      throw new SdlcTransitionError(`Task ${task.id} requires persisted decision ${decisionId}`);
    }
    decision.consumed_at = request.at;
    decision.consumed_by_transition = `${task.id}:${sourceStatus}->${request.to}`;
  }

  result.run.updated_at = request.at;
  synchronizeRunState(result);
  return result;
}

function assertTransitionIsLegal(task: Task, request: TransitionRequest, tasks: readonly Task[]): void {
  if (task.status === "completed" || task.status === "cancelled") {
    throw new SdlcTransitionError(`Task ${task.id} is terminal and cannot transition from ${task.status}`);
  }
  if (!allowedTransitions[task.status].includes(request.to)) {
    throw new SdlcTransitionError(`Task ${task.id} cannot transition from ${task.status} to ${request.to}`);
  }
  if (request.reason.trim() === "") {
    throw new SdlcTransitionError(`Task ${task.id} transition requires a reason`);
  }
  if (request.to === "ready") {
    const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    const incomplete = task.dependencies.filter((id) => taskById.get(id)?.status !== "completed");
    if (incomplete.length > 0) {
      throw new SdlcTransitionError(`Task ${task.id} has incomplete dependencies: ${incomplete.join(", ")}`);
    }
  }
}

function assertTransitionConditions(
  task: Task,
  request: TransitionRequest,
  manifest: RunManifest,
  context: TransitionContext,
): void {
  if (task.status === "ready" && request.to === "running") {
    const missing = task.required_inputs.filter((path) => !context.existingInputPaths.includes(path));
    if (missing.length > 0) throw new SdlcTransitionError(`Task ${task.id} is missing required inputs: ${missing.join(", ")}`);
  }

  if (task.status === "awaiting_approval" && (request.to === "running" || request.to === "completed")) {
    const decision = context.approvalDecision === null
      ? null
      : manifest.decisions?.find((candidate) => candidate.id === context.approvalDecision!.id) ?? null;
    const action = `transition:${task.id}:${request.to}`;
    if (decision?.status !== "approved" || decision.action !== action || !decision.affected_tasks.includes(task.id)) {
      throw new SdlcTransitionError(`Task ${task.id} requires an approved decision bound to ${action}`);
    }
    if (!isNonEmpty(decision.approved_by) || !isNonEmpty(decision.decision) || !isNonEmpty(decision.decided_at)) {
      throw new SdlcTransitionError(`Task ${task.id} requires a complete approved decision bound to ${action}`);
    }
    if (decision.consumed_at !== null || decision.consumed_by_transition !== null) {
      throw new SdlcTransitionError(`Task ${task.id} requires an approved decision that has not already been consumed`);
    }
  }
  if (request.to === "awaiting_review") {
    const missing = task.required_outputs.filter((path) => !context.existingOutputPaths.includes(path));
    if (missing.length > 0) {
      throw new SdlcTransitionError(`Task ${task.id} is missing required outputs: ${missing.join(", ")}`);
    }
  }

  if ((request.to === "awaiting_review" || request.to === "completed") && requiresCollectorEvidence(task)) {
    if (context.passedEvidencePaths.length === 0) {
      throw new SdlcTransitionError(`Task ${task.id} requires collector command evidence before ${request.to}`);
    }
  }

  if (request.to === "completed") {
    const missing = task.required_outputs.filter((path) => !context.existingOutputPaths.includes(path));
    if (missing.length > 0) {
      throw new SdlcTransitionError(`Task ${task.id} is missing required outputs: ${missing.join(", ")}`);
    }
  }

  if (request.to === "completed") {
    const qualityGate = qualityGateForTask(task);
    if (qualityGate !== undefined && context.qualityGateStatuses[qualityGate] !== "passed") {
      throw new SdlcTransitionError(`Task ${task.id} requires passed ${qualityGate} quality gate`);
    }
  }

  if (request.to === "failed" && context.evidencePaths.length === 0) {
    throw new SdlcTransitionError(`Task ${task.id} requires failure evidence before it can fail`);
  }

  if (request.to === "blocked") {
    if (context.blocker === null || context.blocker.id.trim() === "") {
      throw new SdlcTransitionError(`Task ${task.id} requires a concrete blocker record before it can be blocked`);
    }
    if (manifest.blockers.some((blocker) => blocker.id === context.blocker!.id)) {
      throw new SdlcTransitionError(`Blocker ${context.blocker.id} already exists`);
    }
  }

  if (task.status === "blocked" && request.to === "ready") {
    const unresolved = manifest.blockers
      .filter((blocker) => blocker.task_id === task.id && blocker.status !== "resolved" && !context.resolvedBlockerIds.includes(blocker.id))
      .map((blocker) => blocker.id);
    if (unresolved.length > 0) {
      throw new SdlcTransitionError(`Task ${task.id} has unresolved blockers: ${unresolved.join(", ")}`);
    }
  }

  if (task.status === "failed" && request.to === "ready") {
    const retryReason = context.retryReasons[task.id];
    if (retryReason === undefined || retryReason.trim() === "") {
      throw new SdlcTransitionError(`Task ${task.id} requires a retry reason before it can become ready`);
    }
  }
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function synchronizeRunState(manifest: RunManifest): void {
  const terminal = new Set<TaskStatus>(["completed", "cancelled"]);
  const exceptional = (["failed", "blocked", "awaiting_approval"] as const)
    .map((status) => manifest.tasks.find((task) => task.status === status))
    .find((task) => task !== undefined);
  const active = exceptional ?? manifest.tasks.find((task) => !terminal.has(task.status));
  if (active === undefined) {
    manifest.run.status = manifest.tasks.every((task) => task.status === "cancelled") ? "cancelled" : "qc";
    manifest.run.current_stage = "qc";
    manifest.run.current_owner = "pm";
    return;
  }
  manifest.run.current_stage = active.stage;
  manifest.run.current_owner = active.role;
  if (active.status === "blocked") manifest.run.status = "blocked";
  else if (active.status === "failed") manifest.run.status = "failed";
  else if (active.status === "awaiting_approval") manifest.run.status = "awaiting_approval";
  else if (active.stage === "intake") manifest.run.status = "intake";
  else if (active.stage === "requirements" || active.stage === "requirements_review") manifest.run.status = "requirements";
  else if (active.stage === "api_contract" || active.stage === "api_contract_review") manifest.run.status = "technical_design";
  else if (active.stage.endsWith("_implementation")) manifest.run.status = "implementation";
  else if (active.stage === "integration") manifest.run.status = "integration";
  else manifest.run.status = "qc";
}

function activateReadyDependents(manifest: RunManifest, at: string): void {
  for (const taskId of findReadyTaskIds(manifest.tasks)) {
    const task = manifest.tasks.find((candidate) => candidate.id === taskId)!;
    task.status = "ready";
    task.transitions.push({
      from: "pending",
      to: "ready",
      actor: "system",
      reason: `Dependencies completed: ${task.dependencies.join(", ")}`,
      at,
    });
  }
}
