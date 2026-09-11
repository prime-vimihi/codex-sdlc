import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { loadProject } from "./config.js";
import { mutateRunManifest } from "./manifest-transaction.js";
import { resolvePathInsideRoot } from "./paths.js";
import { loadRun } from "./runs.js";
import { validateDocument } from "./schemas.js";
import { SdlcValidationError, type RunManifest, type Task, type TaskRole } from "./types.js";

export const agentRoles = ["pm", "ba", "backend", "frontend", "qc", "po"] as const;
export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];

export interface ModelSelection {
  model: string;
  reasoning_effort?: ReasoningEffort;
}

export interface RoleModel extends ModelSelection {
  fallbacks?: ModelSelection[];
}

export interface AgentPolicy {
  roles: Partial<Record<TaskRole, RoleModel>>;
  product_owner_review: "disabled" | "advisory";
}

/** Observations supplied by the Codex host adapter, not a bundled model catalog. */
export interface AgentCapabilities {
  source: string;
  model_selection: boolean;
  reasoning_selection: boolean;
  omitted_reasoning_effort?: "model-default" | "inherit-parent" | "unknown";
  parent_reasoning_effort?: ReasoningEffort;
  models: Array<{ id: string; reasoning_efforts: ReasoningEffort[]; default_reasoning_effort?: ReasoningEffort }>;
}

export interface AgentPlan {
  schema_version: 1;
  run_id: string;
  task_id: string;
  role: TaskRole;
  task_revision: number;
  activation: number;
  policy_sha256: string;
  requested: ModelSelection | null;
  selected: ModelSelection | null;
  fallback_used: boolean;
  skill: string;
  execution: "spawn";
  context: "task-only";
  capabilities: AgentCapabilities;
}

export interface AgentDispatchInput {
  plan: AgentPlan;
  agent_id: string;
  actual_model: string | null;
  actual_reasoning_effort: ReasoningEffort | null;
  observation_source: string | null;
}

export interface AgentDispatch extends AgentDispatchInput {
  recorded_at: string;
}

export function assertAgentPolicy(value: unknown): asserts value is AgentPolicy {
  assertSchema("agentPolicy", value);
  const policy = value as AgentPolicy;
  if (policy.roles.po !== undefined && policy.product_owner_review !== "advisory") {
    throw new Error("the po model requires advisory Product Owner review");
  }
  for (const [role, settings] of Object.entries(policy.roles)) {
    const selections = [primarySelection(settings), ...(settings.fallbacks ?? [])].map(stableJson);
    if (new Set(selections).size !== selections.length) throw new Error(`duplicate model/effort selection for ${role}`);
  }
}

export function agentPolicyDiagnostics(value: unknown): string[] {
  try { assertAgentPolicy(value); return []; } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export interface ConfigureAgentsOptions {
  root: string;
  models?: string[];
  reasoning?: string[];
  fallbacks?: string[];
  resetRoles?: string[];
  productOwnerReview?: string;
  dryRun?: boolean;
}

/** A model replacement clears the old effort/fallbacks, which may be incompatible. */
export function updateAgentPolicy(current: AgentPolicy | undefined, options: Omit<ConfigureAgentsOptions, "root">): AgentPolicy {
  const result: AgentPolicy = structuredClone(current ?? { roles: {}, product_owner_review: "disabled" });
  const resets = (options.resetRoles ?? []).map(parseRole);
  if (new Set(resets).size !== resets.length) throw new Error("duplicate reset role");
  for (const role of resets) delete result.roles[role];
  for (const [role, model] of roleValues(options.models ?? [], "model")) result.roles[role] = { model };
  for (const [role, effort] of roleValues(options.reasoning ?? [], "reasoning effort")) {
    const settings = result.roles[role];
    if (settings === undefined) throw new Error(`configure a model before a reasoning effort for ${role}`);
    settings.reasoning_effort = effort as ReasoningEffort;
  }
  for (const [role, value] of roleValues(options.fallbacks ?? [], "fallback")) {
    const settings = result.roles[role];
    if (settings === undefined) throw new Error(`configure a model before a fallback for ${role}`);
    const [model, effort, extra] = value.split(":");
    if (extra !== undefined || effort === "") throw new Error(`fallback must be role=model[:effort]: ${role}=${value}`);
    settings.fallbacks = model === "none" ? [] : [{ model, ...(effort === undefined ? {} : { reasoning_effort: effort as ReasoningEffort }) }];
  }
  if (options.productOwnerReview !== undefined) {
    if (!["disabled", "advisory"].includes(options.productOwnerReview)) throw new Error("--po-review must be disabled or advisory");
    result.product_owner_review = options.productOwnerReview as AgentPolicy["product_owner_review"];
  } else if (result.roles.po !== undefined) result.product_owner_review = "advisory";
  assertAgentPolicy(result);
  return result;
}

export async function configureAgents(options: ConfigureAgentsOptions) {
  const root = resolve(options.root);
  const project = await loadProject(root);
  const agents = updateAgentPolicy(project.agents, options);
  const path = await resolvePathInsideRoot(root, ".sdlc/project.yaml", { mustExist: true });
  const source = await readFile(path, "utf8");
  const document = parseDocument(source);
  document.set("agents", agents);
  assertSchema("project", document.toJS());
  if (!options.dryRun) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, document.toString(), { encoding: "utf8", flag: "wx" });
      if (await readFile(path, "utf8") !== source) throw new Error("project.yaml changed during agent configuration; retry against the current file");
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  return { root, dry_run: options.dryRun ?? false, file: ".sdlc/project.yaml", agents, applies_to: "new runs" };
}

export async function planAgent(root: string, runId: string, taskId: string, capabilities: AgentCapabilities): Promise<AgentPlan> {
  return resolveAgentPlan(await loadRun(root, runId), taskId, capabilities);
}

export function resolveAgentPlan(manifest: RunManifest, taskId: string, capabilities: AgentCapabilities): AgentPlan {
  assertSchema("agentCapabilities", capabilities);
  if (new Set(capabilities.models.map((model) => model.id)).size !== capabilities.models.length) throw new Error("host capabilities contain duplicate model IDs");
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error(`unknown task: ${taskId}`);
  const policy = manifest.agent_policy ?? { roles: {}, product_owner_review: "disabled" };
  assertAgentPolicy(policy);
  const settings = policy.roles[task.role];
  const requested = settings === undefined ? null : primarySelection(settings);
  let selected: ModelSelection | null = null;
  let fallbackUsed = false;
  if (settings !== undefined) {
    if (!capabilities.model_selection) throw new Error(`host cannot select the configured model for ${task.role}; use a host with model-selectable subagents`);
    for (const [index, candidate] of [primarySelection(settings), ...(settings.fallbacks ?? [])].entries()) {
      const resolved = compatibleSelection(candidate, capabilities);
      if (resolved !== null) { selected = resolved; fallbackUsed = index > 0; break; }
    }
    if (selected === null) throw new Error(`no available model/effort matches ${task.role}; requested ${settings.model}. No implicit fallback is allowed. Configure an explicit effort if the host's inherited effort is unknown or incompatible`);
  }
  return {
    schema_version: 1, run_id: manifest.run.id, task_id: task.id, role: task.role,
    task_revision: task.transitions.length, activation: activation(task),
    policy_sha256: createHash("sha256").update(stableJson(policy)).digest("hex"),
    requested, selected, fallback_used: fallbackUsed,
    skill: `sdlc-${task.role}`, execution: "spawn", context: "task-only", capabilities: structuredClone(capabilities),
  };
}

function compatibleSelection(candidate: ModelSelection, capabilities: AgentCapabilities): ModelSelection | null {
  const model = capabilities.models.find((entry) => entry.id === candidate.model);
  if (model === undefined) return null;
  if (candidate.reasoning_effort !== undefined) {
    return capabilities.reasoning_selection && model.reasoning_efforts.includes(candidate.reasoning_effort) ? candidate : null;
  }
  if (capabilities.omitted_reasoning_effort === "model-default") return candidate;
  // An explicit host-advertised default avoids incompatible inheritance on hosts
  // whose tool semantics differ from Codex's model-default behavior.
  if (capabilities.reasoning_selection && model.default_reasoning_effort !== undefined
    && model.reasoning_efforts.includes(model.default_reasoning_effort)) {
    return { ...candidate, reasoning_effort: model.default_reasoning_effort };
  }
  if (capabilities.omitted_reasoning_effort === "inherit-parent" && capabilities.parent_reasoning_effort !== undefined
    && model.reasoning_efforts.includes(capabilities.parent_reasoning_effort)) return candidate;
  return null;
}

/** Record only after the host has returned a real agent ID. Never launches an LLM. */
export async function recordAgentDispatch(root: string, runId: string, taskId: string, input: AgentDispatchInput, at: string): Promise<AgentDispatch> {
  const record: AgentDispatch = { ...input, recorded_at: at };
  assertSchema("agentDispatch", record);
  const transaction = await mutateRunManifest(root, runId, (manifest) => {
    const plan = resolveAgentPlan(manifest, taskId, input.plan.capabilities);
    if (stableJson(plan) !== stableJson(input.plan)) throw new Error("agent plan is stale or does not match this run/task policy; plan again");
    const task = manifest.tasks.find((candidate) => candidate.id === taskId)!;
    if (!["ready", "running", "awaiting_review"].includes(task.status)) throw new Error(`cannot dispatch task ${taskId} while ${task.status}`);
    assertObservedSelection(record);
    task.agent_dispatches = [...(task.agent_dispatches ?? []), record];
    manifest.run.updated_at = at;
    return record;
  });
  return transaction.value;
}

export function assertTaskAgentDispatch(manifest: RunManifest, task: Task): void {
  if (manifest.agent_policy?.roles[task.role] === undefined) return;
  const record = task.agent_dispatches?.at(-1);
  if (record === undefined || record.plan.activation !== activation(task)) {
    throw new Error(`Task ${task.id} requires a recorded agent dispatch for its configured model before execution`);
  }
  const expected = resolveAgentPlan(manifest, task.id, record.plan.capabilities);
  if (stableJson({ ...record.plan, task_revision: expected.task_revision }) !== stableJson(expected)) {
    throw new Error(`Task ${task.id} agent dispatch does not match the run's model policy`);
  }
  assertObservedSelection(record);
}

function assertObservedSelection(record: AgentDispatch): void {
  if ((record.actual_model !== null || record.actual_reasoning_effort !== null) && !record.observation_source?.trim()) {
    throw new Error("an actual model/effort requires a host observation source; leave unreported values null");
  }
  if (record.actual_model !== null && record.plan.selected !== null && record.actual_model !== record.plan.selected.model) {
    throw new Error("host-reported actual model differs from the selected model");
  }
  if (record.actual_reasoning_effort !== null && record.plan.selected?.reasoning_effort !== undefined
    && record.actual_reasoning_effort !== record.plan.selected.reasoning_effort) {
    throw new Error("host-reported actual reasoning effort differs from the selected effort");
  }
}

function activation(task: Task): number { return task.transitions.filter((entry) => entry.to === "ready").length; }
function primarySelection(settings: RoleModel): ModelSelection {
  return { model: settings.model, ...(settings.reasoning_effort === undefined ? {} : { reasoning_effort: settings.reasoning_effort }) };
}
function parseRole(value: string): TaskRole {
  if (!agentRoles.includes(value as TaskRole)) throw new Error(`unknown agent role ${value}; choose ${agentRoles.join(", ")}`);
  return value as TaskRole;
}
function roleValues(values: string[], label: string): Array<[TaskRole, string]> {
  const seen = new Set<TaskRole>();
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new Error(`${label} must use role=value: ${value}`);
    const role = parseRole(value.slice(0, separator));
    if (seen.has(role)) throw new Error(`duplicate ${label} for ${role}`);
    seen.add(role);
    return [role, value.slice(separator + 1)];
  });
}
function assertSchema(name: Parameters<typeof validateDocument>[0], value: unknown): void {
  const result = validateDocument(name, value);
  if (!result.valid) throw new SdlcValidationError(result.diagnostics);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
