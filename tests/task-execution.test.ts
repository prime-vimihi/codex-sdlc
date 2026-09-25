import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { planAgent, type AgentCapabilities, type AgentDispatchInput } from "../src/agents.js";
import { validateCliArguments } from "../src/cli-grammar.js";
import { initializeProject } from "../src/install.js";
import { loadRun, startRun } from "../src/runs.js";
import { activateTask } from "../src/task-activation.js";
import { collectTaskChecks } from "../src/task-checks.js";
import { prepareTask } from "../src/task-operations.js";
import type { ProjectConfig } from "../src/types.js";
import { createDeliveryFixture } from "./helpers/delivery-fixture.js";

const roots: string[] = [];
const capabilities: AgentCapabilities = { source: "independent fixture host response", model_selection: true, reasoning_selection: true, models: [{ id: "gpt-6-luna", reasoning_efforts: ["xhigh"] }] };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function dispatch(root: string, runId: string, taskId: string): Promise<AgentDispatchInput> {
  const plan = await planAgent(root, runId, taskId, capabilities);
  return { plan, agent_id: "execution-fixture-agent", actual_model: plan.selected?.model ?? null, actual_reasoning_effort: plan.selected?.reasoning_effort ?? null, observation_source: "independent fixture host response" };
}
async function intake() {
  const root = await mkdtemp(resolve(tmpdir(), "sdlc-execution-")); roots.push(root);
  await mkdir(resolve(root, "web"));
  await initializeProject({ root, projectName: "Execution", applications: ["web"], webRoot: "web", agents: { roles: { pm: { model: "gpt-6-luna", reasoning_effort: "xhigh" } }, product_owner_review: "disabled" }, dryRun: false });
  await writeFile(resolve(root, ".sdlc/requests/request.md"), "Verify execution helpers");
  const runId = "EXECUTION-001", taskId = "PM-001";
  await startRun(root, { id: runId, title: "Execution helpers", requestFile: ".sdlc/requests/request.md", affectedApplications: { backend: false, web: true, mobile: false, database: false, sharedPackages: false }, now: new Date().toISOString() });
  return { root, runId, taskId };
}
async function delivery() { const result = await createDeliveryFixture(); roots.push(result.root); return result; }
async function configureChecks(root: string, cwd: string, failed?: string) {
  const path = resolve(root, ".sdlc/project.yaml");
  const project = parse(await readFile(path, "utf8")) as ProjectConfig;
  for (const id of ["sdlc_test", "sdlc_typecheck", "web_build", "web_test"]) project.commands[id] = { executable: process.execPath, args: ["-e", `require('node:fs').appendFileSync('order.txt','${id}\\n');process.exit(${id === failed ? 3 : 0})`], cwd, network: "disabled", mutates: true };
  await writeFile(path, stringify(project));
  return project.security.network_policy_attestation_environment;
}
async function checks(root: string, runId: string, taskId: string, commands?: string[]) {
  const variable = (parse(await readFile(resolve(root, ".sdlc/project.yaml"), "utf8")) as ProjectConfig).security.network_policy_attestation_environment;
  const previous = process.env[variable]; process.env[variable] = "disabled";
  try { return await collectTaskChecks(root, runId, taskId, commands); }
  finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
}
async function runningDelivery(failed?: string) {
  const value = await delivery(); await configureChecks(value.root, value.appRoot, failed);
  await prepareTask(value.root, value.runId, value.taskId, { ...value.input, commandIds: ["sdlc_test", "sdlc_typecheck", "web_build"] });
  await activateTask(value.root, value.runId, value.taskId, await dispatch(value.root, value.runId, value.taskId), "Start declared delivery checks");
  return value;
}
async function manifestBytes(value: {root:string;runId:string}) { return readFile(resolve(value.root, `.sdlc/runs/${value.runId}/manifest.yaml`), "utf8"); }

describe("audited activation", () => {
  test("records and starts once, then retry leaves dispatch and transitions unchanged", async () => {
    const value = await intake(), input = await dispatch(value.root, value.runId, value.taskId);
    expect(await activateTask(value.root, value.runId, value.taskId, input, "Start requested intake")).toMatchObject({ status: "running", already_active: false });
    const before = await manifestBytes(value);
    expect(await activateTask(value.root, value.runId, value.taskId, input, "Retry interrupted client")).toMatchObject({ status: "running", already_active: true });
    expect(await manifestBytes(value)).toBe(before);
    const task = (await loadRun(value.root, value.runId)).tasks.find((task) => task.id === value.taskId)!;
    expect(task.agent_dispatches).toHaveLength(1);
    expect(task.transitions.filter((transition) => transition.to === "running")).toHaveLength(1);
    await expect(activateTask(value.root, value.runId, value.taskId, { ...input, agent_id: "different-agent" }, "Conflicting launch")).rejects.toThrow("ready task");
  });
  test("rejects wrong task/run, stale plans, empty host IDs, and blank reasons before mutation", async () => {
    const value = await intake(), input = await dispatch(value.root, value.runId, value.taskId), before = await manifestBytes(value);
    for (const changed of [
      { ...input, agent_id: "" },
      { ...input, plan: { ...input.plan, task_id: "BA-001" } },
      { ...input, plan: { ...input.plan, run_id: "OTHER-001" } },
      { ...input, plan: { ...input.plan, task_revision: input.plan.task_revision + 1 } },
      { ...input, actual_model: "gpt-6-astra" },
    ]) {
      await expect(activateTask(value.root, value.runId, value.taskId, changed, "Invalid activation")).rejects.toThrow();
      expect(await manifestBytes(value)).toBe(before);
    }
    await expect(activateTask(value.root, value.runId, value.taskId, input, " ")).rejects.toThrow("reason");
    await expect(activateTask(value.root, value.runId, "UNKNOWN-001", input, "Invalid task")).rejects.toThrow("unknown task");
  });
  test("failed start cannot leave task running and retry works after prerequisites are prepared", async () => {
    const value = await delivery(), input = await dispatch(value.root, value.runId, value.taskId);
    await expect(activateTask(value.root, value.runId, value.taskId, input, "Attempt unprepared task")).rejects.toThrow();
    expect((await loadRun(value.root, value.runId)).tasks.find((task) => task.id === value.taskId)?.status).toBe("ready");
    await prepareTask(value.root, value.runId, value.taskId, value.input);
    const fresh = await dispatch(value.root, value.runId, value.taskId);
    expect(await activateTask(value.root, value.runId, value.taskId, fresh, "Prepared task may start")).toMatchObject({ status: "running", already_active: false });
  });
});

describe("declared check collection", () => {
  test("runs required delivery checks in assignment order without completing or approving the task", async () => {
    const value = await runningDelivery();
    const before = await loadRun(value.root, value.runId);
    const result = await checks(value.root, value.runId, value.taskId);
    expect(result.passed).toBe(true); expect(result.evidence.map((record) => record.command_id)).toEqual(["sdlc_test", "sdlc_typecheck", "web_build"]);
    expect(await readFile(resolve(value.root, value.appRoot, "order.txt"), "utf8")).toBe("sdlc_test\nsdlc_typecheck\nweb_build\n");
    const after = await loadRun(value.root, value.runId);
    expect(after.tasks.find((task) => task.id === value.taskId)?.status).toBe("running");
    expect(after.quality_gates).toEqual(before.quality_gates);
  });
  test("stops immediately on failure and reports unexecuted remaining commands", async () => {
    const value = await runningDelivery("sdlc_typecheck");
    const result = await checks(value.root, value.runId, value.taskId);
    expect(result.passed).toBe(false); expect(result.remaining_commands).toEqual(["web_build"]);
    expect(result.evidence.map((record) => record.result_status)).toEqual(["passed", "failed"]);
    expect(await readFile(resolve(value.root, value.appRoot, "order.txt"), "utf8")).toBe("sdlc_test\nsdlc_typecheck\n");
  });
  test("rejects an available but undeclared override and duplicate command IDs before execution", async () => {
    const value = await runningDelivery(), before = await manifestBytes(value);
    for (const commandIds of [["web_test"], ["sdlc_test", "sdlc_test"]]) await expect(checks(value.root, value.runId, value.taskId, commandIds)).rejects.toThrow();
    expect(await manifestBytes(value)).toBe(before);
    await expect(readFile(resolve(value.root, value.appRoot, "order.txt"))).rejects.toThrow();
  });
  test("non-delivery tasks require explicit configured commands and a running state", async () => {
    const value = await intake(); await configureChecks(value.root, "web");
    await expect(checks(value.root, value.runId, value.taskId, ["sdlc_test"])).rejects.toThrow("running");
    await activateTask(value.root, value.runId, value.taskId, await dispatch(value.root, value.runId, value.taskId), "Start intake checks");
    await expect(checks(value.root, value.runId, value.taskId)).rejects.toThrow("at least one");
    await expect(checks(value.root, value.runId, value.taskId, ["undeclared"])).rejects.toThrow("unknown configured command");
    expect((await checks(value.root, value.runId, value.taskId, ["web_build", "sdlc_test"])).evidence.map((record) => record.command_id)).toEqual(["web_build", "sdlc_test"]);
  });
  test("CLI grammar accepts execution commands and rejects invented automatic approval flags", () => {
    expect(validateCliArguments(["activate-task", "EXECUTION-001", "PM-001", "--reason", "Start intake", "--json"])).toEqual([]);
    expect(validateCliArguments(["check-task", "EXECUTION-001", "PM-001", "--command", "sdlc_test", "--command", "sdlc_typecheck", "--json"])).toEqual([]);
    expect(validateCliArguments(["activate-task", "EXECUTION-001", "PM-001"])).not.toEqual([]);
    expect(validateCliArguments(["check-task", "EXECUTION-001", "PM-001", "--approve"])).not.toEqual([]);
  });
});
