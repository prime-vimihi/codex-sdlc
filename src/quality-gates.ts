import type { Task, TaskRole, TaskStage, TaskTarget } from "./types.js";

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

export function requiresCollectorEvidence(task: Task): boolean {
  return taskStageContract(task).collectorEvidence;
}
