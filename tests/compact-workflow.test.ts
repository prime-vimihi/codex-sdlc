import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";

import { planAgent } from "../src/agents.js";
import { publishCompactSpecification, publishCompactQc } from "../src/compact-artifacts.js";
import { executeConfiguredCommand } from "../src/evidence.js";
import { finalizeRun } from "../src/finalize.js";
import { initializeProject } from "../src/install.js";
import { recordQualityGate } from "../src/lifecycle.js";
import { mutateRunManifest, publishRunAuthority, readAuthorityVersion } from "../src/manifest-transaction.js";
import { repairTask } from "../src/repairs.js";
import { loadRun, startRun, validateRun } from "../src/runs.js";
import { activateTask } from "../src/task-activation.js";
import { handoffTask, prepareTask } from "../src/task-operations.js";
import { prepareTransitionContext, transitionTask } from "../src/transitions.js";
import type { ProjectConfig, TaskStatus } from "../src/types.js";
import { resolveWorkflowProfile, type CompactAssessment } from "../src/workflow-profile.js";

const exec = promisify(execFile);
const roots: string[] = [];
const assessment: CompactAssessment = { bounded_scope: true, existing_patterns: true, migrations: false, breaking_api: false, authorization_changes: false, sensitive_data_exposure: false, cross_system_uncertainty: false, rationale: "One status correction using an existing implementation and test pattern." };
const capabilities = { source: "fixture host", model_selection: true, reasoning_selection: true, models: [] };
const runId = "COMPACT-001";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { applications?: Array<"backend" | "web" | "mobile">; advisory?: boolean; profile?: "full" | "compact" } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "sdlc-compact-"));
  roots.push(root);
  const applications = options.applications ?? ["web"];
  for (const app of applications) await mkdir(resolve(root, `apps/${app}`), { recursive: true });
  await writeFile(resolve(root, "feature.cjs"), "module.exports = 'before';\n");
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Baseline"], { cwd: root });
  await initializeProject({ root, projectName: "Compact", applications, backendRoot: "apps/backend", webRoot: "apps/web", mobileRoot: "apps/mobile", agents: options.advisory ? { roles: {}, product_owner_review: "advisory" } : undefined, dryRun: false });
  const projectPath = resolve(root, ".sdlc/project.yaml");
  const project = parse(await readFile(projectPath, "utf8")) as ProjectConfig;
  for (const app of applications) project.applications[app]!.lifecycle = "scaffolded";
  project.commands.sdlc_test = { executable: process.execPath, args: ["-e", "if(require('./feature.cjs') !== 'after')process.exit(1)"], cwd: ".", network: "disabled", mutates: false };
  await writeFile(projectPath, stringify(project));
  await writeFile(resolve(root, ".sdlc/requests/change.md"), "REQ-001: Correct the existing status display.\n");
  await startRun(root, { id: runId, title: "Status correction", requestFile: ".sdlc/requests/change.md", profile: options.profile ?? "compact", ...(options.profile === "full" ? {} : { assessment }), affectedApplications: { backend: applications.includes("backend"), web: applications.includes("web"), mobile: applications.includes("mobile"), database: false, sharedPackages: false }, now: new Date().toISOString() });
  return root;
}
async function transition(root: string, taskId: string, to: TaskStatus, actor = "pm") {
  return mutateRunManifest(root, runId, async (manifest) => {
    const request = { taskId, to, actor, reason: "Fixture lifecycle verification", at: new Date().toISOString() };
    Object.assign(manifest, transitionTask(manifest, request, await prepareTransitionContext(root, runId, manifest, request)));
  });
}
async function activate(root: string, taskId: string) {
  const plan = await planAgent(root, runId, taskId, capabilities);
  await activateTask(root, runId, taskId, { plan, agent_id: `fixture-${taskId}-${plan.activation}`, actual_model: null, actual_reasoning_effort: null, observation_source: null }, "Fixture host dispatched role");
}
async function put(root: string, path: string, source: string) { const destination = resolve(root, `.sdlc/runs/${runId}/${path}`); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, source); }
async function collect(root: string, taskId: string) {
  const project = parse(await readFile(resolve(root, ".sdlc/project.yaml"), "utf8")) as ProjectConfig;
  const key = project.security.network_policy_attestation_environment;
  const previous = process.env[key]; process.env[key] = "disabled";
  try { return await executeConfiguredCommand(root, runId, taskId, "sdlc_test"); }
  finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
}
async function reviewedSpecification(root: string) {
  await activate(root, "PM-001");
  await publishRunAuthority(root, runId, [{ path: "facts.yaml", source: stringify({ schema_version: 1, run_id: runId, producer: "pm", revision: 1, facts: [{ id: "FACT-001", subject: "feature.status", relation: "equals", value: "after", status: "approved" }] }) }], { expectedVersion: await readAuthorityVersion(root, runId) });
  await transition(root, "PM-001", "awaiting_review"); await transition(root, "PM-001", "completed");
  await activate(root, "BA-001");
  await publishCompactSpecification(root, runId, {
    scope: { summary: "Correct the existing status", in_scope: ["Existing status output"], out_of_scope: ["New authorization or API behavior"] },
    requirements: [{ id: "REQ-001", description: "Display the existing approved status", fact_ids: ["FACT-001"] }],
    acceptance_criteria: [{ id: "AC-001", requirement_id: "REQ-001", given: "The existing feature", when: "The status is read", then: "The status is after", evidence_types: ["command"] }],
    api_change: { kind: "unchanged", description: "Uses the existing status response" },
  });
  await transition(root, "BA-001", "awaiting_review", "ba");
  await expect(recordQualityGate(root, runId, "requirements", "passed", ["artifacts/ba/specification.yaml"], "ba", "Self review is not accepted", new Date().toISOString())).rejects.toThrow("reviewed by pm");
  await recordQualityGate(root, runId, "requirements", "passed", ["artifacts/ba/specification.yaml"], "pm", "Specification and derived views reviewed", new Date().toISOString());
  await expect(transition(root, "BA-001", "completed", "ba")).rejects.toThrow("review by pm");
  await transition(root, "BA-001", "completed");
}
async function implementTarget(root: string, target: "backend" | "web" | "mobile" = "web") {
  const taskId = target === "backend" ? "BE-002" : target === "web" ? "WEB-001" : "MOB-001";
  const apiCapabilities = ["request", "response", "error", "authentication", "authorization"];
  const controls = target === "backend"
    ? { mode: "implementation", api_requirements: apiCapabilities.map((capability) => ({ requirement_id: "REQ-001", capability, required: capability === "response", source_references: [{ kind: "fact", reference: "FACT-001" }] })), storage: { postgresql_role: "durable_truth", redis_roles: [], redis_authoritative: false }, migration: { impact: "none", approval_status: "not_required", decision_id: null } }
    : { api_contract_status: "approved", gaps: [], questions: [], requirements: [{ requirement_id: "REQ-001", capability: "feature_status", required: true, parameters: {}, source_references: [{ kind: "fact", reference: "FACT-001" }] }] };
  await prepareTask(root, runId, taskId, { controls: controls as any, commandIds: ["sdlc_test"] });
  await activate(root, taskId);
  await writeFile(resolve(root, "feature.cjs"), "module.exports = 'after';\n");
  await writeFile(resolve(root, `apps/${target}/status.cjs`), "module.exports = 'after';\n");
  await put(root, `artifacts/${target}/implementation-summary.md`, "---\nrevision: 1\n---\nREQ-001: Updated the status implementation.\n");
  const evidence = await collect(root, taskId);
  const outcomes = target === "backend" ? apiCapabilities.map((capability) => ({ requirement_id: "REQ-001", capability, status: capability === "response" ? "implemented" as const : "not_applicable" as const })) : [{ requirement_id: "REQ-001", capability: "feature_status", status: "implemented" as const }];
  await handoffTask(root, runId, taskId, { requirementOutcomes: outcomes, changedFiles: [{ path: `apps/${target}/status.cjs`, type: "source" }] });
  await recordQualityGate(root, runId, target, "passed", [evidence.evidence_path], "pm", "Implementation verified", new Date().toISOString());
  await transition(root, taskId, "completed");
}
async function verifyQc(root: string) {
  await activate(root, "QC-001");
  const evidence = await collect(root, "QC-001");
  await publishCompactQc(root, runId, { results: [{ ac_id: "AC-001", status: "passed", evidence: [{ type: "command", reference: evidence.evidence_path }], notes: "Independent command verified the current status" }], defects: [] });
  await transition(root, "QC-001", "awaiting_review", "qc");
  await recordQualityGate(root, runId, "qc", "passed", [evidence.evidence_path], "pm", "Independent acceptance coverage verified", new Date().toISOString());
  await expect(transition(root, "QC-001", "completed")).rejects.toThrow("integration");
  await recordQualityGate(root, runId, "integration", "passed", [evidence.evidence_path], "pm", "Combined integration verification reviewed", new Date().toISOString());
  await transition(root, "QC-001", "completed");
}

describe("frozen Compact workflow profile", { timeout: 30_000 }, () => {
  test("requires an explicit complete low-risk assessment and leaves Full the default", async () => {
    expect(resolveWorkflowProfile()).toBeUndefined();
    expect(resolveWorkflowProfile("full")).toBeUndefined();
    expect(() => resolveWorkflowProfile("compact")).toThrow("complete low-risk");
    for (const field of ["migrations", "breaking_api", "authorization_changes", "sensitive_data_exposure", "cross_system_uncertainty"]) expect(() => resolveWorkflowProfile("compact", { ...assessment, [field]: true } as any)).toThrow("Full run");
    expect(() => resolveWorkflowProfile("compact", { ...assessment, bounded_scope: false } as any)).toThrow();
    expect(() => resolveWorkflowProfile("compact", { ...assessment, extra: false } as any)).toThrow();
    expect(() => resolveWorkflowProfile("unknown" as any, assessment)).toThrow("unknown");
    const full = await fixture({ profile: "full" });
    expect((await loadRun(full, runId)).workflow_profile).toBeUndefined();
    expect((await loadRun(full, runId)).tasks.map((task) => task.id)).toEqual(["PM-001", "BA-001", "PM-002", "WEB-001", "INT-001", "QC-001", "PM-004"]);
  });

  test("uses the revision1 graph across affected applications and preserves independent required gates", async () => {
    const root = await fixture({ applications: ["backend", "web", "mobile"], advisory: true });
    const manifest = await loadRun(root, runId);
    expect(manifest.workflow_profile).toEqual({ name: "compact", revision: 1, assessment });
    expect(manifest.tasks.map((task) => task.id)).toEqual(["PM-001", "BA-001", "BE-002", "WEB-001", "MOB-001", "QC-001", "PO-001", "PM-004"]);
    expect(manifest.tasks.find((task) => task.id === "QC-001")?.dependencies).toEqual(["BE-002", "WEB-001", "MOB-001"]);
    expect(manifest.quality_gates.api_contract?.status).toBe("not_applicable");
    expect(manifest.quality_gates.integration?.status).toBe("pending");
    const workflowPath = resolve(root, ".sdlc/workflows/feature-development.yaml");
    const workflow = parse(await readFile(workflowPath, "utf8"));
    workflow.stages.find((stage: any) => stage.id === "qc").required_outputs.push("artifacts/qc/future-full-output.md");
    await writeFile(workflowPath, stringify(workflow));
    expect(await validateRun(root, runId)).toEqual({ valid: true, diagnostics: [] });
    await expect(mutateRunManifest(root, runId, (current) => { delete current.workflow_profile; })).rejects.toThrow("immutable");
    await expect(mutateRunManifest(root, runId, (current) => { current.workflow_profile!.assessment.rationale = "Changed assessment"; })).rejects.toThrow("immutable");
    await expect(mutateRunManifest(root, runId, (current) => { current.quality_gates.integration!.status = "not_applicable"; })).rejects.toThrow("integration gate is required");
  });

  test.each([false, true])("completes actual Compact delivery with advisory=%s while human acceptance stays pending", async (advisory) => {
    const root = await fixture({ advisory });
    await reviewedSpecification(root);
    const binding = (await loadRun(root, runId)).compact_review;
    expect(binding?.specification_sha256).toMatch(/^[a-f0-9]{64}$/);
    await implementTarget(root);
    await verifyQc(root);
    if (advisory) {
      await activate(root, "PO-001");
      await publishRunAuthority(root, runId, [{ path: "artifacts/po/advisory-review.yaml", source: stringify({ schema_version: 1, run_id: runId, task_id: "PO-001", producer: "po", advisory_only: true, recommendation: "ready_for_human_review", summary: "Verified acceptance evidence is ready for human review", acceptance_coverage: [{ acceptance_criteria_id: "AC-001", requirement_id: "REQ-001", assessment: "supported", sources: ["artifacts/ba/acceptance-criteria.md", "artifacts/qc/summary.md"] }], findings: [] }) }], { expectedVersion: await readAuthorityVersion(root, runId) });
      await transition(root, "PO-001", "awaiting_review", "po"); await transition(root, "PO-001", "completed");
    }
    await activate(root, "PM-004");
    await put(root, "final-report.md", "---\nrevision: 1\n---\nDelivered the reviewed status correction; awaiting human acceptance.\n");
    await transition(root, "PM-004", "awaiting_review"); await transition(root, "PM-004", "completed");
    const finalized = await finalizeRun(root, runId, "pm", new Date().toISOString());
    expect(finalized.final_result?.status).toBe("ready");
    expect(finalized.product_owner_review?.decision).toBeNull();
    expect(finalized.compact_review).toEqual(binding);
    expect(await validateRun(root, runId)).toEqual({ valid: true, diagnostics: [] });
  });

  test("reviewed facts/spec cannot drift and repairs reset both integration and QC", async () => {
    const root = await fixture();
    await reviewedSpecification(root); await implementTarget(root); await verifyQc(root);
    const before = await loadRun(root, runId);
    await expect(mutateRunManifest(root, runId, (current) => { current.quality_gates.integration!.evidence = ["request.md"]; })).rejects.toThrow("current independent QC collector evidence");
    const result = await repairTask(root, runId, "WEB-001", { actor: "pm", defectId: "DEF-COMPACT-001", reason: "Independent follow-up found an implementation defect" });
    expect(result.repair.affected_task_ids).toEqual(["WEB-001", "QC-001", "PM-004"]);
    const repaired = await loadRun(root, runId);
    expect(repaired.quality_gates.integration?.status).toBe("pending");
    expect(repaired.quality_gates.qc?.status).toBe("pending");
    expect(repaired.workflow_profile).toEqual(before.workflow_profile);
    expect(repaired.compact_review).toEqual(before.compact_review);
    expect(repaired.tasks.find((task) => task.id === "QC-001")?.evidence).toEqual([]);
    await expect(mutateRunManifest(root, runId, (current) => { delete current.compact_review; })).rejects.toThrow("immutable");
    const factsPath = resolve(root, `.sdlc/runs/${runId}/facts.yaml`);
    const facts = parse(await readFile(factsPath, "utf8")); facts.revision += 1; await writeFile(factsPath, stringify(facts));
    expect((await validateRun(root, runId)).valid).toBe(false);
  });

  test("later migration controls require escalation instead of silently widening Compact eligibility", async () => {
    const root = await fixture({ applications: ["backend"] });
    await reviewedSpecification(root);
    await expect(prepareTask(root, runId, "BE-002", {
      controls: { mode: "implementation", api_requirements: ["request", "response", "error", "authentication", "authorization"].map((capability) => ({ requirement_id: "REQ-001", capability, required: true, source_references: [{ kind: "fact", reference: "FACT-001" }] })) as any,
        storage: { postgresql_role: "durable_truth", redis_roles: [], redis_authoritative: false }, migration: { impact: "additive", approval_status: "not_required", decision_id: null } }, commandIds: ["sdlc_test"],
    })).rejects.toThrow("Compact excludes migrations");
    expect((await loadRun(root, runId)).tasks.find((task) => task.id === "BE-002")?.status).toBe("ready");
    await expect(readFile(resolve(root, `.sdlc/runs/${runId}/tasks/BE-002.assignment.yaml`))).rejects.toThrow();
  });

  test("rejects edited profile revisions and removed canonical QC tasks", async () => {
    const root = await fixture();
    const path = resolve(root, `.sdlc/runs/${runId}/manifest.yaml`);
    const original = await readFile(path, "utf8");
    const changed = parse(original);
    changed.workflow_profile.revision = 2;
    await writeFile(path, stringify(changed));
    expect((await validateRun(root, runId)).valid).toBe(false);
    const missing = parse(original);
    missing.tasks = missing.tasks.filter((task: any) => task.id !== "QC-001");
    await writeFile(path, stringify(missing));
    expect((await validateRun(root, runId)).valid).toBe(false);
    await writeFile(path, original);
    expect((await validateRun(root, runId)).valid).toBe(true);
  });

  test.each(["backend", "mobile"] as const)("runs Compact %s implementation through independent integration and QC", async (target) => {
    const root = await fixture({ applications: [target] });
    await reviewedSpecification(root); await implementTarget(root, target); await verifyQc(root);
    const manifest = await loadRun(root, runId);
    expect(manifest.tasks.find((task) => task.id === "QC-001")?.status).toBe("completed");
    expect(manifest.quality_gates.integration?.status).toBe("passed");
    expect(manifest.quality_gates.api_contract?.status).toBe("not_applicable");
    expect(await validateRun(root, runId)).toEqual({ valid: true, diagnostics: [] });
  });
});
