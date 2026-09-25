import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import { resolveRepositoryDeliveryAuthority, resolveRepositoryDeliveryReportPackage } from "../src/delivery-authority-resolver.js";
import { reconcileDeliveryReportPackage, type DeliveryReportPackage } from "../src/delivery-report-reconciliation.js";
import { initializeProject } from "../src/install.js";
import { isPortableRepositoryPath } from "../src/paths.js";
import { loadRun, startRun } from "../src/runs.js";
import { validateDocument } from "../src/schemas.js";
import type { BackendRequirementInventory, DeliveryAssignment, DeliveryReport, WebDeliveryAssignment } from "../src/semantic-contracts.js";

const roots: string[] = [];
const runId = "COMPAT-001";
const runRoot = `.sdlc/runs/${runId}`;
const at = "2026-09-25T00:00:00.000Z";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function put(root: string, path: string, source: string) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), source);
}

/** Exercise real configured roots, permission policy, run bytes, and on-disk report artifacts. */
async function fixture(target: "web" | "backend" = "web") {
  const root = await mkdtemp(resolve(tmpdir(), "sdlc-compatibility-"));
  roots.push(root);
  await mkdir(resolve(root, "apps/api"), { recursive: true });
  await mkdir(resolve(root, "apps/platform"), { recursive: true });
  await initializeProject({ root, projectName: "Compatibility", applications: ["backend", "web"], backendRoot: "apps/api", webRoot: "apps/platform", dryRun: false });
  await put(root, ".sdlc/requests/change.md", "Expose the business feature through the API and portal.\n");
  await startRun(root, { id: runId, title: "Compatibility", requestFile: ".sdlc/requests/change.md", affectedApplications: { backend: true, web: true, mobile: false, database: false, sharedPackages: false }, now: at });
  const manifest = await loadRun(root, runId);
  const taskId = target === "web" ? "WEB-001" : "BE-002";
  const task = manifest.tasks.find((entry) => entry.id === taskId)!;
  task.dependencies = [];
  task.required_inputs = [];
  task.required_outputs = [`artifacts/${target}/implementation-summary.md`];
  task.status = "running";
  task.started_at = at;
  task.transitions = [
    { from: "pending", to: "ready", actor: "pm", reason: "Fixture activation", at },
    { from: "ready", to: "running", actor: "pm", reason: "Fixture implementation", at },
  ];
  await put(root, `${runRoot}/manifest.yaml`, stringify(manifest));
  const facts = "schema_version: 1\nrun_id: COMPAT-001\nproducer: pm\nrevision: 1\nfacts:\n  - id: FACT-001\n    subject: feature.delivery\n    relation: equals\n    value: true\n    status: approved\n";
  await put(root, `${runRoot}/facts.yaml`, facts);
  const artifactPath = `${runRoot}/artifacts/${target}/implementation-summary.md`;
  const artifactSource = "---\nrevision: 1\n---\nImplemented the feature.\n";
  const appRoot = target === "web" ? "apps/platform" : "apps/api";
  const sourcePath = target === "web" ? `${appRoot}/app/(portal)/items/[id]/page.tsx` : `${appRoot}/src/items.ts`;
  const common = {
    schema_version: 1 as const, kind: "delivery_assignment" as const, assignment_id: "ASN-001", run_id: runId, task_id: taskId,
    producer: "pm" as const, revision: 1, facts_revision: 1, facts_sha256: hash(facts), task_status: "running" as const,
    scaffold_status: "scaffolded" as const, dependencies: [], required_inputs: [],
    required_outputs: [{ path: artifactPath, artifact_kind: "implementation_summary" as const, producer: target === "web" ? "frontend" as const : "backend" as const, required: true }],
    allowed_write_roots: [appRoot, `${runRoot}/artifacts/${target}`], available_evidence: [], evidence_requirements: [],
    transition_policy: { current_status: "running" as const, allowed_request: "awaiting_review" as const, unmet_disposition: "refuse" as const },
  };
  const assignment: DeliveryAssignment = target === "web" ? {
    ...common, role: "frontend", target: "web", stage: "web_implementation", scenario: "full_task",
    controls: { api_contract_status: "approved", gaps: [], questions: [], requirements: ["semantic_status", "output_escaping"].map((capability) => ({ requirement_id: "REQ-001", capability, required: true, parameters: {}, source_references: [{ kind: "fact", reference: "FACT-001" }] })) },
  } : {
    ...common, role: "backend", target: "backend", stage: "backend_implementation", scenario: "full_task",
    controls: { mode: "implementation", storage: { postgresql_role: "durable_truth", redis_roles: [], redis_authoritative: false }, migration: { impact: "none", approval_status: "not_required", decision_id: null }, api_requirements: ["request", "response", "error", "authentication", "authorization"].map((capability) => ({ requirement_id: "REQ-001", capability, required: true, source_references: [{ kind: "fact", reference: "FACT-001" }] })) as BackendRequirementInventory },
  };
  const requirements = assignment.role === "backend" ? assignment.controls.api_requirements : assignment.controls.requirements;
  const observations = assignment.role === "backend" ? { mode: assignment.controls.mode, storage: assignment.controls.storage, migration: assignment.controls.migration, requirement_results: requirements.map(({ requirement_id, capability, required }) => ({ requirement_id, capability, required, status: "implemented" })) } : { api_contract_status: "approved", gaps: [], questions: [], requirement_results: requirements.map(({ requirement_id, capability, required }) => ({ requirement_id, capability, required, status: "implemented" })) };
  const report = {
    schema_version: 1, kind: "delivery_report", assignment_id: assignment.assignment_id, assignment_revision: 1, run_id: runId, task_id: taskId,
    producer: assignment.role, role: assignment.role, target: assignment.target, stage: assignment.stage, scenario: assignment.scenario,
    revision: 1, disposition: "proceed", transition_request: { from: "running", to: "awaiting_review" },
    artifacts: [{ path: artifactPath, artifact_kind: "implementation_summary", producer: assignment.role, status: "produced", revision: 1, sha256: hash(artifactSource) }],
    writes: [{ path: sourcePath, type: "source" }, { path: artifactPath, type: "artifact" }], evidence: [], observations,
  } as DeliveryReport;
  const assignmentPath = `${runRoot}/tasks/${taskId}.assignment.yaml`;
  await put(root, assignmentPath, stringify(assignment));
  await put(root, artifactPath, artifactSource);
  await put(root, sourcePath, "export const status = 'ready';\n");
  await put(root, `${runRoot}/artifacts/${target}/${taskId}-delivery-report.yaml`, stringify(report));
  await put(root, `${runRoot}/evidence/diffs/changed-files.json`, JSON.stringify({ files: [sourcePath, artifactPath], ownership: [{ path: sourcePath, task_id: taskId }] }));
  const resolved = await resolveRepositoryDeliveryReportPackage(root, assignmentPath);
  const pkg: DeliveryReportPackage = { schema_version: 1, kind: "structured_delivery_evaluation", scenario_id: "real-layout", assignment: resolved.assignment, authority_snapshot: resolved.authoritySnapshot, authority_integrity: resolved.authorityIntegrity, artifact_integrity: resolved.artifactIntegrity, report: resolved.report };
  return { root, assignmentPath, pkg, sourcePath };
}

describe("v1 document compatibility", () => {
  test.each(["web", "backend"] as const)("reconciles complete %s reports in configured apps/platform and apps/api roots", async (target) => {
    const { pkg } = await fixture(target);
    expect(reconcileDeliveryReportPackage(pkg)).toEqual({ valid: true, diagnostics: [] });
    expect(new Set(pkg.report.observations.requirement_results.map((result) => result.requirement_id))).toEqual(new Set(["REQ-001"]));
  });

  test("keeps existing unique requirement IDs valid and checks each capability independently", async () => {
    const { pkg } = await fixture();
    const assignment = pkg.assignment as WebDeliveryAssignment;
    assignment.controls.requirements.forEach((requirement, index) => { requirement.requirement_id = `REQ-00${index + 1}`; });
    pkg.report.observations.requirement_results.forEach((result, index) => { result.requirement_id = `REQ-00${index + 1}`; });
    expect(reconcileDeliveryReportPackage(pkg)).toEqual({ valid: true, diagnostics: [] });
    pkg.report.observations.requirement_results[1]!.requirement_id = "REQ-001";
    expect(reconcileDeliveryReportPackage(pkg).diagnostics.join("\n")).toContain("output_escaping.requirement_id");
  });

  test("does not let a completed capability satisfy another capability under the same REQ", async () => {
    const { pkg } = await fixture();
    pkg.report.observations.requirement_results[1]!.status = "planned";
    expect(reconcileDeliveryReportPackage(pkg).diagnostics.join("\n")).toContain("transition_request.to expected null");
    pkg.report.transition_request.to = null;
    pkg.assignment.transition_policy.allowed_request = null;
    expect(reconcileDeliveryReportPackage(pkg)).toEqual({ valid: true, diagnostics: [] });
    pkg.report.observations.requirement_results.pop();
    expect(reconcileDeliveryReportPackage(pkg).diagnostics.join("\n")).toContain("missing capability output_escaping");
  });

  test("rejects duplicate capabilities in assignments and reports", async () => {
    const { pkg } = await fixture();
    const assignment = pkg.assignment as WebDeliveryAssignment;
    assignment.controls.requirements[1]!.capability = assignment.controls.requirements[0]!.capability;
    expect(validateDocument("deliveryAssignment", assignment).diagnostics.join("\n")).toContain("duplicates semantic key capability");
    pkg.report.observations.requirement_results[1]!.capability = pkg.report.observations.requirement_results[0]!.capability;
    expect(validateDocument("deliveryReport", pkg.report).diagnostics.join("\n")).toContain("duplicates semantic key capability");
  });

  test("cannot enlarge project-backed authority by supplying another target's roots", async () => {
    const { root, assignmentPath, pkg } = await fixture();
    pkg.assignment.allowed_write_roots.push("apps/api");
    await put(root, assignmentPath, stringify(pkg.assignment));
    await expect(resolveRepositoryDeliveryAuthority(root, assignmentPath)).rejects.toThrow("workflow.permission_roots");
    pkg.report.writes[0]!.path = "apps/api/src/stolen.ts";
    const validation = reconcileDeliveryReportPackage(pkg);
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.join("\n")).toContain("not owned by target web");
  });

  test("rejects writes to another repository even when the path matches", async () => {
    const { pkg } = await fixture();
    pkg.assignment.repository = "platform";
    pkg.report.repository = "platform";
    pkg.authority_snapshot.task.repository = "platform";
    pkg.report.writes[0]!.repository = "api";
    expect(reconcileDeliveryReportPackage(pkg).diagnostics.join("\n")).toContain("outside assignment repository platform");
  });

  test("keeps filesystem symlink escape protection for valid route-group paths", async () => {
    const { root, assignmentPath, sourcePath } = await fixture();
    const outside = await mkdtemp(resolve(tmpdir(), "sdlc-outside-"));
    roots.push(outside);
    await put(outside, "page.tsx", "outside\n");
    await rm(resolve(root, sourcePath));
    await symlink(resolve(outside, "page.tsx"), resolve(root, sourcePath));
    await expect(resolveRepositoryDeliveryAuthority(root, assignmentPath)).rejects.toThrow("escapes repository root");
  });

  test("schema paths use the complete runtime portable grammar", async () => {
    const { pkg } = await fixture();
    const paths = ["apps/platform/app/(portal)/[id]/page.tsx", "apps/platform/app/[[...slug]]/page.tsx", "apps/platform/nhãn có dấu.ts", ".", "../escape", "apps/../api", "apps//page.tsx", "C:/escape", "apps\\page.tsx", "apps/CON.txt", "apps/LPT¹.log", "apps/trailing.", "apps/trailing ", "apps/nul", "apps/a?b", "apps/e\u0301.ts", "apps/\u0000.ts"];
    for (const path of paths) {
      const report = structuredClone(pkg.report);
      report.writes[0]!.path = path;
      expect(validateDocument("deliveryReport", report).valid, path).toBe(isPortableRepositoryPath(path));
      const assignment = structuredClone(pkg.assignment);
      assignment.allowed_write_roots = [path];
      expect(validateDocument("deliveryAssignment", assignment).valid, path).toBe(isPortableRepositoryPath(path));
    }
  });
});
