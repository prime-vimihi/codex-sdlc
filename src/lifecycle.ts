import { createHash } from "node:crypto";

import { loadProject } from "./config.js";
import { assertEvidenceReference, resolveRunReference } from "./evidence-validation.js";
import { mutateRunManifest } from "./manifest-transaction.js";
import { qualityGateTaskStages } from "./quality-gates.js";
import type { QualityGate, RunManifest, SdlcDecision, TaskStatus } from "./types.js";

type ApprovalTarget = Extract<TaskStatus, "running" | "completed">;
type ApprovalStatus = Extract<SdlcDecision["status"], "approved" | "rejected">;
type ProductOwnerDecision = NonNullable<RunManifest["product_owner_review"]>["decision"];

export async function recordQualityGate(
  root: string,
  runId: string,
  gateId: string,
  status: Exclude<QualityGate["status"], "not_applicable">,
  evidence: readonly string[],
  actor: string,
  reason: string,
  at: string,
): Promise<RunManifest> {
  assertAuditFields(actor, reason, at);
  const references = [...new Set(evidence)];
  const project = await loadProject(root);
  const transaction = await mutateRunManifest(root, runId, async (manifest) => {
    const gate = manifest.quality_gates[gateId];
    if (gate === undefined) throw new Error(`quality gate does not exist: ${gateId}`);
    if (gate.status === "not_applicable") throw new Error(`quality gate is not applicable: ${gateId}`);
    if (status === "passed" && references.length === 0) throw new Error(`passed quality gate requires evidence: ${gateId}`);
    const expectedStage = qualityGateTaskStages[gateId as keyof typeof qualityGateTaskStages];
    for (const reference of references) {
      await resolveRunReference(root, runId, reference);
      if (expectedStage === undefined) continue;
      const record = await assertEvidenceReference({ root, runId, manifest, reference, project, owner: `${gateId} gate`, expectedStage });
      if (status === "passed" && (record.result_status !== "passed" || record.exit_code !== 0)) {
        throw new Error(`failed evidence cannot satisfy ${gateId} quality gate: ${reference}`);
      }
    }
    const audit = { status, evidence: references, actor, reason, at };
    gate.status = status;
    gate.evidence = references;
    gate.history = [...(gate.history ?? []), audit];
    manifest.run.updated_at = at;
  });
  return transaction.manifest;
}

export async function requestApproval(
  root: string,
  runId: string,
  taskId: string,
  target: ApprovalTarget,
  decisionId: string,
  topic: string,
  actor: string,
  at: string,
): Promise<RunManifest> {
  assertAuditFields(actor, topic, at);
  if (!/^DEC-[A-Z0-9-]+$/u.test(decisionId)) throw new Error(`invalid decision ID: ${decisionId}`);
  const transaction = await mutateRunManifest(root, runId, (manifest) => {
    const task = manifest.tasks.find((candidate) => candidate.id === taskId);
    if (task?.status !== "awaiting_approval") throw new Error(`task must be awaiting_approval before requesting a decision: ${taskId}`);
    if ((manifest.decisions ?? []).some((decision) => decision.id === decisionId)) throw new Error(`decision already exists: ${decisionId}`);
    const decision: SdlcDecision = {
      id: decisionId,
      topic,
      status: "pending",
      decision: null,
      requested_by: actor,
      approved_by: null,
      affected_tasks: [taskId],
      action: `transition:${taskId}:${target}`,
      requested_at: at,
      decided_at: null,
      consumed_at: null,
      consumed_by_transition: null,
    };
    manifest.decisions = [...(manifest.decisions ?? []), decision];
    manifest.run.updated_at = at;
  });
  return transaction.manifest;
}

export async function decideApproval(
  root: string,
  runId: string,
  decisionId: string,
  status: ApprovalStatus,
  approver: string,
  decisionText: string,
  at: string,
): Promise<RunManifest> {
  assertAuditFields(approver, decisionText, at);
  const transaction = await mutateRunManifest(root, runId, (manifest) => {
    const decision = manifest.decisions?.find((candidate) => candidate.id === decisionId);
    if (decision === undefined) throw new Error(`decision does not exist: ${decisionId}`);
    if (decision.status !== "pending") throw new Error(`decision is already final: ${decisionId}`);
    decision.status = status;
    decision.approved_by = approver;
    decision.decision = decisionText;
    decision.decided_at = at;
    manifest.run.updated_at = at;
  });
  return transaction.manifest;
}

export async function recordProductOwnerDecision(
  root: string,
  runId: string,
  decision: Exclude<ProductOwnerDecision, null>,
  actor: string,
  comments: string,
  at: string,
): Promise<RunManifest> {
  assertAuditFields(actor, comments, at);
  const transaction = await mutateRunManifest(root, runId, (manifest) => {
    if (manifest.run.status !== "product_owner_review" || manifest.product_owner_review?.status !== "ready" || manifest.final_result?.status !== "ready") {
      throw new Error("run is not ready for a Product Owner decision");
    }
    const accepted = decision === "accepted" || decision === "accepted_with_limitations";
    const deferred = decision === "deferred";
    const historyStatus = productOwnerHistoryStatus(decision);
    manifest.product_owner_review = { status: deferred ? "ready" : "completed", decision, comments, decided_at: at };
    manifest.final_result = {
      ...manifest.final_result,
      status: accepted ? "completed" : deferred ? "ready" : "failed",
      completed_at: accepted || !deferred ? at : null,
    };
    manifest.run.status = accepted ? "completed" : deferred ? "product_owner_review" : "failed";
    if (deferred) manifest.run.current_stage = "product_owner_review";
    manifest.run.updated_at = at;
    manifest.run.current_owner = "product-owner";
    const existing = manifest.decisions?.find((candidate) => candidate.action === "product-owner-review" && candidate.status === "pending");
    if (existing !== undefined) {
      existing.status = historyStatus;
      existing.approved_by = actor;
      existing.decision = comments;
      existing.decided_at = at;
    } else {
      manifest.decisions = [...(manifest.decisions ?? []), productOwnerDecisionRecord(manifest, decision, actor, comments, at, historyStatus)];
    }
  });
  return transaction.manifest;
}

function productOwnerDecisionRecord(
  manifest: RunManifest,
  decision: Exclude<ProductOwnerDecision, null>,
  actor: string,
  comments: string,
  at: string,
  status: SdlcDecision["status"],
): SdlcDecision {
  const digest = createHash("sha256").update(`${manifest.run.id}\u0000${decision}\u0000${at}`).digest("hex").slice(0, 12).toUpperCase();
  return {
    id: `DEC-PO-${digest}`,
    topic: "Product Owner delivery decision",
    status,
    decision: comments,
    requested_by: "pm",
    approved_by: actor,
    affected_tasks: manifest.tasks.map((task) => task.id),
    action: "product-owner-review",
    requested_at: at,
    decided_at: at,
    consumed_at: null,
    consumed_by_transition: null,
  };
}

function productOwnerHistoryStatus(decision: Exclude<ProductOwnerDecision, null>): SdlcDecision["status"] {
  if (decision === "accepted" || decision === "accepted_with_limitations") return "approved";
  if (decision === "deferred") return "deferred";
  return "rejected";
}

function assertAuditFields(actor: string, reason: string, at: string): void {
  if (actor.trim() === "") throw new Error("actor must not be empty");
  if (reason.trim() === "") throw new Error("reason or decision text must not be empty");
  if (!Number.isFinite(Date.parse(at))) throw new Error("audit timestamp must be a valid date-time");
}
