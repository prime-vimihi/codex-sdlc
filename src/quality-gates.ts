import type { RunManifest, Task, TaskRole, TaskStage, TaskTarget } from "./types.js";
import { isCompactRun } from "./workflow-profile.js";

interface TaskStageContract {
  role: TaskRole;
  target: TaskTarget;
  qualityGate?: string;
  collectorEvidence: boolean;
}

export const taskStageContracts = {
  intake: { role: "pm", target: null, collectorEvidence: false },
  requirements: { role: "ba", target: null, qualityGate: "requirements", collectorEvidence: false },
  requirements_review: { role: "pm", target: null, collectorEvidence: false },
  api_contract: { role: "backend", target: "backend", qualityGate: "api_contract", collectorEvidence: false },
  api_contract_review: { role: "pm", target: null, collectorEvidence: false },
  backend_implementation: { role: "backend", target: "backend", qualityGate: "backend", collectorEvidence: true },
  web_implementation: { role: "frontend", target: "web", qualityGate: "web", collectorEvidence: true },
  mobile_implementation: { role: "frontend", target: "mobile", qualityGate: "mobile", collectorEvidence: true },
  integration: { role: "pm", target: "integration", qualityGate: "integration", collectorEvidence: true },
  qc: { role: "qc", target: "qc", qualityGate: "qc", collectorEvidence: false },
  product_owner_advisory: { role: "po", target: null, collectorEvidence: false },
  product_owner_review: { role: "pm", target: null, collectorEvidence: false },
} as const satisfies Record<TaskStage, TaskStageContract>;

export const qualityGateTaskStages = {
  requirements: "requirements",
  api_contract: "api_contract",
  backend: "backend_implementation",
  web: "web_implementation",
  mobile: "mobile_implementation",
  integration: "integration",
  qc: "qc",
} as const satisfies Record<string, TaskStage>;

export function taskStageContract(task: Task): TaskStageContract {
  const contract = taskStageContracts[task.stage];
  if (contract === undefined || task.role !== contract.role || task.target !== contract.target) {
    throw new Error(`Task ${task.id} does not match its ${String(task.stage)} stage contract`);
  }
  return contract;
}

export function qualityGateForTask(task: Task): string | undefined {
  return taskStageContract(task).qualityGate;
}

export function qualityGatesForTask(task: Task, manifest?: RunManifest): string[] {
  if (manifest !== undefined && isCompactRun(manifest) && task.id === "QC-001") return ["integration", "qc"];
  const gate = qualityGateForTask(task);
  return gate === undefined ? [] : [gate];
}

export function qualityGateStage(gateId: string, manifest?: RunManifest): TaskStage | undefined {
  if (manifest !== undefined && isCompactRun(manifest)) {
    if (gateId === "requirements") return undefined;
    if (gateId === "integration") return "qc";
  }
  return qualityGateTaskStages[gateId as keyof typeof qualityGateTaskStages];
}

export function requiresCollectorEvidence(task: Task, manifest?: RunManifest): boolean {
  return taskStageContract(task).collectorEvidence || (manifest !== undefined && isCompactRun(manifest) && task.id === "QC-001");
}
