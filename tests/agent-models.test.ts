import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";

import { assertTaskAgentDispatch, configureAgents, planAgent, recordAgentDispatch, resolveAgentPlan, updateAgentPolicy, type AgentCapabilities, type AgentDispatchInput, type AgentPolicy } from "../src/agents.js";
import { validateCliArguments } from "../src/cli-grammar.js";
import { loadProject } from "../src/config.js";
import { initializeProject } from "../src/install.js";
import { recordProductOwnerDecision } from "../src/lifecycle.js";
import { mutateRunManifest, publishRunAuthority } from "../src/manifest-transaction.js";
import { advisoryPath, validateAdvisorySource, type ProductOwnerAdvisory } from "../src/product-owner.js";
import { loadRun, startRun, validateRun } from "../src/runs.js";
import { prepareTransitionContext, transitionTask } from "../src/transitions.js";

const roots: string[] = [];
const at = "2026-09-11T08:00:00.000Z";
const runId = "MODELS-001";
const capabilities: AgentCapabilities = {
  source: "test host adapter fixture",
  model_selection: true,
  reasoning_selection: true,
  omitted_reasoning_effort: "model-default",
  models: [
    { id: "gpt-6-astra", reasoning_efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-sol", reasoning_efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-luna", reasoning_efforts: ["low", "medium", "high"] },
  ],
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(agents?: AgentPolicy): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-models-"));
  roots.push(root);
  await mkdir(resolve(root, "web"));
  await initializeProject({ root, projectName: "Models", applications: ["web"], webRoot: "web", webPreset: "nextjs", agents, dryRun: false });
  await writeFile(resolve(root, ".sdlc/requests/request.md"), "Show status and preserve human acceptance.\n");
  await startRun(root, { id: runId, title: "Status", requestFile: ".sdlc/requests/request.md", affectedApplications: { backend: false, web: true, mobile: false, database: false, sharedPackages: false }, now: at });
  return root;
}

async function input(root: string): Promise<AgentDispatchInput> {
  return { plan: await planAgent(root, runId, "PM-001", capabilities), agent_id: "fixture-agent-1", actual_model: null, actual_reasoning_effort: null, observation_source: null };
}

function policy(): AgentPolicy {
  return updateAgentPolicy(undefined, { models: ["frontend=gpt-6-astra", "backend=gpt-5.6-luna", "qc=gpt-5.6-sol", "pm=gpt-5.6-sol"] });
}

describe("agent configuration", () => {
  test("previews without mutation, preserves project comments, and freezes the run policy", async () => {
    const root = await fixture(policy());
    const path = resolve(root, ".sdlc/project.yaml");
    await writeFile(path, `# Team configuration\n${await readFile(path, "utf8")}`);
    const before = await readFile(path, "utf8");
    const preview = await configureAgents({ root, models: ["frontend=gpt-5.6-sol"], dryRun: true });
    expect(preview.agents.roles.frontend?.model).toBe("gpt-5.6-sol");
    expect(await readFile(path, "utf8")).toBe(before);
    await configureAgents({ root, models: ["frontend=gpt-5.6-sol"] });
    expect((await loadProject(root)).agents?.roles.frontend?.model).toBe("gpt-5.6-sol");
    expect((await loadRun(root, runId)).agent_policy?.roles.frontend?.model).toBe("gpt-6-astra");
    expect(await readFile(path, "utf8")).toContain("# Team configuration");
    expect((await loadProject(root)).applications.web?.root).toBe("web");
  });

  test("rejects invalid settings before writing a new installation", async () => {
    expect(() => updateAgentPolicy(undefined, { models: ["FE=gpt-6-astra"] })).toThrow("unknown agent role");
    expect(() => updateAgentPolicy(undefined, { models: ["pm=gpt-6-astra", "pm=gpt-5.6-sol"] })).toThrow("duplicate model");
    expect(() => updateAgentPolicy(undefined, { reasoning: ["pm=high"] })).toThrow("configure a model");
    expect(() => updateAgentPolicy(undefined, { models: ["pm=invalid model"] })).toThrow();
    expect(() => updateAgentPolicy(undefined, { models: ["pm=gpt-5.6-sol"], reasoning: ["pm=extreme"] })).toThrow();
    const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-bad-models-"));
    roots.push(root);
    await expect(initializeProject({ root, projectName: "Bad", agents: { roles: { pm: { model: " " } }, product_owner_review: "disabled" }, dryRun: false })).rejects.toThrow();
    await expect(readFile(resolve(root, ".sdlc/project.yaml"))).rejects.toThrow();
  });

  test("replacing models clears incompatible settings, reset restores inheritance, and PO is explicit", () => {
    const previous = updateAgentPolicy(undefined, { models: ["pm=gpt-6-astra"], reasoning: ["pm=high"], fallbacks: ["pm=gpt-5.6-sol:low"] });
    const updated = updateAgentPolicy(previous, { models: ["pm=gpt-5.6-luna"] });
    expect(updated.roles.pm).toEqual({ model: "gpt-5.6-luna" });
    expect(updateAgentPolicy(updated, { resetRoles: ["pm"] }).roles).toEqual({});
    const withPo = updateAgentPolicy(updated, { models: ["po=gpt-5.6-sol"] });
    expect(withPo.product_owner_review).toBe("advisory");
    expect(() => updateAgentPolicy(withPo, { productOwnerReview: "disabled" })).toThrow("requires advisory");
    expect(updateAgentPolicy(withPo, { resetRoles: ["po"], productOwnerReview: "disabled" }).product_owner_review).toBe("disabled");
  });

  test("accepts the documented CLI grammar and rejects imaginary launch flags", () => {
    expect(validateCliArguments(["configure-agents", "--agent-model", "frontend=gpt-6-astra", "--agent-model", "pm=gpt-5.6-sol", "--agent-reasoning", "pm=high", "--po-review", "advisory", "--dry-run", "--json"])).toEqual([]);
    expect(validateCliArguments(["init", "--name", "Example", "--agent-model", "pm=gpt-5.6-sol"])).toEqual([]);
    expect(validateCliArguments(["agent-plan", runId, "PM-001", "--json"])).toEqual([]);
    expect(validateCliArguments(["agent-dispatch", runId, "PM-001", "--json"])).toEqual([]);
    expect(validateCliArguments(["agent-plan", runId, "PM-001", "--model", "anything"]).length).toBeGreaterThan(0);
  });
});

describe("host routing and execution audit", () => {
  test("resolves role models, preserves inheritance, and does not silently fall back", async () => {
    const root = await fixture(policy());
    const manifest = await loadRun(root, runId);
    expect(resolveAgentPlan(manifest, "WEB-001", capabilities).selected?.model).toBe("gpt-6-astra");
    expect(resolveAgentPlan(manifest, "PM-001", capabilities).selected?.model).toBe("gpt-5.6-sol");
    expect(resolveAgentPlan(manifest, "BA-001", capabilities).selected).toBeNull();
    expect(() => resolveAgentPlan(manifest, "WEB-001", { ...capabilities, models: [] })).toThrow("No implicit fallback");
    expect(() => resolveAgentPlan(manifest, "PM-001", { ...capabilities, model_selection: false })).toThrow("host cannot select");
  });

  test("uses only an explicit available fallback and validates reasoning against the host", async () => {
    const configured = updateAgentPolicy(policy(), { reasoning: ["pm=ultra"], fallbacks: ["pm=gpt-5.6-luna:low"] });
    const root = await fixture(configured);
    const manifest = await loadRun(root, runId);
    const plan = resolveAgentPlan(manifest, "PM-001", capabilities);
    expect(plan.requested).toEqual({ model: "gpt-5.6-sol", reasoning_effort: "ultra" });
    expect(plan.selected).toEqual({ model: "gpt-5.6-luna", reasoning_effort: "low" });
    expect(plan.fallback_used).toBe(true);
    expect(() => resolveAgentPlan(manifest, "PM-001", { ...capabilities, reasoning_selection: false })).toThrow("No implicit fallback");
    expect(() => resolveAgentPlan(manifest, "PM-001", { ...capabilities, models: [...capabilities.models, capabilities.models[0]!] })).toThrow("duplicate model");
  });

  test("accounts for host reasoning inheritance without pretending it is a model default", async () => {
    const root = await fixture(updateAgentPolicy(undefined, { models: ["pm=gpt-5.6-luna"] }));
    const manifest = await loadRun(root, runId);
    const inherited: AgentCapabilities = { ...capabilities, omitted_reasoning_effort: "inherit-parent", parent_reasoning_effort: "ultra" };
    expect(() => resolveAgentPlan(manifest, "PM-001", inherited)).toThrow("inherited effort");
    const advertisedDefault = { ...inherited, models: [{ id: "gpt-5.6-luna", reasoning_efforts: ["low", "medium"] as const, default_reasoning_effort: "low" as const }] };
    const plan = resolveAgentPlan(manifest, "PM-001", { ...advertisedDefault, models: advertisedDefault.models.map((model) => ({ ...model, reasoning_efforts: [...model.reasoning_efforts] })) });
    expect(plan.requested).toEqual({ model: "gpt-5.6-luna" });
    expect(plan.selected).toEqual({ model: "gpt-5.6-luna", reasoning_effort: "low" });
    expect(plan.fallback_used).toBe(false);
    expect(resolveAgentPlan(manifest, "PM-001", { ...inherited, parent_reasoning_effort: "medium" }).selected).toEqual({ model: "gpt-5.6-luna" });
    expect(() => resolveAgentPlan(manifest, "PM-001", { ...inherited, omitted_reasoning_effort: "unknown", parent_reasoning_effort: undefined })).toThrow("inherited effort");
  });

  test("requires a successful dispatch record before a configured PM starts; actual model can remain unknown", async () => {
    const root = await fixture(policy());
    const request = { taskId: "PM-001", to: "running" as const, actor: "pm", reason: "Start assigned PM work", at };
    const manifest = await loadRun(root, runId);
    const context = await prepareTransitionContext(root, runId, manifest, request);
    expect(() => transitionTask(manifest, request, context)).toThrow("requires a recorded agent dispatch");
    const dispatched = await recordAgentDispatch(root, runId, "PM-001", await input(root), at);
    expect(dispatched.actual_model).toBeNull();
    await mutateRunManifest(root, runId, async (current) => Object.assign(current, transitionTask(current, request, await prepareTransitionContext(root, runId, current, request))));
    const active = await loadRun(root, runId);
    expect(active.tasks[0]!.status).toBe("running");
    expect(active.tasks[0]!.agent_dispatches?.[0]?.agent_id).toBe("fixture-agent-1");
    expect((await validateRun(root, runId)).valid).toBe(true);
  });

  test("rejects stale or altered plans and mismatching actual metadata without recording them", async () => {
    const root = await fixture(policy());
    const original = await input(root);
    await expect(recordAgentDispatch(root, runId, "PM-001", { ...original, actual_model: "gpt-6-astra", observation_source: "host response" }, at)).rejects.toThrow("differs");
    await expect(recordAgentDispatch(root, runId, "PM-001", { ...original, actual_model: "gpt-5.6-sol" }, at)).rejects.toThrow("observation source");
    const altered = structuredClone(original);
    altered.plan.selected = { model: "gpt-6-astra" };
    await expect(recordAgentDispatch(root, runId, "PM-001", altered, at)).rejects.toThrow("stale");
    await expect(recordAgentDispatch(root, runId, "BA-001", original, at)).rejects.toThrow("stale");
    expect((await loadRun(root, runId)).tasks[0]!.agent_dispatches).toBeUndefined();
    await recordAgentDispatch(root, runId, "PM-001", original, at);
    await mutateRunManifest(root, runId, async (current) => {
      const request = { taskId: "PM-001", to: "running" as const, actor: "pm", reason: "Activate", at };
      Object.assign(current, transitionTask(current, request, await prepareTransitionContext(root, runId, current, request)));
    });
    await expect(recordAgentDispatch(root, runId, "PM-001", original, at)).rejects.toThrow("stale");
  });

  test("an activation after a blocker cannot reuse the previous dispatch", async () => {
    const root = await fixture(policy());
    await recordAgentDispatch(root, runId, "PM-001", await input(root), at);
    const manifest = await loadRun(root, runId);
    const task = manifest.tasks[0]!;
    task.transitions.push({ from: "ready", to: "blocked", actor: "pm", reason: "Fixture blocker", at }, { from: "blocked", to: "ready", actor: "pm", reason: "Fixture resolved", at });
    expect(() => assertTaskAgentDispatch(manifest, task)).toThrow("requires a recorded agent dispatch");
  });

  test("legacy runs still start without model metadata", async () => {
    const root = await fixture();
    const manifest = await loadRun(root, runId);
    const request = { taskId: "PM-001", to: "running" as const, actor: "pm", reason: "Legacy start", at };
    expect(transitionTask(manifest, request, await prepareTransitionContext(root, runId, manifest, request)).tasks[0]?.status).toBe("running");
    expect(manifest.agent_policy).toBeUndefined();
  });
});

describe("advisory AI Product Owner", () => {
  function review(): ProductOwnerAdvisory {
    return { schema_version: 1, run_id: runId, task_id: "PO-001", producer: "po", advisory_only: true, recommendation: "changes_recommended", summary: "Acceptance evidence still needs review.", acceptance_coverage: [{ acceptance_criteria_id: "AC-001", requirement_id: "REQ-001", assessment: "unverified", sources: ["request.md"] }], findings: [] };
  }

  test("adds a required advisory task before the final package, preserving the human decision", async () => {
    const root = await fixture(updateAgentPolicy(undefined, { models: ["po=gpt-5.6-sol"] }));
    await mkdir(resolve(root, `.sdlc/runs/${runId}/artifacts/ba`), { recursive: true });
    await writeFile(resolve(root, `.sdlc/runs/${runId}/artifacts/ba/acceptance-criteria.md`), "# Acceptance criteria\n\n## AC-001\n\nrequirement_id: REQ-001\n");
    const manifest = await loadRun(root, runId);
    expect(manifest.tasks.find((task) => task.id === "PO-001")?.dependencies).toEqual(["QC-001"]);
    expect(manifest.tasks.find((task) => task.id === "PM-004")?.dependencies).toEqual(["PO-001"]);
    expect(manifest.tasks.find((task) => task.id === "PO-001")?.required_outputs).toContain(advisoryPath);
    const advisory = review();
    await publishRunAuthority(root, runId, [{ path: advisoryPath, source: stringify(advisory) }], { expectedVersion: 0 });
    const after = await loadRun(root, runId);
    expect(after.product_owner_review?.decision).toBeNull();
    expect(after.final_result?.status).toBe("pending");
    await expect(recordProductOwnerDecision(root, runId, "accepted", "po", "AI recommendation", at)).rejects.toThrow("AI roles cannot record");
    await expect(recordProductOwnerDecision(root, runId, "accepted", "product-owner", "User accepts", at)).rejects.toThrow("not ready");
  });

  test("rejects fabricated acceptance, unsupported readiness, and unsafe or missing citations", async () => {
    const root = await fixture(updateAgentPolicy(undefined, { productOwnerReview: "advisory" }));
    await mkdir(resolve(root, `.sdlc/runs/${runId}/artifacts/ba`), { recursive: true });
    const criteriaFile = resolve(root, `.sdlc/runs/${runId}/artifacts/ba/acceptance-criteria.md`);
    await writeFile(criteriaFile, "# Acceptance criteria\n\n## AC-001\n\nrequirement_id: REQ-001\n");
    const manifest = await loadRun(root, runId);
    await expect(validateAdvisorySource(root, runId, manifest, stringify({ ...review(), advisory_only: false }))).rejects.toThrow("invalid Product Owner advisory");
    await expect(validateAdvisorySource(root, runId, manifest, stringify({ ...review(), recommendation: "accepted" }))).rejects.toThrow("invalid Product Owner advisory");
    await expect(validateAdvisorySource(root, runId, manifest, stringify({ ...review(), recommendation: "ready_for_human_review" }))).rejects.toThrow("changes_recommended");
    await expect(validateAdvisorySource(root, runId, manifest, stringify(review()))).resolves.toMatchObject({ recommendation: "changes_recommended" });
    await writeFile(criteriaFile, "## AC-001\nrequirement_id: REQ-001\n\n## AC-002\nrequirement_id: REQ-001\n");
    await expect(validateAdvisorySource(root, runId, manifest, stringify(review()))).rejects.toThrow("every authoritative acceptance criterion");
    const complete = review(); complete.acceptance_coverage.push({ ...structuredClone(complete.acceptance_coverage[0]!), acceptance_criteria_id: "AC-002" });
    await expect(validateAdvisorySource(root, runId, manifest, stringify(complete))).resolves.toBeDefined();
    complete.acceptance_coverage[1]!.requirement_id = "REQ-999";
    await expect(validateAdvisorySource(root, runId, manifest, stringify(complete))).rejects.toThrow("matching requirement ID");
    await writeFile(criteriaFile, "## AC-001\nrequirement_id: REQ-001\n");
    for (const citation of ["../../outside.md", "missing.md", advisoryPath]) {
      const value = review(); value.acceptance_coverage[0]!.sources = [citation];
      await expect(validateAdvisorySource(root, runId, manifest, stringify(value))).rejects.toThrow();
    }
  });
});
