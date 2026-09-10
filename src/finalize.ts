import { createHash } from "node:crypto";

import { loadProject } from "./config.js";
import { assertEvidenceReference, resolveRunReference } from "./evidence-validation.js";
import { mutateRunManifest } from "./manifest-transaction.js";
import { qualityGateTaskStages } from "./quality-gates.js";
import type { RunManifest } from "./types.js";

const alwaysRequiredGates = ["requirements", "integration", "qc"] as const;

export async function finalizeRun(root: string, runId: string, actor: string, now: string): Promise<RunManifest> {
  const transaction = await mutateRunManifest(root, runId, async (manifest) => {
    normalizeLegacyInapplicableGates(manifest);
    assertReadyForProductOwnerReview(manifest);
    await assertReferencedFilesExist(root, runId, manifest);
    await assertEvidencePassed(root, runId, manifest);

    const review = manifest.product_owner_review;
    if (review === undefined || review.status !== "pending" || review.decision !== null) {
      throw new Error("Product Owner review is not pending and cannot be prepared again");
    }
    manifest.run.status = "product_owner_review";
    manifest.run.current_stage = "product_owner_review";
    manifest.run.current_owner = "product-owner";
    manifest.run.updated_at = now;
    manifest.product_owner_review = { ...review, status: "ready" };
    if (manifest.final_result === undefined) {
      throw new Error("final result is required before finalization");
    }
    manifest.final_result = { ...manifest.final_result, status: "ready", completed_at: null };
    manifest.decisions = [...(manifest.decisions ?? []), {
      id: nextDecisionId(manifest, now),
      topic: "Product Owner delivery package",
      status: "pending",
      decision: "Delivery package prepared for Product Owner review",
      requested_by: actor,
      approved_by: null,
      affected_tasks: manifest.tasks.map((task) => task.id),
      action: "product-owner-review",
      requested_at: now,
      decided_at: null,
      consumed_at: null,
      consumed_by_transition: null,
      transition: { from: "qc", to: "product_owner_review", actor, at: now },
    }];
  });
  return transaction.manifest;
}

function normalizeLegacyInapplicableGates(manifest: RunManifest): void {
  if (!manifest.affected_applications?.backend && manifest.quality_gates.api_contract?.status === "pending") {
    manifest.quality_gates.api_contract = {
      ...manifest.quality_gates.api_contract,
      status: "not_applicable",
    };
  }
}

function assertReadyForProductOwnerReview(manifest: RunManifest): void {
  if (manifest.run.status !== "qc" || manifest.run.current_stage !== "qc") {
    if (["failed", "cancelled", "completed", "product_owner_review"].includes(manifest.run.status)) {
      throw new Error("run is not eligible for Product Owner review because it is terminal");
    }
    throw new Error("run is not at the expected qc stage for Product Owner review");
  }
  if (manifest.product_owner_review?.status !== "pending" || manifest.product_owner_review.decision !== null) {
    throw new Error("Product Owner review is not pending");
  }
  if (manifest.final_result?.status !== "pending") {
    throw new Error("final result is not pending");
  }
  for (const task of manifest.tasks) {
    if (task.status !== "completed") {
      throw new Error(`mandatory task is incomplete: ${task.id}`);
    }
  }
  const requiredGates = new Set<string>(alwaysRequiredGates);
  if (manifest.affected_applications?.backend) {
    requiredGates.add("api_contract");
    requiredGates.add("backend");
  }
  if (manifest.affected_applications?.web) requiredGates.add("web");
  if (manifest.affected_applications?.mobile) requiredGates.add("mobile");
  for (const gateId of requiredGates) {
    const gate = manifest.quality_gates[gateId];
    if (gate?.status !== "passed") {
      throw new Error(`${gateId} quality gate must pass before finalization`);
    }
    if (gate.evidence.length === 0) throw new Error(`${gateId} quality gate requires evidence`);
  }
  for (const [application, gateId] of [["backend", "backend"], ["web", "web"], ["mobile", "mobile"]] as const) {
    if (!manifest.affected_applications?.[application] && manifest.quality_gates[gateId]?.status !== "not_applicable") {
      throw new Error(`${gateId} quality gate must be not_applicable when ${application} is unaffected`);
    }
  }
  if (!manifest.affected_applications?.backend && manifest.quality_gates.api_contract?.status !== "not_applicable") {
    throw new Error("api_contract quality gate must be not_applicable when backend is unaffected");
  }
  const blocker = manifest.blockers.find((candidate) => candidate.status === "open");
  if (blocker !== undefined || (manifest.defects?.blocker ?? 0) > 0) {
    throw new Error("blocker defects remain open");
  }
  if ((manifest.defects?.critical ?? 0) > 0) {
    throw new Error("critical defects remain open");
  }
}

async function assertReferencedFilesExist(root: string, runId: string, manifest: RunManifest): Promise<void> {
  for (const task of manifest.tasks) {
    for (const path of [...task.required_outputs, ...task.outputs, ...task.evidence]) {
      try {
        await runFilePath(root, runId, path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = task.evidence.includes(path) ? "evidence" : "required output";
        throw new Error(`${category} is missing or unsafe for ${task.id}: ${path}; ${message}`);
      }
    }
  }
  if (manifest.final_result === undefined) {
    throw new Error("final result is required before finalization");
  }
  try {
    await runFilePath(root, runId, manifest.final_result.report);
  } catch (error) {
    throw new Error(`required output is missing: ${manifest.final_result.report}; ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [gateId, gate] of Object.entries(manifest.quality_gates)) {
    for (const reference of gate.evidence) {
      try {
        await runFilePath(root, runId, reference);
      } catch (error) {
        throw new Error(`evidence is missing or unsafe for ${gateId} gate: ${reference}; ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function assertEvidencePassed(root: string, runId: string, manifest: RunManifest): Promise<void> {
  const project = await loadProject(root);
  for (const task of manifest.tasks) {
    for (const reference of task.evidence) {
      await assertEvidenceReference({
        root,
        runId,
        manifest,
        reference,
        project,
        owner: task.id,
        expectedTask: task,
      });
    }
  }
  for (const [gateId, gate] of Object.entries(manifest.quality_gates)) {
    const expectedStage = qualityGateTaskStages[gateId as keyof typeof qualityGateTaskStages];
    if (expectedStage === undefined) continue;
    for (const reference of gate.evidence) {
      const evidence = await assertEvidenceReference({
        root,
        runId,
        manifest,
        reference,
        project,
        owner: `${gateId} gate`,
        expectedStage,
      });
      if (evidence.result_status !== "passed" || evidence.exit_code !== 0) {
        throw new Error(`failed evidence cannot satisfy a required gate: ${reference}`);
      }
    }
  }
}

async function runFilePath(root: string, runId: string, reference: string): Promise<string> {
  return resolveRunReference(root, runId, reference);
}

function nextDecisionId(manifest: RunManifest, now: string): string {
  const base = `DEC-FINALIZE-${createHash("sha256").update(now).digest("hex").slice(0, 10)}`;
  const existing = new Set((manifest.decisions ?? []).map((decision) => decision.id));
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}
