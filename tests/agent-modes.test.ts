import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { configureAgents, resolveAgentPlan, updateAgentPolicy, type AgentCapabilities, type AgentPolicy, type ConfigureAgentsOptions } from "../src/agents.js";
import { main } from "../src/cli.js";
import { validateCliArguments } from "../src/cli-grammar.js";
import { loadProject } from "../src/config.js";
import { initializeProject } from "../src/install.js";
import { loadRun, startRun } from "../src/runs.js";

const roots: string[] = [];
const savedRoles: AgentPolicy["roles"] = {
  ba: { model: "gpt-6.1-sol", reasoning_effort: "high" },
  backend: { model: "gpt-6-luna", reasoning_effort: "xhigh" },
  frontend: { model: "gpt-6-luna", reasoning_effort: "xhigh" },
  qc: { model: "gpt-6-luna", reasoning_effort: "xhigh" },
};
const capabilities: AgentCapabilities = {
  source: "test host capability fixture; no live host dispatch",
  model_selection: true,
  reasoning_selection: true,
  models: [
    { id: "gpt-6.1-sol", reasoning_efforts: ["high"] },
    { id: "gpt-6-luna", reasoning_efforts: ["xhigh"] },
  ],
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(agents?: AgentPolicy): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-modes-"));
  roots.push(root);
  await Promise.all(["backend", "web", "mobile"].map((name) => mkdir(resolve(root, name))));
  await initializeProject({ root, projectName: "Modes", applications: ["backend", "web", "mobile"], backendRoot: "backend", webRoot: "web", mobileRoot: "mobile", agents, dryRun: false });
  await writeFile(resolve(root, ".sdlc/requests/request.md"), "Deliver the feature across backend, web, and mobile.\n");
  return root;
}

async function run(root: string, id: string) {
  await startRun(root, { id, title: "Model preset", requestFile: ".sdlc/requests/request.md", affectedApplications: { backend: true, web: true, mobile: true, database: false, sharedPackages: false }, now: "2026-09-24T08:00:00.000Z" });
  return loadRun(root, id);
}

async function cli(root: string, ...options: string[]) {
  const chunks: string[] = [];
  const previousExitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  try {
    const code = await main(["configure-agents", "--root", root, ...options, "--json"]);
    return { code, payload: JSON.parse(chunks.join("")) };
  } finally {
    output.mockRestore();
    process.exitCode = previousExitCode;
  }
}

describe("project model presets", () => {
  test("CLI saves both presets idempotently, clearing old settings while preserving PO and project content", async () => {
    const original = updateAgentPolicy(undefined, {
      models: ["pm=gpt-6-astra", "ba=gpt-6-astra", "backend=gpt-6-astra", "frontend=gpt-6-astra", "qc=gpt-6-astra", "po=gpt-6-astra"],
      reasoning: ["pm=ultra", "ba=ultra", "backend=ultra", "frontend=ultra", "qc=ultra", "po=ultra"],
      fallbacks: ["pm=gpt-6-sol:high", "ba=gpt-6-sol:high", "backend=gpt-6-sol:high", "frontend=gpt-6-sol:high", "qc=gpt-6-sol:high", "po=gpt-6-sol:high"],
    });
    const root = await fixture(original);
    const otherRoot = await fixture();
    const otherBefore = await readFile(resolve(otherRoot, ".sdlc/project.yaml"), "utf8");
    const path = resolve(root, ".sdlc/project.yaml");
    await writeFile(path, `# Keep the project comment\n${await readFile(path, "utf8")}`);
    const projectBefore = await loadProject(root);
    for (const flag of ["--save-my-token", "--normal"]) {
      const expected: AgentPolicy = { roles: { ...(flag === "--save-my-token" ? savedRoles : {}), po: original.roles.po }, product_owner_review: "advisory" };
      const result = await cli(root, flag);
      expect(result.code).toBe(0);
      expect(result.payload).toMatchObject({ ok: true, command: "configure-agents", result: { agents: expected, applies_to: "new runs", dry_run: false } });
      expect(await loadProject(root)).toEqual({ ...projectBefore, agents: expected });
      const saved = await readFile(path, "utf8");
      expect(saved).toContain("# Keep the project comment");
      expect((await cli(root, flag)).code).toBe(0);
      expect(await readFile(path, "utf8")).toBe(saved);
    }
    expect(await readFile(resolve(otherRoot, ".sdlc/project.yaml"), "utf8")).toBe(otherBefore);
    expect(original.roles.pm?.reasoning_effort).toBe("ultra");
  });

  test.each(["--save-my-token", "--normal"])("CLI previews %s without writing", async (flag) => {
    const root = await fixture(updateAgentPolicy(undefined, { models: ["pm=gpt-6-astra"] }));
    const path = resolve(root, ".sdlc/project.yaml");
    const before = await readFile(path, "utf8");
    const result = await cli(root, flag, "--dry-run");
    expect(result.code).toBe(0);
    expect(result.payload.result).toMatchObject({ dry_run: true, agents: { roles: flag === "--save-my-token" ? savedRoles : {}, product_owner_review: "disabled" } });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("new runs snapshot the project setting and existing legacy/saving runs remain unchanged", async () => {
    const root = await fixture();
    const legacy = await run(root, "LEGACY-001");
    expect(legacy.agent_policy).toBeUndefined();
    const legacyPath = resolve(root, ".sdlc/runs/LEGACY-001/manifest.yaml");
    const legacyBefore = await readFile(legacyPath, "utf8");
    expect((await cli(root, "--save-my-token")).code).toBe(0);
    const saving = await run(root, "SAVING-001");
    expect(saving.agent_policy).toEqual({ roles: savedRoles, product_owner_review: "disabled" });
    expect((await run(root, "SAVING-002")).agent_policy).toEqual(saving.agent_policy);
    const savingPath = resolve(root, ".sdlc/runs/SAVING-001/manifest.yaml");
    const savingBefore = await readFile(savingPath, "utf8");
    expect((await cli(root, "--normal")).code).toBe(0);
    const normal = await run(root, "NORMAL-001");
    expect(normal.agent_policy).toEqual({ roles: {}, product_owner_review: "disabled" });
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBefore);
    expect(await readFile(savingPath, "utf8")).toBe(savingBefore);
    for (const taskId of ["PM-001", "BA-001", "BE-001", "BE-002", "WEB-001", "MOB-001", "QC-001"]) {
      expect(resolveAgentPlan(normal, taskId, capabilities).selected).toBeNull();
      const plan = resolveAgentPlan(saving, taskId, capabilities);
      expect(plan.selected).toEqual(taskId.startsWith("PM") ? null : taskId.startsWith("BA") ? savedRoles.ba : savedRoles.backend);
      expect(plan.requested).toEqual(plan.selected);
      expect(plan.fallback_used).toBe(false);
    }
    expect(() => resolveAgentPlan(saving, "MOB-001", { ...capabilities, models: [] })).toThrow("No implicit fallback");
    expect(() => resolveAgentPlan(saving, "QC-001", { ...capabilities, reasoning_selection: false })).toThrow("No implicit fallback");
  });

  test("normal works on a legacy project without a policy", async () => {
    const root = await fixture();
    expect((await cli(root, "--normal")).code).toBe(0);
    expect((await loadProject(root)).agents).toEqual({ roles: {}, product_owner_review: "disabled" });
  });

  test("reapplying the preset updates saved GPT-6 Sol without rewriting existing runs or using an implicit fallback", async () => {
    const previousPolicy: AgentPolicy = {
      roles: { ...savedRoles, ba: { model: "gpt-6-sol", reasoning_effort: "high" } },
      product_owner_review: "disabled",
    };
    const root = await fixture(previousPolicy);
    const previous = await run(root, "PREVIOUS-001");
    const path = resolve(root, ".sdlc/runs/PREVIOUS-001/manifest.yaml");
    const before = await readFile(path, "utf8");
    const oldHost: AgentCapabilities = {
      ...capabilities,
      models: [{ id: "gpt-6-sol", reasoning_efforts: ["high"] }, capabilities.models[1]!],
    };

    expect((await cli(root, "--save-my-token", "--dry-run")).payload.result.agents.roles.ba).toEqual(savedRoles.ba);
    expect((await loadProject(root)).agents).toEqual(previousPolicy);
    expect((await cli(root, "--save-my-token")).code).toBe(0);
    const updated = await run(root, "UPDATED-001");
    expect(updated.agent_policy).toEqual({ roles: savedRoles, product_owner_review: "disabled" });
    expect(resolveAgentPlan(updated, "BA-001", capabilities).selected).toEqual(savedRoles.ba);
    expect(() => resolveAgentPlan(updated, "BA-001", oldHost)).toThrow("No implicit fallback");
    expect(resolveAgentPlan(previous, "BA-001", oldHost).selected).toEqual(previousPolicy.roles.ba);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("grammar and CLI reject conflicting presets and manual settings without writing", async () => {
    const root = await fixture();
    const path = resolve(root, ".sdlc/project.yaml");
    const before = await readFile(path, "utf8");
    const manual = [["--agent-model", "ba=gpt-6-sol"], ["--agent-reasoning", "ba=high"], ["--agent-fallback", "ba=gpt-6-sol:high"], ["--reset-role", "pm"], ["--po-review", "advisory"]];
    for (const options of [["--save-my-token", "--normal"], ...["--save-my-token", "--normal"].flatMap((preset) => manual.map((settings) => [preset, ...settings]))]) {
      expect(validateCliArguments(["configure-agents", ...options]).length).toBeGreaterThan(0);
      const result = await cli(root, ...options);
      expect(result.code).not.toBe(0);
      expect(result.payload).toMatchObject({ ok: false, diagnostics: [{ code: "USAGE" }] });
      expect(await readFile(path, "utf8")).toBe(before);
    }
    for (const flag of ["--save-my-token", "--normal"]) {
      expect(validateCliArguments(["configure-agents", flag, "--dry-run", "--root", root, "--json"])).toEqual([]);
      expect(validateCliArguments(["init", "--name", "Example", flag]).length).toBeGreaterThan(0);
      expect(validateCliArguments(["configure-agents", flag, "unexpected-value"]).length).toBeGreaterThan(0);
    }
  });

  test("programmatic configuration rejects conflicts before writing", async () => {
    const root = await fixture();
    const path = resolve(root, ".sdlc/project.yaml");
    const before = await readFile(path, "utf8");
    const manual: Partial<ConfigureAgentsOptions>[] = [{ models: ["ba=gpt-6-sol"] }, { reasoning: ["ba=high"] }, { fallbacks: ["ba=gpt-6-sol:high"] }, { resetRoles: ["pm"] }, { productOwnerReview: "advisory" }];
    for (const options of [{ saveMyToken: true, normal: true }, ...[{ saveMyToken: true }, { normal: true }].flatMap((preset) => manual.map((settings) => ({ ...preset, ...settings })))]) {
      expect(() => updateAgentPolicy(undefined, options)).toThrow(/mutually exclusive|cannot be combined/);
      await expect(configureAgents({ ...options, root })).rejects.toThrow(/mutually exclusive|cannot be combined/);
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });
});
