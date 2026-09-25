import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";

import { planAgent, recordAgentDispatch, type AgentCapabilities } from "../../src/agents.js";
import { executeConfiguredCommand } from "../../src/evidence.js";
import { initializeProject } from "../../src/install.js";
import { mutateRunManifest } from "../../src/manifest-transaction.js";
import { loadRun, startRun } from "../../src/runs.js";
import { handoffTask, prepareTask, type HandoffTaskInput, type PrepareTaskInput } from "../../src/task-operations.js";
import { prepareTransitionContext, synchronizeRunState, transitionTask } from "../../src/transitions.js";
import type { ProjectConfig } from "../../src/types.js";

const exec = promisify(execFile);
export interface DeliveryFixture {
  root: string;
  runId: string;
  taskId: string;
  appRoot: string;
  input: PrepareTaskInput;
  handoffInput: HandoffTaskInput;
}

/** Fixture starts after a reviewed BA/PM package; only delivery activation/handoff is under test. */
export async function createDeliveryFixture(options: { appRoot?: string; target?: "web" | "mobile" | "backend" } = {}): Promise<DeliveryFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-task-operations-"));
  const target = options.target ?? "web";
  const appRoot = options.appRoot ?? (target === "backend" ? "apps/api" : "apps/platform");
  const runId = "DELIVERY-001";
  const taskId = target === "web" ? "WEB-001" : target === "mobile" ? "MOB-001" : "BE-001";
  await mkdir(resolve(root, appRoot), { recursive: true });
  await writeFile(resolve(root, appRoot, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  await writeFile(resolve(root, appRoot, "feature.cjs"), "module.exports = 'before';\n");
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture baseline"], { cwd: root });
  await initializeProject({ root, projectName: "Task fixture", applications: [target], ...(target === "web" ? { webRoot: appRoot, webPreset: "nextjs" as const } : target === "mobile" ? { mobileRoot: appRoot } : { backendRoot: appRoot }), agents: { roles: { [target === "backend" ? "backend" : "frontend"]: { model: "gpt-6-luna", reasoning_effort: "xhigh" } }, product_owner_review: "disabled" }, dryRun: false });
  const projectPath = resolve(root, ".sdlc/project.yaml");
  const project = parse(await readFile(projectPath, "utf8")) as ProjectConfig;
  project.applications[target]!.lifecycle = "scaffolded";
  project.commands.sdlc_test = { executable: process.execPath, args: ["-e", "if(require('./feature.cjs') !== 'after') process.exit(1)"], cwd: appRoot, network: "disabled", mutates: false };
  await writeFile(projectPath, stringify(project));
  await writeFile(resolve(root, ".sdlc/requests/feature.md"), "REQ-001: Show the updated feature.\n");
  await startRun(root, { id: runId, title: "Update feature", requestFile: ".sdlc/requests/feature.md", affectedApplications: { backend: target === "backend", web: target === "web", mobile: target === "mobile", database: false, sharedPackages: false }, now: new Date().toISOString() });
  const manifest = await loadRun(root, runId);
  for (const task of manifest.tasks.filter((entry) => ["PM-001", "BA-001", "PM-002"].includes(entry.id))) {
    for (const path of task.required_outputs) {
      if (["manifest.yaml", "request.md"].includes(path)) continue;
      const destination = resolve(root, `.sdlc/runs/${runId}`, path);
      await mkdir(dirname(destination), { recursive: true });
      const content = path === "facts.yaml" ? stringify({ schema_version: 1, run_id: runId, producer: "pm", revision: 1, facts: [{ id: "FACT-001", subject: "feature.status", relation: "equals", value: "after", status: "approved" }] })
        : path.endsWith("semantic-claims.yaml") ? stringify({ schema_version: 1, run_id: runId, task_id: "BA-001", producer: "ba", revision: 1, claims: [{ id: "CLAIM-001", fact_ids: ["FACT-001"], subject: "feature.status", relation: "equals", value: "after", status: "approved" }] })
        : `---\nrevision: 1\n---\n# Reviewed fixture requirement\n\n## REQ-001\nShow the updated feature.\n\n## AC-001\nrequirement_id: REQ-001\nExpected status is after.\n`;
      await writeFile(destination, content);
    }
  }
  await mutateRunManifest(root, runId, (current) => {
    const at = new Date().toISOString();
    for (const task of current.tasks.filter((entry) => ["PM-001", "BA-001", "PM-002"].includes(entry.id))) {
      task.status = "completed";
      task.started_at = at;
      task.completed_at = at;
      task.outputs = [...task.required_outputs];
      task.transitions = [{ from: "pending", to: "ready", actor: "system", reason: "Reviewed fixture prerequisites", at }, { from: "ready", to: "running", actor: task.role, reason: "Fixture prerequisite execution", at }, { from: "running", to: "awaiting_review", actor: task.role, reason: "Fixture prerequisite handoff", at }, { from: "awaiting_review", to: "completed", actor: "pm", reason: "Fixture prerequisite review", at }];
    }
    const selected = current.tasks.find((entry) => entry.id === taskId)!;
    selected.status = "ready";
    selected.transitions.push({ from: "pending", to: "ready", actor: "system", reason: "Fixture prerequisites reviewed", at });
    current.quality_gates.requirements!.status = "passed";
    synchronizeRunState(current);
  });
  const input: PrepareTaskInput = target === "backend" ? {
    controls: { mode: "api_contract", api_requirements: ["request", "response", "error", "authentication", "authorization"].map((capability, index) => ({ requirement_id: `REQ-00${index + 1}`, capability, required: true, source_references: [{ kind: "fact", reference: "FACT-001" }] })) as any, storage: { postgresql_role: "durable_truth", redis_roles: [], redis_authoritative: false }, migration: { impact: "none", approval_status: "not_required", decision_id: null } }, commandIds: [],
  } : {
    controls: { api_contract_status: "approved", gaps: [], questions: [], requirements: [{ requirement_id: "REQ-001", capability: "feature_status", required: true, parameters: {}, source_references: [{ kind: "fact", reference: "FACT-001" as any }] }] }, commandIds: ["sdlc_test"],
  };
  return { root, runId, taskId, appRoot, input, handoffInput: { requirementOutcomes: (target === "backend" ? ["request", "response", "error", "authentication", "authorization"] : ["feature_status"]).map((capability, index) => ({ requirement_id: target === "backend" ? `REQ-00${index + 1}` : "REQ-001", capability, status: target === "backend" ? "documented" : "implemented" })), changedFiles: [{ path: `${appRoot}/feature.cjs`, type: "source" }] } };
}

export async function activateFixture(fixture: DeliveryFixture): Promise<void> {
  const { root, runId, taskId } = fixture;
  const capabilities: AgentCapabilities = { source: "test host adapter fixture", model_selection: true, reasoning_selection: true, models: [{ id: "gpt-6-luna", reasoning_efforts: ["xhigh"] }] };
  const plan = await planAgent(root, runId, taskId, capabilities);
  await recordAgentDispatch(root, runId, taskId, { plan, agent_id: "fixture-delivery-agent", actual_model: "gpt-6-luna", actual_reasoning_effort: "xhigh", observation_source: "test host response fixture" }, new Date().toISOString());
  await mutateRunManifest(root, runId, async (manifest) => {
    const request = { taskId, to: "running" as const, actor: plan.role, reason: "Fixture host dispatched the delivery role", at: new Date().toISOString() };
    Object.assign(manifest, transitionTask(manifest, request, await prepareTransitionContext(root, runId, manifest, request)));
  });
}

export async function writeFixtureOutputs(fixture: DeliveryFixture): Promise<void> {
  const { root, runId, taskId, appRoot } = fixture;
  await writeFile(resolve(root, appRoot, "feature.cjs"), "module.exports = 'after';\n");
  const manifest = await loadRun(root, runId);
  for (const path of manifest.tasks.find((entry) => entry.id === taskId)!.required_outputs.filter((path) => !path.endsWith("delivery-report.yaml"))) {
    const destination = resolve(root, `.sdlc/runs/${runId}`, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, path.endsWith("openapi.yaml") ? stringify({ openapi: "3.1.0", info: { title: "Fixture API", version: "1.0.0" }, paths: {}, "x-sdlc-metadata": { schema_version: 1, run_id: runId, task_id: taskId, producer: "backend", revision: 1 } }) : "---\nrevision: 1\n---\n# Implementation evidence\n\nREQ-001: Updated the feature status and verified the result.\n");
  }
}

export async function collectFixtureEvidence(fixture: DeliveryFixture): Promise<void> {
  const project = parse(await readFile(resolve(fixture.root, ".sdlc/project.yaml"), "utf8")) as ProjectConfig;
  const variable = project.security.network_policy_attestation_environment;
  const previous = process.env[variable];
  process.env[variable] = "disabled";
  try { await executeConfiguredCommand(fixture.root, fixture.runId, fixture.taskId, "sdlc_test"); }
  finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
}

export async function activateAndHandoffFixture(fixture: DeliveryFixture) {
  await prepareTask(fixture.root, fixture.runId, fixture.taskId, fixture.input);
  await activateFixture(fixture);
  await writeFixtureOutputs(fixture);
  await collectFixtureEvidence(fixture);
  return handoffTask(fixture.root, fixture.runId, fixture.taskId, fixture.handoffInput);
}
