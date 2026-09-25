import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";

import { assertTaskAgentDispatch, resolveAgentPlan, type AgentCapabilities } from "../src/agents.js";
import { resolveRequiredInputs, workflowOutputs } from "../src/delivery-authority-resolver.js";
import { readEvidenceReference } from "../src/evidence-validation.js";
import { canonicalizeCommandDeclaration } from "../src/command-provenance.js";
import { loadProject } from "../src/config.js";
import { synchronizeRunState } from "../src/transitions.js";
import type { WebDeliveryAssignment, WebDeliveryReport } from "../src/semantic-contracts.js";
import { initializeProject } from "../src/install.js";
import { readAuthorityVersion } from "../src/manifest-transaction.js";
import { planRepair, recoverRepair, repairTask } from "../src/repairs.js";
import { repairHistoryDiagnostics } from "../src/repair-validation.js";
import { loadRun, startRun, validateRun } from "../src/runs.js";
import type { RunManifest, Task } from "../src/types.js";

const roots: string[] = [];
const runId = "REPAIR-001";
const at = "2026-09-25T00:00:00.000Z";
const repairAt = "2026-09-25T01:00:00.000Z";
const options = { actor: "pm", defectId: "DEF-001", reason: "Correct the portal response", now: repairAt };
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const encoded = (source: string) => Buffer.from(source).toString("base64");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function put(root: string, path: string, source: string) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), source);
}
function finish(task: Task) {
  task.status = "completed";
  task.started_at = at;
  task.completed_at = at;
  task.transitions = [
    { from: "pending", to: "ready", actor: "pm", reason: "Fixture activation", at },
    { from: "ready", to: "running", actor: "pm", reason: "Fixture work", at },
    { from: "running", to: "awaiting_review", actor: "pm", reason: "Fixture handoff", at },
    { from: "awaiting_review", to: "completed", actor: "pm", reason: "Fixture review", at },
  ];
  task.outputs = [...task.required_outputs];
}
async function base(webOnly = false) {
  const root = await mkdtemp(resolve(tmpdir(), "sdlc-repair-test-"));
  roots.push(root);
  await mkdir(resolve(root, "apps/api"), { recursive: true });
  await mkdir(resolve(root, "apps/platform"), { recursive: true });
  await initializeProject({ root, projectName: "Repairs", applications: webOnly ? ["web"] : ["backend", "web"], backendRoot: "apps/api", webRoot: "apps/platform", dryRun: false });
  await put(root, ".sdlc/requests/repair.md", "Implement the API and portal.\n");
  await startRun(root, { id: runId, title: "Repair", requestFile: ".sdlc/requests/repair.md", affectedApplications: { backend: !webOnly, web: true, mobile: false, database: false, sharedPackages: false }, now: at });
  return { root, manifest: await loadRun(root, runId) };
}
async function pureFixture() {
  const { root, manifest } = await base();
  for (const task of manifest.tasks.filter((task) => task.id !== "PM-004")) finish(task);
  manifest.run.status = "running";
  for (const gate of Object.values(manifest.quality_gates)) {
    if (gate.status !== "not_applicable") gate.status = "passed";
  }
  return { root, manifest };
}

describe("repair planning and lineage", () => {
  test("resets only the selected implementation and transitive dependents while archiving history", async () => {
    const { manifest } = await pureFixture();
    const before = structuredClone(manifest);
    const result = planRepair(manifest, "WEB-001", options, repairAt);
    expect(manifest).toEqual(before);
    expect(result.record.affected_task_ids).toEqual(["WEB-001", "INT-001", "QC-001", "PM-004"]);
    for (const task of result.manifest.tasks) {
      const original = before.tasks.find((entry) => entry.id === task.id)!;
      if (!result.record.affected_task_ids.includes(task.id)) expect(task).toEqual(original);
      else {
        expect(task.status).toBe(task.id === "WEB-001" ? "ready" : "pending");
        expect(task.outputs).toEqual([]);
        expect(task.evidence).toEqual([]);
        expect(task.agent_dispatches).toEqual([]);
        expect(task.activation_offset).toBe(original.transitions.filter((entry) => entry.to === "ready").length);
      }
    }
    expect(result.record.tasks).toEqual(before.tasks.filter((task) => result.record.affected_task_ids.includes(task.id)));
    expect(result.manifest.quality_gates.web?.status).toBe("pending");
    expect(result.manifest.quality_gates.backend?.status).toBe(before.quality_gates.backend?.status);
    expect(result.manifest.repair_history).toEqual([result.record]);
  });

  test.each([
    ["terminal run", (manifest: RunManifest) => { manifest.run.status = "completed"; }, /terminal/],
    ["human decision", (manifest: RunManifest) => { manifest.product_owner_review = { status: "completed", decision: "accepted", comments: "Accepted", decided_at: at }; }, /human-reviewed/],
    ["pending approval", (manifest: RunManifest) => { manifest.tasks.find((task) => task.id === "QC-001")!.status = "awaiting_approval"; }, /pending approvals/],
    ["external blocker", (manifest: RunManifest) => { manifest.blockers.push({ id: "BLK-001", task_id: "QC-001", status: "open", description: "External review unavailable" }); }, /external blockers/],
    ["unconsumed approval", (manifest: RunManifest) => { manifest.decisions = [{ id: "DEC-001", topic: "Resume", status: "approved", decision: "Approved", requested_by: "pm", approved_by: "product-owner", affected_tasks: ["WEB-001"], action: "transition:WEB-001:running", consumed_at: null, consumed_by_transition: null }]; }, /unconsumed affected approval/],
  ] as const)("rejects %s", async (_name, change, pattern) => {
    const { manifest } = await pureFixture();
    change(manifest);
    expect(() => planRepair(manifest, "WEB-001", options, repairAt)).toThrow(pattern);
  });

  test("requires an existing completed implementation and valid actor, reason, defect, and time", async () => {
    const { manifest } = await pureFixture();
    for (const taskId of ["MISSING-001", "BA-001", "PM-004"]) expect(() => planRepair(manifest, taskId, options, repairAt)).toThrow("completed implementation");
    expect(() => planRepair(manifest, "WEB-001", { ...options, actor: "frontend" }, repairAt)).toThrow();
    expect(() => planRepair(manifest, "WEB-001", { ...options, reason: " " }, repairAt)).toThrow();
    expect(() => planRepair(manifest, "WEB-001", { ...options, defectId: "invalid" }, repairAt)).toThrow();
    expect(() => planRepair(manifest, "WEB-001", options, "invalid")).toThrow();
    expect(() => planRepair(manifest, "WEB-001", options, "2020-01-01T00:00:00Z")).toThrow("predates");
  });

  test("keeps repeated repair activations monotonic and rejects an archived dispatch", async () => {
    const { root, manifest } = await pureFixture();
    const capabilities: AgentCapabilities = { source: "test", model_selection: true, reasoning_selection: true, omitted_reasoning_effort: "model-default", models: [{ id: "gpt-6-luna", reasoning_efforts: ["xhigh"] }] };
    manifest.agent_policy = { roles: { frontend: { model: "gpt-6-luna", reasoning_effort: "xhigh" } }, product_owner_review: "disabled" };
    const originalPlan = resolveAgentPlan(manifest, "WEB-001", capabilities);
    const first = planRepair(manifest, "WEB-001", options, repairAt).manifest;
    const task = first.tasks.find((entry) => entry.id === "WEB-001")!;
    task.agent_dispatches = [{ plan: originalPlan, agent_id: "retired-agent", actual_model: "gpt-6-luna", actual_reasoning_effort: "xhigh", observation_source: "test", recorded_at: at }];
    expect(() => assertTaskAgentDispatch(first, task)).toThrow("requires a recorded agent dispatch");
    task.agent_dispatches = [];
    expect(resolveAgentPlan(first, task.id, capabilities).activation).toBe(originalPlan.activation + 1);
    finish(task);
    const second = planRepair(first, task.id, { ...options, defectId: "DEF-002" }, "2026-09-25T02:00:00Z").manifest;
    expect(second.repair_history?.map((entry) => entry.id)).toEqual(["RPR-001", "RPR-002"]);
    expect(resolveAgentPlan(second, task.id, capabilities).activation).toBe(originalPlan.activation + 2);
    expect(await repairHistoryDiagnostics(root, runId, second)).toEqual([]);
    second.tasks.find((entry) => entry.id === task.id)!.activation_offset = 0;
    expect((await repairHistoryDiagnostics(root, runId, second)).join("\n")).toContain("activation offset");
  });
});

async function recoveryFixture() {
  const { root } = await base();
  const manifestPath = `.sdlc/runs/${runId}/manifest.yaml`;
  const manifestSource = await readFile(resolve(root, manifestPath), "utf8");
  const artifact = "artifacts/web/implementation-summary.md";
  const archive = `repairs/RPR-001/${artifact}`;
  const original = "---\nrevision: 1\n---\nPrior implementation\n";
  await put(root, `.sdlc/runs/${runId}/${archive}`, original);
  const beforeVersion = await readAuthorityVersion(root, runId);
  const journal = { schema_version: 1, run_id: runId, repair_id: "RPR-001", before_version: beforeVersion, after_version: beforeVersion + 1, before_manifest: hash(manifestSource), after_manifest: hash("another manifest"), changes: [{ path: archive, before: null, after: encoded(original) }, { path: artifact, before: encoded(original), after: null }] };
  const journalPath = `.sdlc/runs/${runId}/.repair-transaction.json`;
  await put(root, journalPath, JSON.stringify(journal));
  return { root, artifact, archive, original, journal, journalPath, manifestPath, manifestSource };
}

describe("interrupted repair recovery", () => {
  test("safely rolls back partial file moves and is idempotent", async () => {
    const fixture = await recoveryFixture();
    expect(await recoverRepair(fixture.root, runId, "pm")).toEqual({ recovered: true, repair_id: "RPR-001", outcome: "rolled_back" });
    expect(await readFile(resolve(fixture.root, `.sdlc/runs/${runId}/${fixture.artifact}`), "utf8")).toBe(fixture.original);
    await expect(readFile(resolve(fixture.root, `.sdlc/runs/${runId}/${fixture.archive}`))).rejects.toThrow();
    expect(await readFile(resolve(fixture.root, fixture.manifestPath), "utf8")).toBe(fixture.manifestSource);
    expect(await recoverRepair(fixture.root, runId, "pm")).toEqual({ recovered: false });
  });

  test("refuses unauthorized actors, altered run bytes, changed files, and traversal journals", async () => {
    const fixture = await recoveryFixture();
    await expect(recoverRepair(fixture.root, runId, "frontend")).rejects.toThrow("only pm");
    await put(fixture.root, fixture.manifestPath, fixture.manifestSource + "\n# independent edit\n");
    await expect(recoverRepair(fixture.root, runId, "pm")).rejects.toThrow("run changed");
    await put(fixture.root, fixture.manifestPath, fixture.manifestSource);
    await put(fixture.root, `.sdlc/runs/${runId}/${fixture.artifact}`, "independent edit\n");
    await expect(recoverRepair(fixture.root, runId, "pm")).rejects.toThrow("file changed outside repair");
    fixture.journal.changes[0]!.path = "../../outside";
    await put(fixture.root, fixture.journalPath, JSON.stringify(fixture.journal));
    await expect(recoverRepair(fixture.root, runId, "pm")).rejects.toThrow("unsafe file change");
    expect(await readFile(resolve(fixture.root, `.sdlc/runs/${runId}/${fixture.artifact}`), "utf8")).toBe("independent edit\n");
  });

  test("rejects a symlink escape even when the journal path is lexically valid", async () => {
    const fixture = await recoveryFixture();
    const outside = await mkdtemp(resolve(tmpdir(), "sdlc-repair-outside-"));
    roots.push(outside);
    await put(outside, "original.md", fixture.original);
    await mkdir(dirname(resolve(fixture.root, `.sdlc/runs/${runId}/${fixture.artifact}`)), { recursive: true });
    await symlink(resolve(outside, "original.md"), resolve(fixture.root, `.sdlc/runs/${runId}/${fixture.artifact}`));
    await expect(recoverRepair(fixture.root, runId, "pm")).rejects.toThrow("escapes repository root");
    expect(await readFile(resolve(outside, "original.md"), "utf8")).toBe(fixture.original);
  });
});

async function completedWebFixture() {
  const { root, manifest } = await base(true);
  const prefix = `.sdlc/runs/${runId}`;
  const web = manifest.tasks.find((task) => task.id === "WEB-001")!;
  for (const task of manifest.tasks.filter((entry) => ["PM-001", "BA-001", "PM-002", "WEB-001"].includes(entry.id))) finish(task);
  synchronizeRunState(manifest);
  const summary = "---\nrevision: 1\n---\nVerified implementation.\n";
  await put(root, `${prefix}/artifacts/pm/requirements-review.md`, "---\nrevision: 1\n---\nRequirements approved.\n");
  const facts = "schema_version: 1\nrun_id: REPAIR-001\nproducer: pm\nrevision: 1\nfacts:\n  - id: FACT-001\n    subject: feature.portal\n    relation: equals\n    value: true\n    status: approved\n";
  await put(root, `${prefix}/facts.yaml`, facts);
  const assignment: WebDeliveryAssignment = {
    schema_version: 1, kind: "delivery_assignment", assignment_id: "ASN-001", run_id: runId, task_id: web.id, producer: "pm",
    role: "frontend", target: "web", stage: "web_implementation", scenario: "full_task", revision: 1, facts_revision: 1, facts_sha256: hash(facts), task_status: "running", scaffold_status: "scaffolded",
    dependencies: [{ task_id: "PM-002", status: "completed" }],
    required_inputs: (await resolveRequiredInputs(root, runId, web)).map((input) => ({ ...input, status: input.exists ? "available" : "missing" })),
    required_outputs: workflowOutputs(runId, web), allowed_write_roots: ["apps/platform", `${prefix}/artifacts/web`], available_evidence: [], evidence_requirements: [],
    transition_policy: { current_status: "running", allowed_request: "awaiting_review", unmet_disposition: "refuse" },
    controls: { api_contract_status: "approved", gaps: [], questions: [], requirements: [{ requirement_id: "REQ-001", capability: "semantic_status", required: true, parameters: {}, source_references: [{ kind: "fact", reference: "FACT-001" }] }] },
  };
  const productPath = "apps/platform/app/(portal)/page.tsx";
  const summaryPath = `${prefix}/artifacts/web/implementation-summary.md`;
  const report: WebDeliveryReport = {
    schema_version: 1, kind: "delivery_report", assignment_id: assignment.assignment_id, assignment_revision: 1, run_id: runId, task_id: web.id,
    producer: "frontend", role: "frontend", target: "web", stage: "web_implementation", scenario: "full_task", revision: 1, disposition: "proceed",
    transition_request: { from: "running", to: "awaiting_review" },
    artifacts: [{ path: summaryPath, artifact_kind: "implementation_summary", producer: "frontend", status: "produced", revision: 1, sha256: hash(summary) }],
    writes: [{ path: productPath, type: "source" }, { path: summaryPath, type: "artifact" }], evidence: [],
    observations: { api_contract_status: "approved", gaps: [], questions: [], requirement_results: [{ requirement_id: "REQ-001", capability: "semantic_status", required: true, status: "implemented" }] },
  };
  await put(root, `${prefix}/tasks/WEB-001.assignment.yaml`, stringify(assignment));
  await put(root, `${prefix}/tasks/WEB-001.handoff.json`, JSON.stringify({ assignment_id: "ASN-001", revision: 1 }));
  await put(root, `${prefix}/artifacts/web/WEB-001-delivery-report.yaml`, stringify(report));
  await put(root, summaryPath, summary);
  await put(root, productPath, "export const status = 'ready';\n");
  await put(root, `${prefix}/evidence/diffs/changed-files.json`, JSON.stringify({ files: [productPath, summaryPath], ownership: [{ path: productPath, task_id: "WEB-001" }] }));
  await put(root, `${prefix}/manifest.yaml`, stringify(manifest));
  expect(await validateRun(root, runId)).toEqual({ valid: true, diagnostics: [] });
  return { root, manifest, prefix, productPath, summaryPath };
}

describe("repository repair transactions", () => {
  test("archives retired authority, clears changed-file ownership, validates, and reuses an open repair", async () => {
    const fixture = await completedWebFixture();
    const oldManifest = await readFile(resolve(fixture.root, `${fixture.prefix}/manifest.yaml`), "utf8");
    const preview = await repairTask(fixture.root, runId, "WEB-001", { ...options, dryRun: true });
    expect(preview.dry_run).toBe(true);
    expect(await readFile(resolve(fixture.root, `${fixture.prefix}/manifest.yaml`), "utf8")).toBe(oldManifest);
    const result = await repairTask(fixture.root, runId, "WEB-001", options);
    expect(result.repair.id).toBe("RPR-001");
    const repaired = await loadRun(fixture.root, runId);
    expect(repaired.tasks.find((task) => task.id === "WEB-001")!.status).toBe("ready");
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
    expect(result.repair.archives.map((entry) => entry.path)).toEqual(expect.arrayContaining(["artifacts/web/implementation-summary.md", "artifacts/web/WEB-001-delivery-report.yaml", "tasks/WEB-001.assignment.yaml", "tasks/WEB-001.handoff.json", "evidence/diffs/changed-files.json"]));
    for (const archive of result.repair.archives) {
      expect(hash(await readFile(resolve(fixture.root, `${fixture.prefix}/${archive.archive_path}`), "utf8"))).toBe(archive.sha256);
      if (archive.path !== "evidence/diffs/changed-files.json") await expect(readFile(resolve(fixture.root, `${fixture.prefix}/${archive.path}`))).rejects.toThrow();
    }
    expect(JSON.parse(await readFile(resolve(fixture.root, `${fixture.prefix}/evidence/diffs/changed-files.json`), "utf8"))).toEqual({ files: [], ownership: [] });
    expect(await readFile(resolve(fixture.root, fixture.productPath), "utf8")).toContain("ready");
    expect((await repairTask(fixture.root, runId, "WEB-001", options)).already_open).toBe(true);
    expect((await loadRun(fixture.root, runId)).repair_history).toHaveLength(1);
  });

  test.each(["beforeReplace", "beforeRelease"] as const)("rolls back every moved artifact and run bytes when %s fails", async (hook) => {
    const fixture = await completedWebFixture();
    const paths = ["manifest.yaml", "artifacts/web/implementation-summary.md", "artifacts/web/WEB-001-delivery-report.yaml", "tasks/WEB-001.assignment.yaml", "tasks/WEB-001.handoff.json", "evidence/diffs/changed-files.json"];
    const before = await Promise.all(paths.map((path) => readFile(resolve(fixture.root, `${fixture.prefix}/${path}`), "utf8")));
    await expect(repairTask(fixture.root, runId, "WEB-001", options, { [hook]: () => { throw new Error("injected transaction failure"); } })).rejects.toThrow("injected transaction failure");
    expect(await Promise.all(paths.map((path) => readFile(resolve(fixture.root, `${fixture.prefix}/${path}`), "utf8")))).toEqual(before);
    await expect(readFile(resolve(fixture.root, `${fixture.prefix}/.repair-transaction.json`))).rejects.toThrow();
    await expect(readFile(resolve(fixture.root, `${fixture.prefix}/repairs/RPR-001/artifacts/web/implementation-summary.md`))).rejects.toThrow();
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
  });

  test("rejects unsafe run IDs and missing runs without creating a repair journal", async () => {
    const { root } = await base();
    await expect(repairTask(root, "../escape", "WEB-001", options)).rejects.toThrow("invalid repair path");
    await expect(repairTask(root, "MISSING-001", "WEB-001", options)).rejects.toThrow();
    await expect(readFile(resolve(root, `.sdlc/runs/${runId}/.repair-transaction.json`))).rejects.toThrow();
  });

  test("old command evidence cannot be reused after a repair", async () => {
    const { root, manifest } = await pureFixture();
    const repaired = planRepair(manifest, "WEB-001", options, repairAt).manifest;
    const reference = "evidence/commands/EVD-0000000000000000/evidence.json";
    const evidence = { schema_version: 1, id: "EVD-0000000000000000", run_id: runId, task_id: "WEB-001", command_id: "sdlc_test", executable: "node", args: [], cwd: "apps/platform", started_at: at, completed_at: at, exit_code: 0, result_status: "passed", evidence_path: reference, stdout_path: reference.replace("evidence.json", "stdout.txt"), stderr_path: reference.replace("evidence.json", "stderr.txt") };
    await put(root, `.sdlc/runs/${runId}/${reference}`, JSON.stringify(evidence));
    await expect(readEvidenceReference({ root, runId, manifest: repaired, reference, project: await loadProject(root), owner: "frontend" })).rejects.toThrow("predates the current repair cycle");
  });
});

describe("repair authority boundaries", () => {
  test("concurrent repair requests cannot create overlapping repair cycles", async () => {
    const fixture = await completedWebFixture();
    const attempts = await Promise.allSettled([
      repairTask(fixture.root, runId, "WEB-001", options),
      repairTask(fixture.root, runId, "WEB-001", options),
    ]);
    expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
    const created = attempts.filter((attempt) => attempt.status === "fulfilled" && !attempt.value.already_open);
    expect(created).toHaveLength(1);
    expect((await loadRun(fixture.root, runId)).repair_history).toHaveLength(1);
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
    await expect(readFile(resolve(fixture.root, `${fixture.prefix}/.repair-transaction.json`))).rejects.toThrow();
  });

  test("legacy changed-file documents without ownership remain repairable", async () => {
    const fixture = await completedWebFixture();
    const reportPath = `${fixture.prefix}/artifacts/web/WEB-001-delivery-report.yaml`;
    const { parse } = await import("yaml");
    const report = parse(await readFile(resolve(fixture.root, reportPath), "utf8")) as WebDeliveryReport;
    report.writes = report.writes.filter((write) => write.type === "artifact");
    await put(fixture.root, reportPath, stringify(report));
    await put(fixture.root, `${fixture.prefix}/evidence/diffs/changed-files.json`, JSON.stringify({ files: [fixture.summaryPath] }));
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
    await repairTask(fixture.root, runId, "WEB-001", options);
    expect(JSON.parse(await readFile(resolve(fixture.root, `${fixture.prefix}/evidence/diffs/changed-files.json`), "utf8"))).toEqual({ files: [], ownership: [] });
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
  });

  test("archive tampering invalidates the current run without erasing its history", async () => {
    const fixture = await completedWebFixture();
    const result = await repairTask(fixture.root, runId, "WEB-001", options);
    const archive = result.repair.archives.find((entry) => entry.path === "artifacts/web/implementation-summary.md")!;
    await put(fixture.root, `${fixture.prefix}/${archive.archive_path}`, "tampered history\n");
    const validation = await validateRun(fixture.root, runId);
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.join("\n")).toContain("archive integrity changed");
  });

  test("an archived assignment cannot be restored as current execution authority", async () => {
    const fixture = await completedWebFixture();
    const result = await repairTask(fixture.root, runId, "WEB-001", options);
    const archive = result.repair.archives.find((entry) => entry.path === "tasks/WEB-001.assignment.yaml")!;
    await put(fixture.root, `${fixture.prefix}/${archive.path}`, await readFile(resolve(fixture.root, `${fixture.prefix}/${archive.archive_path}`), "utf8"));
    const validation = await validateRun(fixture.root, runId);
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.join("\n")).toMatch(/repair|retired|revision|activation/);
  });
});

describe("repair crash boundaries", () => {
  test("finishes journal cleanup after the repaired manifest was already committed", async () => {
    const fixture = await completedWebFixture();
    const journalPath = `${fixture.prefix}/.repair-transaction.json`;
    let journal = "";
    await repairTask(fixture.root, runId, "WEB-001", options, { beforeReplace: async () => { journal = await readFile(resolve(fixture.root, journalPath), "utf8"); } });
    expect(journal).not.toBe("");
    // Simulate interruption after successful manifest replacement but before journal removal.
    await put(fixture.root, journalPath, journal);
    expect(await recoverRepair(fixture.root, runId, "pm")).toEqual({ recovered: true, repair_id: "RPR-001", outcome: "committed" });
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
    expect((await loadRun(fixture.root, runId)).repair_history).toHaveLength(1);
  });

  test("missing required current output is rejected before a repair moves files", async () => {
    const fixture = await completedWebFixture();
    const before = await readFile(resolve(fixture.root, `${fixture.prefix}/manifest.yaml`), "utf8");
    await rm(resolve(fixture.root, fixture.summaryPath));
    await expect(repairTask(fixture.root, runId, "WEB-001", options)).rejects.toThrow();
    expect(await readFile(resolve(fixture.root, `${fixture.prefix}/manifest.yaml`), "utf8")).toBe(before);
    await expect(readFile(resolve(fixture.root, `${fixture.prefix}/.repair-transaction.json`))).rejects.toThrow();
    expect(await readFile(resolve(fixture.root, `${fixture.prefix}/tasks/WEB-001.assignment.yaml`), "utf8")).toContain("ASN-001");
  });
});


test("known retired evidence is rejected even when the repair shares its timestamp", async () => {
  const { root, manifest } = await pureFixture();
  const reference = "evidence/commands/EVD-0000000000000000/evidence.json";
  manifest.tasks.find((task) => task.id === "WEB-001")!.evidence = [reference];
  const repaired = planRepair(manifest, "WEB-001", options, at).manifest;
  const project = await loadProject(root);
  const command = await canonicalizeCommandDeclaration(root, project.commands.sdlc_test, [], project);
  const evidence = {
    schema_version: 1, id: "EVD-0000000000000000", run_id: runId, task_id: "WEB-001", command_id: "sdlc_test", ...command.provenance,
    started_at: at, completed_at: at, exit_code: 0, result_status: "passed", evidence_path: reference,
    stdout_path: reference.replace("evidence.json", "stdout.txt"), stderr_path: reference.replace("evidence.json", "stderr.txt"),
  };
  await put(root, `.sdlc/runs/${runId}/${reference}`, JSON.stringify(evidence));
  await put(root, `.sdlc/runs/${runId}/${evidence.stdout_path}`, "");
  await put(root, `.sdlc/runs/${runId}/${evidence.stderr_path}`, "");
  // The document is valid command evidence for the original cycle.
  expect((await readEvidenceReference({ root, runId, manifest, reference, project, owner: "frontend" })).record.id).toBe(evidence.id);
  await expect(readEvidenceReference({ root, runId, manifest: repaired, reference, project, owner: "frontend" })).rejects.toThrow(/repair|retired/);
});


describe("review rework repair", () => {
  test("archives an awaiting-review implementation and starts a fresh validated execution cycle", async () => {
    const fixture = await completedWebFixture();
    const web = fixture.manifest.tasks.find((task) => task.id === "WEB-001")!;
    web.status = "awaiting_review";
    web.completed_at = null;
    web.transitions.pop();
    const integration = fixture.manifest.tasks.find((task) => task.id === "INT-001")!;
    integration.status = "pending";
    integration.transitions = [];
    synchronizeRunState(fixture.manifest);
    await put(fixture.root, `${fixture.prefix}/manifest.yaml`, stringify(fixture.manifest));
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
    const result = await repairTask(fixture.root, runId, web.id, options);
    expect(result.repair.tasks.find((task) => task.id === web.id)!.status).toBe("awaiting_review");
    const repaired = await loadRun(fixture.root, runId);
    expect(repaired.tasks.find((task) => task.id === web.id)!.status).toBe("ready");
    expect(repaired.tasks.find((task) => task.id === web.id)!.activation_offset).toBe(1);
    expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
    await expect(readFile(resolve(fixture.root, `${fixture.prefix}/tasks/WEB-001.assignment.yaml`))).rejects.toThrow();
    expect(result.repair.archives.some((entry) => entry.path === "artifacts/web/WEB-001-delivery-report.yaml")).toBe(true);
  });

  test("does not turn running implementation into a repair cycle", async () => {
    const { manifest } = await pureFixture();
    manifest.tasks.find((task) => task.id === "WEB-001")!.status = "running";
    expect(() => planRepair(manifest, "WEB-001", options, repairAt)).toThrow("completed implementation task or an implementation awaiting review");
  });
});

test("a second review rejection of the same defect opens a new repair after re-handoff", async () => {
  const fixture = await completedWebFixture();
  const { parse } = await import("yaml");
  const firstWeb = fixture.manifest.tasks.find((task) => task.id === "WEB-001")!;
  firstWeb.status = "awaiting_review";
  firstWeb.completed_at = null;
  firstWeb.transitions.pop();
  const integration = fixture.manifest.tasks.find((task) => task.id === "INT-001")!;
  integration.status = "pending";
  integration.transitions = [];
  synchronizeRunState(fixture.manifest);
  await put(fixture.root, `${fixture.prefix}/manifest.yaml`, stringify(fixture.manifest));
  const first = await repairTask(fixture.root, runId, "WEB-001", options);

  // Recreate a fully validated subsequent handoff, with fresh assignment/report revisions.
  for (const archive of first.repair.archives) {
    let source = await readFile(resolve(fixture.root, `${fixture.prefix}/${archive.archive_path}`), "utf8");
    if (archive.path === "tasks/WEB-001.assignment.yaml") {
      const assignment = parse(source) as WebDeliveryAssignment;
      assignment.revision += 1;
      source = stringify(assignment);
    } else if (archive.path === "artifacts/web/WEB-001-delivery-report.yaml") {
      const report = parse(source) as WebDeliveryReport;
      report.revision += 1;
      report.assignment_revision += 1;
      source = stringify(report);
    }
    await put(fixture.root, `${fixture.prefix}/${archive.path}`, source);
  }
  const handedOff = await loadRun(fixture.root, runId);
  const web = handedOff.tasks.find((task) => task.id === "WEB-001")!;
  web.status = "awaiting_review";
  web.started_at = "2026-09-25T01:01:00.000Z";
  web.outputs = [...web.required_outputs];
  web.transitions.push(
    { from: "ready", to: "running", actor: "pm", reason: "Execute first repair", at: web.started_at },
    { from: "running", to: "awaiting_review", actor: "frontend", reason: "Review corrected behavior", at: "2026-09-25T01:02:00.000Z" },
  );
  handedOff.run.updated_at = "2026-09-25T01:02:00.000Z";
  synchronizeRunState(handedOff);
  await put(fixture.root, `${fixture.prefix}/manifest.yaml`, stringify(handedOff));
  expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });

  const second = await repairTask(fixture.root, runId, "WEB-001", { ...options, now: "2026-09-25T01:03:00.000Z" });
  expect(second.already_open).toBe(false);
  expect(second.repair.id).toBe("RPR-002");
  expect(second.repair.defect_id).toBe(first.repair.defect_id);
  expect(second.repair.tasks.find((task) => task.id === "WEB-001")!.status).toBe("awaiting_review");
  const repaired = await loadRun(fixture.root, runId);
  expect(repaired.repair_history).toHaveLength(2);
  expect(repaired.tasks.find((task) => task.id === "WEB-001")!.activation_offset).toBe(2);
  expect(await validateRun(fixture.root, runId)).toEqual({ valid: true, diagnostics: [] });
});
