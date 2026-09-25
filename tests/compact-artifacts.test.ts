import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { stringify, parse } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import { assertCompactReview, assertCompactVerification, compactPaths, publishCompactSpecification, readCompactSpecification, readCompactVerification, reviewCompactSpecification, type CompactObservation, type CompactQcVerification, type CompactSpecificationInput } from "../src/compact-artifacts.js";
import { canonicalizeCommandDeclaration } from "../src/command-provenance.js";
import { loadProject } from "../src/config.js";
import { initializeProject } from "../src/install.js";
import { readAuthorityVersion } from "../src/manifest-transaction.js";
import { startRun, loadRun } from "../src/runs.js";
import { validateDocument } from "../src/schemas.js";
import type { RunManifest, Task } from "../src/types.js";

const roots: string[] = [];
const runId = "COMPACT-001";
const at = "2026-09-25T01:00:00.000Z";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const assessment = { bounded_scope: true as const, existing_patterns: true as const, migrations: false as const, breaking_api: false as const, authorization_changes: false as const, sensitive_data_exposure: false as const, cross_system_uncertainty: false as const, rationale: "An existing bounded portal behavior with unchanged service contract." };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function put(root: string, path: string, content: string) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content); }
function input(): CompactSpecificationInput {
  return { scope: { summary: "Show the selected status", in_scope: ["Portal status"], out_of_scope: ["New services"] }, requirements: [{ id: "REQ-001", description: "Show the current status", fact_ids: ["FACT-001", "FACT-002"] }], acceptance_criteria: [{ id: "AC-001", requirement_id: "REQ-001", given: "an existing record", when: "the user opens the portal", then: "the approved status and count appear", evidence_types: ["command", "ui"] }], api_change: { kind: "unchanged", description: "Use the existing status response." } };
}
function setState(task: Task, status: "running" | "completed") {
  task.status = status; task.started_at = at; task.completed_at = status === "completed" ? at : null;
  task.transitions = [{ from: "pending", to: "ready", actor: "pm", reason: "Fixture dependencies", at }, { from: "ready", to: "running", actor: task.role, reason: "Fixture activation", at }];
  if (status === "completed") task.transitions.push({ from: "running", to: "awaiting_review", actor: task.role, reason: "Fixture handoff", at }, { from: "awaiting_review", to: "completed", actor: "pm", reason: "Fixture review", at });
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "sdlc-compact-artifacts-")); roots.push(root);
  await mkdir(resolve(root, "apps/platform"), { recursive: true });
  await initializeProject({ root, projectName: "Compact artifacts", applications: ["web"], webRoot: "apps/platform", dryRun: false });
  await put(root, ".sdlc/requests/compact.md", "Show status and count using the existing behavior.\n");
  await startRun(root, { id: runId, title: "Status", requestFile: ".sdlc/requests/compact.md", affectedApplications: { backend: false, web: true, mobile: false, database: false, sharedPackages: false }, profile: "compact", assessment, now: at });
  const manifest = await loadRun(root, runId);
  setState(manifest.tasks.find((task) => task.id === "PM-001")!, "completed");
  setState(manifest.tasks.find((task) => task.id === "BA-001")!, "running");
  const facts = { schema_version: 1, run_id: runId, producer: "pm", revision: 1, facts: [{ id: "FACT-001", subject: "portal.status", relation: "equals", value: { status: "ready", visible: true }, status: "approved" }, { id: "FACT-002", subject: "portal.count", relation: "range", value: { min: 0, max: 10, unit: "records", inclusive_min: true, inclusive_max: true }, status: "approved" }] };
  const prefix = `.sdlc/runs/${runId}`;
  await put(root, `${prefix}/manifest.yaml`, stringify(manifest));
  await put(root, `${prefix}/facts.yaml`, stringify(facts));
  return { root, manifest, facts, prefix };
}

describe("compact specification", () => {
  test("publishes one authored specification and exact typed compatibility views without passing a gate", async () => {
    const f = await fixture();
    const before = await readFile(resolve(f.root, `${f.prefix}/manifest.yaml`), "utf8");
    const result = await publishCompactSpecification(f.root, runId, input());
    expect(result.paths).toEqual([compactPaths.specification, compactPaths.semanticClaims, compactPaths.acceptanceCriteria]);
    expect(result.authorityVersion).toBe(1);
    const view = parse(await readFile(resolve(f.root, `${f.prefix}/${compactPaths.semanticClaims}`), "utf8"));
    expect(validateDocument("semanticClaims", view)).toEqual({ valid: true, diagnostics: [] });
    expect(view.claims.map((claim: Record<string, unknown>) => ({ id: claim.source_fact_id, subject: claim.subject, relation: claim.relation, value: claim.value, status: claim.status }))).toEqual(f.facts.facts);
    expect(view.claims.every((claim: { requirement_ids: string[] }) => claim.requirement_ids.join() === "REQ-001")).toBe(true);
    expect(await readFile(resolve(f.root, `${f.prefix}/manifest.yaml`), "utf8")).toBe(before);
    expect((await readCompactSpecification(f.root, runId, f.manifest)).document).toEqual(result.document);
  });

  test("dry-run writes nothing and stale authority tokens reject before replacement", async () => {
    const f = await fixture();
    const preview = await publishCompactSpecification(f.root, runId, input(), { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(await readAuthorityVersion(f.root, runId)).toBe(0);
    await expect(readFile(resolve(f.root, `${f.prefix}/${compactPaths.specification}`))).rejects.toThrow();
    await publishCompactSpecification(f.root, runId, input());
    await expect(publishCompactSpecification(f.root, runId, input(), { expectedVersion: 0 })).rejects.toThrow("stale authority version");
  });

  test.each([
    ["fabricated fact", (value: CompactSpecificationInput) => { value.requirements[0]!.fact_ids = ["FACT-999"]; }],
    ["missing approved fact", (value: CompactSpecificationInput) => { value.requirements[0]!.fact_ids = ["FACT-001"]; }],
    ["duplicate requirement", (value: CompactSpecificationInput) => { value.requirements.push(structuredClone(value.requirements[0]!)); }],
    ["duplicate AC", (value: CompactSpecificationInput) => { value.acceptance_criteria.push(structuredClone(value.acceptance_criteria[0]!)); }],
    ["unknown REQ", (value: CompactSpecificationInput) => { value.acceptance_criteria[0]!.requirement_id = "REQ-999"; }],
    ["missing evidence declaration", (value: CompactSpecificationInput) => { value.acceptance_criteria[0]!.evidence_types = []; }],
    ["breaking API", (value: CompactSpecificationInput) => { value.api_change.kind = "breaking" as "additive"; }],
    ["unaffected backend additive API", (value: CompactSpecificationInput) => { value.api_change.kind = "additive"; }],
  ] as const)("rejects %s without publishing", async (_name, change) => {
    const f = await fixture(); const value = input(); change(value);
    await expect(publishCompactSpecification(f.root, runId, value)).rejects.toThrow();
    expect(await readAuthorityVersion(f.root, runId)).toBe(0);
  });

  test("does not promote unresolved facts or duplicate typed facts", async () => {
    const f = await fixture();
    f.facts.facts[0]!.status = "unresolved";
    await put(f.root, `${f.prefix}/facts.yaml`, stringify(f.facts));
    await expect(publishCompactSpecification(f.root, runId, input())).rejects.toThrow("unresolved");
    f.facts.facts[0]!.status = "approved";
    f.facts.facts.push(structuredClone(f.facts.facts[0]!));
    await put(f.root, `${f.prefix}/facts.yaml`, stringify(f.facts));
    await expect(publishCompactSpecification(f.root, runId, input())).rejects.toThrow("duplicate");
  });

  test.each([compactPaths.specification, compactPaths.semanticClaims, compactPaths.acceptanceCriteria, "facts.yaml"])("review binding detects later edits to %s", async (path) => {
    const f = await fixture(); await publishCompactSpecification(f.root, runId, input());
    f.manifest.compact_review = await reviewCompactSpecification(f.root, runId, f.manifest);
    await assertCompactReview(f.root, runId, f.manifest);
    await put(f.root, `${f.prefix}/${path}`, (await readFile(resolve(f.root, `${f.prefix}/${path}`), "utf8")) + "\n# changed after review\n");
    await expect(assertCompactReview(f.root, runId, f.manifest)).rejects.toThrow();
  });

  test("rejects symlink escape for a generated specification view", async () => {
    const f = await fixture(); await publishCompactSpecification(f.root, runId, input());
    const outside = await mkdtemp(resolve(tmpdir(), "sdlc-compact-outside-")); roots.push(outside);
    const path = `${f.prefix}/${compactPaths.semanticClaims}`;
    await put(outside, "claims.yaml", await readFile(resolve(f.root, path), "utf8"));
    await rm(resolve(f.root, path)); await symlink(resolve(outside, "claims.yaml"), resolve(f.root, path));
    await expect(reviewCompactSpecification(f.root, runId, f.manifest)).rejects.toThrow("escapes repository root");
  });
});

// These are explicit validator fixtures, not claims that an application test was executed.
async function verificationFixture() {
  const f = await fixture(); await publishCompactSpecification(f.root, runId, input());
  f.manifest.compact_review = await reviewCompactSpecification(f.root, runId, f.manifest);
  const qc = f.manifest.tasks.find((task) => task.id === "QC-001")!;
  setState(qc, "running");
  const reference = "evidence/commands/EVD-0000000000000000/evidence.json";
  const project = await loadProject(f.root);
  const command = await canonicalizeCommandDeclaration(f.root, project.commands.sdlc_test, [], project);
  const collector = { schema_version: 1, id: "EVD-0000000000000000", run_id: runId, task_id: "QC-001", command_id: "sdlc_test", ...command.provenance, started_at: at, completed_at: at, exit_code: 0, result_status: "passed", evidence_path: reference, stdout_path: reference.replace("evidence.json", "stdout.txt"), stderr_path: reference.replace("evidence.json", "stderr.txt") };
  const collectorSource = JSON.stringify(collector);
  qc.evidence = [reference];
  await put(f.root, `${f.prefix}/${reference}`, collectorSource);
  await put(f.root, `${f.prefix}/${collector.stdout_path}`, "Fixture collector output.\n");
  await put(f.root, `${f.prefix}/${collector.stderr_path}`, "");
  const observation: CompactObservation = { schema_version: 1, run_id: runId, task_id: "QC-001", producer: "qc", revision: 1, evidence_type: "ui", observed_at: at, environment: "Isolated fixture browser", procedure: "Open existing status screen", actual_result: "Ready status and count displayed", status: "passed" };
  const observationReference = "artifacts/qc/evidence/status.yaml";
  await put(f.root, `${f.prefix}/${observationReference}`, stringify(observation));
  const document: CompactQcVerification = { schema_version: 1, run_id: runId, task_id: "QC-001", producer: "qc", revision: 1, reviewed_specification: f.manifest.compact_review, collector_evidence: [{ reference, sha256: hash(collectorSource), status: "passed" }], results: [{ ac_id: "AC-001", status: "passed", evidence: [{ type: "command", reference, sha256: hash(collectorSource) }, { type: "ui", reference: observationReference, sha256: hash(stringify(observation)) }], notes: "Direct checks matched the expected status." }], defects: [], recommendation: "ready" };
  return { ...f, document, reference, collector, observation, observationReference };
}
async function writeVerification(f: Awaited<ReturnType<typeof verificationFixture>>) {
  await put(f.root, `${f.prefix}/${compactPaths.verification}`, stringify(f.document));
  await put(f.root, `${f.prefix}/${compactPaths.summary}`, `---\nrun_id: ${runId}\ntask_id: QC-001\nproducer: qc\nrevision: ${f.document.revision}\n---\n\n# Independent verification\n\nRecommendation: ${f.document.recommendation}\n\n${f.document.results.map((result) => `- ${result.ac_id}: ${result.status}. ${result.notes}`).join("\n")}\n\nOpen defects: ${f.document.defects.filter((defect) => defect.status === "open").map((defect) => defect.id).join(", ") || "none"}\n`);
}

describe("compact independent verification", () => {
  test("accepts exact AC coverage backed by independent typed direct evidence", async () => {
    const f = await verificationFixture(); await writeVerification(f);
    await expect(assertCompactVerification(f.root, runId, f.manifest)).resolves.toBeUndefined();
  });
  test.each(["failed", "blocked", "not_tested"] as const)("preserves honest %s coverage without readiness", async (status) => {
    const f = await verificationFixture(); f.document.results[0]!.status = status; f.document.recommendation = "changes_requested";
    await writeVerification(f);
    expect((await readCompactVerification(f.root, runId, f.manifest)).results[0]!.status).toBe(status);
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("not ready");
  });
  test.each([
    ["missing AC", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results = []; }],
    ["duplicate AC", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results.push(structuredClone(f.document.results[0]!)); }],
    ["wrong AC", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results[0]!.ac_id = "AC-999"; }],
    ["missing evidence type", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results[0]!.evidence.pop(); }],
    ["self citation", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results[0]!.evidence[1]!.reference = compactPaths.verification; }],
    ["request citation", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results[0]!.evidence[1]!.reference = "request.md"; }],
    ["invented hash", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.results[0]!.evidence[1]!.sha256 = "0".repeat(64); }],
    ["unknown defect AC", (f: Awaited<ReturnType<typeof verificationFixture>>) => { f.document.defects.push({ id: "DEF-001", ac_ids: ["AC-999"], status: "resolved", severity: "low", summary: "Fixture" }); }],
  ] as const)("rejects %s", async (_name, change) => {
    const f = await verificationFixture(); change(f); await writeVerification(f);
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow();
  });
  test("open defects keep recommendation honest even when every AC passed", async () => {
    const f = await verificationFixture();
    f.document.defects = [{ id: "DEF-001", ac_ids: ["AC-001"], status: "open", severity: "low", summary: "Additional observed issue" }];
    f.document.recommendation = "changes_requested"; await writeVerification(f);
    expect((await readCompactVerification(f.root, runId, f.manifest)).recommendation).toBe("changes_requested");
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("not ready");
  });
  test("implementation-owned collectors and observations cannot stand in for independent QC", async () => {
    const f = await verificationFixture();
    f.collector.task_id = "WEB-001";
    await put(f.root, `${f.prefix}/${f.reference}`, JSON.stringify(f.collector));
    await writeVerification(f);
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("task ID does not match task");
    f.collector.task_id = "QC-001";
    await put(f.root, `${f.prefix}/${f.reference}`, JSON.stringify(f.collector));
    f.observation.producer = "frontend" as "qc";
    await put(f.root, `${f.prefix}/${f.observationReference}`, stringify(f.observation));
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("direct QC observation");
  });
  test("requires independent collector even if all declared AC evidence is direct observation", async () => {
    const f = await verificationFixture();
    const revisedInput = input(); revisedInput.acceptance_criteria[0]!.evidence_types = ["ui"];
    await publishCompactSpecification(f.root, runId, revisedInput);
    f.manifest.compact_review = await reviewCompactSpecification(f.root, runId, f.manifest);
    f.document.reviewed_specification = f.manifest.compact_review;
    f.manifest.tasks.find((task) => task.id === "QC-001")!.evidence = [];
    f.document.collector_evidence = [];
    f.document.results[0]!.evidence.shift(); f.document.recommendation = "changes_requested";
    await writeVerification(f);
    expect((await readCompactVerification(f.root, runId, f.manifest)).recommendation).toBe("changes_requested");
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("not ready");
  });
  test("evidence edits after QC publication invalidate the verification", async () => {
    const f = await verificationFixture(); await writeVerification(f);
    await put(f.root, `${f.prefix}/${f.observationReference}`, stringify({ ...f.observation, actual_result: "Different result" }));
    await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("evidence changed");
  });
});

test("Compact cannot silently omit an unresolved feature fact", async () => {
  const f = await fixture();
  f.facts.facts[1]!.status = "unresolved";
  await put(f.root, `${f.prefix}/facts.yaml`, stringify(f.facts));
  const value = input(); value.requirements[0]!.fact_ids = ["FACT-001"];
  await expect(publishCompactSpecification(f.root, runId, value)).rejects.toThrow("cannot omit unresolved");
  f.facts.facts[1]!.status = "out_of_scope";
  await put(f.root, `${f.prefix}/facts.yaml`, stringify(f.facts));
  const result = await publishCompactSpecification(f.root, runId, value);
  expect(result.document.requirements[0]!.fact_ids).toEqual(["FACT-001"]);
  const claims = parse(await readFile(resolve(f.root, `${f.prefix}/${compactPaths.semanticClaims}`), "utf8"));
  expect(claims.claims).toHaveLength(1);
});

async function appendCollector(f: Awaited<ReturnType<typeof verificationFixture>>, suffix: string, commandId: "sdlc_test" | "sdlc_typecheck", status: "passed" | "failed") {
  const id = `EVD-${suffix.padStart(16, "0")}`;
  const reference = `evidence/commands/${id}/evidence.json`;
  const project = await loadProject(f.root);
  const command = await canonicalizeCommandDeclaration(f.root, project.commands[commandId], [], project);
  const record = { ...f.collector, ...command.provenance, id, command_id: commandId, exit_code: status === "passed" ? 0 : 1, result_status: status, evidence_path: reference, stdout_path: reference.replace("evidence.json", "stdout.txt"), stderr_path: reference.replace("evidence.json", "stderr.txt") };
  const content = JSON.stringify(record);
  await put(f.root, `${f.prefix}/${reference}`, content);
  await put(f.root, `${f.prefix}/${record.stdout_path}`, `Fixture ${status}.\n`);
  await put(f.root, `${f.prefix}/${record.stderr_path}`, "");
  f.manifest.tasks.find((task) => task.id === "QC-001")!.evidence.push(reference);
  return { reference, sha256: hash(content), status };
}

test("latest failed QC check blocks readiness despite another passed check; passing rerun recovers", async () => {
  const f = await verificationFixture();
  const failedA = await appendCollector(f, "2", "sdlc_test", "failed");
  const passedB = await appendCollector(f, "3", "sdlc_typecheck", "passed");
  f.document.collector_evidence = [failedA, passedB];
  f.document.recommendation = "changes_requested";
  await writeVerification(f);
  await expect(readCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("superseded");

  // A different passing check cannot hide the latest failure, even if all cases assert passed.
  f.document.results[0]!.evidence[0] = { type: "command", reference: passedB.reference, sha256: passedB.sha256 };
  await writeVerification(f);
  expect((await readCompactVerification(f.root, runId, f.manifest)).recommendation).toBe("changes_requested");
  await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("not ready");
  f.document.recommendation = "ready";
  await writeVerification(f);
  await expect(assertCompactVerification(f.root, runId, f.manifest)).rejects.toThrow("recommendation");

  const rerunA = await appendCollector(f, "4", "sdlc_test", "passed");
  f.document.collector_evidence = [rerunA, passedB];
  f.document.results[0]!.evidence[0] = { type: "command", reference: rerunA.reference, sha256: rerunA.sha256 };
  await writeVerification(f);
  await expect(assertCompactVerification(f.root, runId, f.manifest)).resolves.toBeUndefined();
});
