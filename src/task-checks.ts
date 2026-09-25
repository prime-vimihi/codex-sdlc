import { readFile } from "node:fs/promises";
import { executeConfiguredCommand } from "./evidence.js";
import { resolvePathInsideRoot } from "./paths.js";
import { loadRun } from "./runs.js";
import { parseStrictYamlDocument, type DeliveryAssignment } from "./semantic-contracts.js";
import { validateDocument } from "./schemas.js";
import type { EvidenceRecord } from "./types.js";

/** Execute declared checks once in order, stopping at a real failure. Gate approval stays separate. */
export async function collectTaskChecks(root: string, runId: string, taskId: string, commandIds?: string[]) {
  const manifest = await loadRun(root, runId);
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  if (task?.status !== "running") throw new Error("check-task requires a running task");
  let commands = commandIds;
  if (task.role === "backend" || task.role === "frontend") {
    const path = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/tasks/${taskId}.assignment.yaml`, { mustExist: true });
    const value = parseStrictYamlDocument(await readFile(path, "utf8"));
    const valid = validateDocument("deliveryAssignment", value);
    if (!valid.valid) throw new Error(`invalid task assignment: ${valid.diagnostics.join("; ")}`);
    const assignment = value as DeliveryAssignment;
    if (assignment.task_id !== taskId || assignment.run_id !== runId) throw new Error("check assignment identity does not match task");
    const declared = assignment.evidence_requirements.map((requirement) => requirement.command_key);
    if (commands?.some((command) => !declared.includes(command))) throw new Error("check-task commands must be declared by the task assignment");
    commands ??= assignment.evidence_requirements.filter((requirement) => requirement.required).map((requirement) => requirement.command_key);
  }
  if (!commands?.length) throw new Error("check-task requires at least one declared command; use --command for non-delivery tasks");
  if (new Set(commands).size !== commands.length) throw new Error("check-task command IDs must be unique");
  const evidence: EvidenceRecord[] = [];
  for (const [index, command] of commands.entries()) {
    const current = await loadRun(root, runId);
    if (current.tasks.find((entry) => entry.id === taskId)?.status !== "running") throw new Error("task state changed while collecting checks");
    const result = await executeConfiguredCommand(root, runId, taskId, command);
    evidence.push(result);
    if (result.result_status !== "passed") return { task_id: taskId, passed: false, evidence, remaining_commands: commands.slice(index + 1) };
  }
  return { task_id: taskId, passed: true, evidence, remaining_commands: [] as string[] };
}
