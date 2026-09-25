import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";

import { mutateRunManifest, readAuthorityVersion } from "../src/manifest-transaction.js";
import { recordQualityGate } from "../src/lifecycle.js";
import { repairTask } from "../src/repairs.js";
import { loadRun } from "../src/runs.js";
import { handoffTask, prepareTask } from "../src/task-operations.js";
import * as transitions from "../src/transitions.js";
import { activateAndHandoffFixture, activateFixture, collectFixtureEvidence, createDeliveryFixture, writeFixtureOutputs, type DeliveryFixture } from "./helpers/delivery-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(options: Parameters<typeof createDeliveryFixture>[0] = {}) { const result = await createDeliveryFixture(options); roots.push(result.root); return result; }
async function runningFixture() { const value = await fixture(); await prepareTask(value.root, value.runId, value.taskId, value.input); await activateFixture(value); await writeFixtureOutputs(value); return value; }
async function runBytes(value: DeliveryFixture) { return readFile(resolve(value.root, `.sdlc/runs/${value.runId}/manifest.yaml`), "utf8"); }

describe("automatic task preparation and handoff", () => {
  test("prepares a compact authoritative packet idempotently without activating or changing dry-run files", async () => {
    const value = await fixture();
    const before = await runBytes(value);
    const version = await readAuthorityVersion(value.root, value.runId);
    const preview = await prepareTask(value.root, value.runId, value.taskId, value.input, { dryRun: true });
    expect(preview.taskStatus).toBe("ready");
    expect(preview.executionAuthorized).toBe(false);
    expect(preview.assignment.allowed_write_roots).toEqual(expect.arrayContaining([value.appRoot, `.sdlc/runs/${value.runId}/artifacts/web`]));
    expect(preview.assignment.allowed_write_roots).not.toContain(".");
    expect(preview.assignment.facts_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.assignment.required_inputs.every((entry) => entry.exists && entry.sha256)).toBe(true);
    await expect(readFile(resolve(value.root, preview.paths.assignment))).rejects.toThrow();
    expect(await runBytes(value)).toBe(before);
    expect(await readAuthorityVersion(value.root, value.runId)).toBe(version);
    const first = await prepareTask(value.root, value.runId, value.taskId, value.input);
    expect(first.assignment.revision).toBe(1);
    const repeated = await prepareTask(value.root, value.runId, value.taskId, value.input);
    expect(repeated.authorityVersion).toBe(first.authorityVersion);
    expect(repeated.assignment).toEqual(first.assignment);
    await expect(prepareTask(value.root, value.runId, value.taskId, value.input, { expectedVersion: version })).rejects.toThrow("stale authority version");
  });

  test("actual recorded activation, collector evidence, and generated report end at awaiting_review with stable retries", async () => {
    const value = await fixture();
    await writeFile(resolve(value.root, value.appRoot, "unrelated.txt"), "unrelated user work");
    const result = await activateAndHandoffFixture(value);
    expect(result.taskStatus).toBe("awaiting_review");
    expect(result.report.disposition).toBe("proceed");
    expect(result.report.evidence).toEqual([expect.objectContaining({ command_key: "sdlc_test", status: "passed", owner: "runtime_collector" })]);
    expect(result.report.writes.map((entry) => entry.path)).not.toContain(`${value.appRoot}/unrelated.txt`);
    expect(result.report.observations.requirement_results).toEqual([{ requirement_id: "REQ-001", capability: "feature_status", required: true, status: "implemented" }]);
    const before = await runBytes(value);
    const repeated = await handoffTask(value.root, value.runId, value.taskId, value.handoffInput);
    expect(repeated.alreadyHandedOff).toBe(true);
    expect(repeated.authorityVersion).toBe(result.authorityVersion);
    expect(await runBytes(value)).toBe(before);
    await writeFile(resolve(value.root, value.appRoot, "feature.cjs"), "module.exports = 'changed after handoff';\n");
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("changed since publication");
  });

  test("handoff dry-run validates a real package and leaves authority/report state unchanged", async () => {
    const value = await runningFixture();
    await collectFixtureEvidence(value);
    const before = await runBytes(value);
    const version = await readAuthorityVersion(value.root, value.runId);
    const result = await handoffTask(value.root, value.runId, value.taskId, value.handoffInput, { dryRun: true });
    expect(result.taskStatus).toBe("running");
    expect(result.report.transition_request.to).toBe("awaiting_review");
    expect(await runBytes(value)).toBe(before);
    expect(await readAuthorityVersion(value.root, value.runId)).toBe(version);
    await expect(readFile(resolve(value.root, result.paths.report))).rejects.toThrow();
  });

  test("missing or stale collector evidence and changed command provenance cannot produce a handoff", async () => {
    const value = await runningFixture();
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("missing passed collector evidence");
    await collectFixtureEvidence(value);
    await writeFile(resolve(value.root, value.appRoot, "feature.cjs"), "module.exports = 'after'; // revised\n");
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("stale collector evidence");
    const projectPath = resolve(value.root, ".sdlc/project.yaml");
    const project = parse(await readFile(projectPath, "utf8"));
    project.commands.sdlc_test.args = ["-e", "process.exit(0)"];
    await writeFile(projectPath, stringify(project));
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("provenance");
    expect((await loadRun(value.root, value.runId)).tasks.find((entry) => entry.id === value.taskId)?.status).toBe("running");
  });

  test("wrong-scope files, unchanged files, and fabricated mechanical metadata are rejected without publication", async () => {
    const value = await runningFixture();
    await collectFixtureEvidence(value);
    const before = await runBytes(value);
    for (const changedFiles of [[{ path: "README.md", type: "source" as const }], [{ path: `${value.appRoot}/package.json`, type: "source" as const }], [{ path: `${value.appRoot}/feature.cjs`, type: "source" as const, repository: "another" }], [{ path: `.sdlc/runs/${value.runId}/facts.yaml`, type: "source" as const }]]) {
      await expect(handoffTask(value.root, value.runId, value.taskId, { ...value.handoffInput, changedFiles })).rejects.toThrow();
    }
    await expect(handoffTask(value.root, value.runId, value.taskId, { ...value.handoffInput, evidence: ["invented"] } as any)).rejects.toThrow("unsupported fields");
    await expect(handoffTask(value.root, value.runId, value.taskId, { ...value.handoffInput, requirementOutcomes: [] })).rejects.toThrow("exactly match");
    expect(await runBytes(value)).toBe(before);
  });

  test("backend contract and mobile tasks derive the correct target inventory and semantic observations", async () => {
    for (const target of ["backend", "mobile"] as const) {
      const value = await fixture({ target });
      const result = await activateAndHandoffFixture(value);
      expect(result.assignment.role).toBe(target === "backend" ? "backend" : "frontend");
      expect(result.assignment.target).toBe(target);
      expect(result.assignment.allowed_write_roots).toContain(value.appRoot);
      expect(result.report.artifacts.every((artifact) => artifact.path.includes(`/artifacts/${target}/`))).toBe(true);
      expect(result.taskStatus).toBe("awaiting_review");
    }
  });

  test("Next.js route-group application roots remain literal and scoped", async () => {
    const value = await fixture({ appRoot: "apps/platform/(portal)" });
    const result = await activateAndHandoffFixture(value);
    expect(result.assignment.allowed_write_roots).toContain("apps/platform/(portal)");
    expect(result.report.writes).toContainEqual({ path: "apps/platform/(portal)/feature.cjs", type: "source" });
    expect(result.assignment.allowed_write_roots).not.toContain(".");
  });

  test("publication followed by an interrupted transition can resume without changing its report or receipt", async () => {
    const value = await runningFixture();
    await collectFixtureEvidence(value);
    const failOnce = vi.spyOn(transitions, "prepareTransitionContext").mockRejectedValueOnce(new Error("simulated interruption before transition"));
    try { await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("simulated interruption"); }
    finally { failOnce.mockRestore(); }
    const reportPath = resolve(value.root, `.sdlc/runs/${value.runId}/artifacts/web/${value.taskId}-delivery-report.yaml`);
    const before = await readFile(reportPath, "utf8");
    expect((await loadRun(value.root, value.runId)).tasks.find((entry) => entry.id === value.taskId)?.status).toBe("running");
    const result = await handoffTask(value.root, value.runId, value.taskId, value.handoffInput);
    expect(result.alreadyHandedOff).toBe(true);
    expect(result.taskStatus).toBe("awaiting_review");
    expect(await readFile(reportPath, "utf8")).toBe(before);
    await collectFixtureEvidence(value);
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("collector evidence changed since publication");
  });

  test("unresolved frontend decisions, missing inputs, and stale fact bindings block automatic work", async () => {
    const value = await fixture();
    const inputPath = resolve(value.root, `.sdlc/runs/${value.runId}/artifacts/pm/requirements-review.md`);
    const inputSource = await readFile(inputPath, "utf8");
    await rm(inputPath);
    await expect(prepareTask(value.root, value.runId, value.taskId, value.input)).rejects.toThrow("required inputs");
    await writeFile(inputPath, inputSource);
    const blockedInput = structuredClone(value.input);
    if (!("api_contract_status" in blockedInput.controls)) throw new Error("expected frontend fixture");
    blockedInput.controls.api_contract_status = "missing";
    await expect(prepareTask(value.root, value.runId, value.taskId, blockedInput)).rejects.toThrow("unresolved");
    await prepareTask(value.root, value.runId, value.taskId, value.input);
    await activateFixture(value);
    await writeFixtureOutputs(value);
    await collectFixtureEvidence(value);
    const factsPath = resolve(value.root, `.sdlc/runs/${value.runId}/facts.yaml`);
    const facts = parse(await readFile(factsPath, "utf8"));
    facts.revision += 1;
    await writeFile(factsPath, stringify(facts));
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("authority mismatch");
  });

  test("a repaired task advances assignment revision, collects fresh evidence, and keeps archived work intact", async () => {
    const value = await fixture();
    const original = await activateAndHandoffFixture(value);
    await recordQualityGate(value.root, value.runId, "web", "passed", original.report.evidence.map((entry) => entry.reference!), "pm", "Fixture review passed", new Date().toISOString());
    await mutateRunManifest(value.root, value.runId, async (manifest) => {
      const request = { taskId: value.taskId, to: "completed" as const, actor: "pm", reason: "Fixture independent review accepted", at: new Date().toISOString() };
      Object.assign(manifest, transitions.transitionTask(manifest, request, await transitions.prepareTransitionContext(value.root, value.runId, manifest, request)));
    });
    const repair = await repairTask(value.root, value.runId, value.taskId, { actor: "pm", defectId: "DEF-001", reason: "Correct the reviewed feature" });
    const prepared = await prepareTask(value.root, value.runId, value.taskId, value.input);
    expect(prepared.assignment.assignment_id).toBe(original.assignment.assignment_id);
    expect(prepared.assignment.revision).toBeGreaterThan(original.assignment.revision);
    expect(prepared.assignment.available_evidence).toEqual([]);
    await activateFixture(value);
    await writeFixtureOutputs(value);
    await expect(handoffTask(value.root, value.runId, value.taskId, value.handoffInput)).rejects.toThrow("missing passed collector evidence");
    await collectFixtureEvidence(value);
    const fixed = await handoffTask(value.root, value.runId, value.taskId, value.handoffInput);
    expect(fixed.taskStatus).toBe("awaiting_review");
    expect(fixed.report.evidence[0]!.evidence_id).not.toBe(original.report.evidence[0]!.evidence_id);
    const archivedReport = repair.repair.archives.find((entry) => entry.path.endsWith("delivery-report.yaml"))!;
    expect(parse(await readFile(resolve(value.root, `.sdlc/runs/${value.runId}/${archivedReport.archive_path}`), "utf8"))).toEqual(original.report);
  });

  test("a rejected review starts a fresh repair cycle without approving the rejected handoff", async () => {
    const value = await fixture();
    const rejected = await activateAndHandoffFixture(value);
    const repair = await repairTask(value.root, value.runId, value.taskId, { actor: "pm", defectId: "DEF-REVIEW-001", reason: "Independent review found incorrect status rendering" });
    expect(repair.repair.tasks.find((entry) => entry.id === value.taskId)?.status).toBe("awaiting_review");
    const prepared = await prepareTask(value.root, value.runId, value.taskId, value.input);
    expect(prepared.taskStatus).toBe("ready");
    expect(prepared.assignment.revision).toBeGreaterThan(rejected.assignment.revision);
    expect(prepared.assignment.available_evidence).toEqual([]);
    await activateFixture(value);
    await writeFixtureOutputs(value);
    await collectFixtureEvidence(value);
    const fixed = await handoffTask(value.root, value.runId, value.taskId, value.handoffInput);
    expect(fixed.taskStatus).toBe("awaiting_review");
    const current = (await loadRun(value.root, value.runId)).tasks.find((entry) => entry.id === value.taskId)!;
    expect(current.transitions.some((entry) => entry.to === "completed")).toBe(false);
    expect(fixed.report.evidence[0]!.evidence_id).not.toBe(rejected.report.evidence[0]!.evidence_id);
  });

  test("a closed rejected gap remains rejected throughout preparation and handoff", async () => {
    const value = await fixture();
    if (!("gaps" in value.input.controls)) throw new Error("expected frontend fixture");
    const gap = { gap_id: "GAP-001", kind: "design" as const, state: "rejected" as const, question_ids: [] as [], resolution_reference: "FACT-001" };
    value.input.controls.gaps = [gap];
    const result = await activateAndHandoffFixture(value);
    expect(result.taskStatus).toBe("awaiting_review");
    expect(result.assignment.controls).toMatchObject({ gaps: [gap] });
    expect(result.report.observations).toMatchObject({ gaps: [gap] });
  });
});
