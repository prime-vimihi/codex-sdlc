import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { initializeProject } from "../src/install.js";
import { startRun } from "../src/runs.js";
import { getRunTiming, summarizeRunTiming } from "../src/run-timing.js";
import type { EvidenceRecord, RunManifest, Task, TaskStatus } from "../src/types.js";
const epoch = Date.parse("2026-09-25T00:00:00.000Z");
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sdlc-timing-")); roots.push(root);
  await mkdir(join(root, "web"));
  await initializeProject({ root, projectName: "Timing", applications: ["web"], webRoot: "web", dryRun: false });
  await writeFile(join(root, ".sdlc/requests/request.md"), "Timing fixture");
  await startRun(root, { id: "TIME-001", title: "Timing", requestFile: ".sdlc/requests/request.md", affectedApplications: { backend: false, web: true, mobile: false, database: false, sharedPackages: false }, now: at(0) });
  const manifest = parse(await readFile(join(root, ".sdlc/runs/TIME-001/manifest.yaml"), "utf8")) as RunManifest;
  return { root, manifest };
}
function timeline(base: Task, states: Array<[TaskStatus, number]>): Task {
  return { ...base, status: states.at(-1)?.[0] ?? "pending", transitions: states.map(([to, seconds], index) => ({ from: states[index - 1]?.[0] ?? null, to, at: at(seconds), actor: "test", reason: "fixture" })) };
}
function evidence(): EvidenceRecord {
  return { schema_version: 1, id: "EVD-0000000000000000", run_id: "TIME-001", task_id: "PM-001", command_id: "sdlc_test", executable: "node", args: [], cwd: ".", started_at: at(2), completed_at: at(5), exit_code: 0, result_status: "passed", evidence_path: "evidence/commands/EVD-0000000000000000/evidence.json", stdout_path: "evidence/commands/EVD-0000000000000000/stdout.txt", stderr_path: "evidence/commands/EVD-0000000000000000/stderr.txt" };
}
describe("durable run timing", () => {
  test("new run has zero elapsed time and no inferred command or LLM duration", async () => {
    const { manifest } = await fixture();
    const report = summarizeRunTiming(manifest, { now: at(0) });
    expect(report.wall_ms).toBe(0); expect(report.collector_command_ms).toBe(0);
    expect(report.tasks.flatMap((task) => task.intervals).every((interval) => interval.duration_ms === 0)).toBe(true);
  });
  test("separates ready, running, review, approval, blocked, and resumed running intervals", async () => {
    const { manifest } = await fixture();
    manifest.tasks = [timeline(manifest.tasks[0]!, [["ready", 0], ["running", 2], ["awaiting_review", 5], ["awaiting_approval", 9], ["blocked", 14], ["running", 20]])];
    const report = summarizeRunTiming(manifest, { now: at(25) });
    expect(report.task_status_ms).toEqual({ ready: 2000, running: 8000, awaiting_review: 4000, awaiting_approval: 5000, blocked: 6000 });
    expect(report.tasks[0]!.intervals.at(-1)?.ongoing).toBe(true);
    expect(report.wall_ms).toBe(25000);
  });
  test("counts historical failed waiting time before retry and resumed execution", async () => {
    const { manifest } = await fixture();
    manifest.tasks = [timeline(manifest.tasks[0]!, [["ready", 0], ["running", 2], ["failed", 5], ["ready", 11], ["running", 13]])];
    const report = summarizeRunTiming(manifest, { now: at(20) });
    expect(report.task_status_ms).toEqual({ ready: 4000, running: 10000, failed: 6000 });
    expect(report.tasks[0]!.intervals.find((interval) => interval.status === "failed")?.ongoing).toBe(false);
    expect(report.wall_ms).toBe(20000);
  });
  test("recoverable failed run and task continue accumulating time while final result is pending", async () => {
    const { manifest } = await fixture();
    manifest.tasks = [timeline(manifest.tasks[0]!, [["running", 0], ["failed", 5]])];
    manifest.run.status = "failed"; manifest.run.updated_at = at(5);
    manifest.final_result = { status: "pending", completed_at: null, report: "final-report.md" };
    const report = summarizeRunTiming(manifest, { now: at(20) });
    expect(report.wall_ms).toBe(20000);
    expect(report.task_status_ms).toEqual({ running: 5000, failed: 15000 });
    expect(report.tasks[0]!.intervals.at(-1)?.ongoing).toBe(true);
  });
  test.each(["final-result", "human-decision"])("terminal rejected delivery freezes at recorded %s time", async (authority) => {
    const { manifest } = await fixture();
    manifest.tasks = [timeline(manifest.tasks[0]!, [["running", 0], ["failed", 5]])];
    manifest.run.status = "failed"; manifest.run.updated_at = at(18);
    manifest.final_result = { status: authority === "final-result" ? "failed" : "pending", completed_at: authority === "final-result" ? at(15) : null, report: "final-report.md" };
    if (authority === "human-decision") manifest.product_owner_review = { status: "completed", decision: "rejected", comments: "Rejected delivery", decided_at: at(15) };
    const report = summarizeRunTiming(manifest, { now: at(100) });
    expect(report.wall_ms).toBe(15000);
    expect(report.task_status_ms).toEqual({ running: 5000, failed: 10000 });
    expect(report.tasks[0]!.intervals.at(-1)?.ongoing).toBe(false);
  });
  test("deferred human review keeps the delivery clock open", async () => {
    const { manifest } = await fixture();
    manifest.run.status = "product_owner_review"; manifest.run.updated_at = at(5);
    manifest.final_result = { status: "ready", completed_at: null, report: "final-report.md" };
    manifest.product_owner_review = { status: "ready", decision: "deferred", comments: "Review later", decided_at: at(5) };
    expect(summarizeRunTiming(manifest, { now: at(20) }).wall_ms).toBe(20000);
  });
  test("overlapping tasks and repeated command references do not inflate wall time or collector totals", async () => {
    const { manifest } = await fixture();
    manifest.tasks = manifest.tasks.slice(0, 2).map((task) => timeline(task, [["running", 0], ["completed", 10]]));
    manifest.run.status = "completed"; manifest.run.updated_at = at(10);
    const record = evidence();
    const report = summarizeRunTiming(manifest, { now: at(100), evidence: [record, record] });
    expect(report.wall_ms).toBe(10000); expect(report.task_status_ms.running).toBe(20000); expect(report.collector_command_ms).toBe(3000);
  });
  test("archived repair cycles end at repair time while current blocked cycle continues", async () => {
    const { manifest } = await fixture();
    const archived = timeline(manifest.tasks[0]!, [["running", 0], ["awaiting_review", 4]]);
    manifest.tasks = [timeline(manifest.tasks[0]!, [["ready", 10], ["running", 12], ["blocked", 15]])];
    const report = summarizeRunTiming(manifest, { now: at(20), archivedCycles: [{ id: "REPAIR-001", tasks: [archived], ended_at: at(10) }] });
    expect(report.wall_ms).toBe(20000); expect(report.task_status_ms).toEqual({ running: 7000, awaiting_review: 6000, ready: 2000, blocked: 5000 });
    expect(report.tasks[0]!.intervals.at(-1)?.ongoing).toBe(false);
  });
  test("invalid/missing timestamps are explicit and never yield negative or NaN durations", async () => {
    const { manifest } = await fixture();
    manifest.run.created_at = null;
    manifest.tasks = [timeline(manifest.tasks[0]!, [["running", 10], ["blocked", 5]])];
    const record = evidence(); record.completed_at = "invalid";
    const report = summarizeRunTiming(manifest, { now: at(20), evidence: [record] });
    expect(report.wall_ms).toBeNull(); expect(report.task_status_ms).toEqual({}); expect(report.collector_command_ms).toBe(0); expect(report.diagnostics).toHaveLength(3);
    expect(() => summarizeRunTiming(manifest, { now: "invalid" })).toThrow("as-of");
  });
  test("reader counts only referenced valid collector metadata and conceals malformed content", async () => {
    const { root, manifest } = await fixture();
    const record = evidence();
    const path = join(root, ".sdlc/runs/TIME-001", record.evidence_path);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(record));
    manifest.tasks[0]!.evidence = [record.evidence_path, record.stdout_path];
    await writeFile(join(root, ".sdlc/runs/TIME-001/manifest.yaml"), stringify(manifest));
    const valid = await getRunTiming(root, "TIME-001", { now: at(10) });
    expect(valid.collector_command_ms).toBe(3000);
    await writeFile(path, "private-secret-broken-json");
    const invalid = await getRunTiming(root, "TIME-001", { now: at(10) });
    expect(invalid.collector_command_ms).toBe(0);
    expect(invalid.diagnostics).toHaveLength(1);
    expect(JSON.stringify(invalid)).not.toContain("private-secret");
  });
  test("reader handles legacy manifests and ignores raw output logs and unreferenced metadata", async () => {
    const { root } = await fixture();
    const path = join(root, ".sdlc/runs/TIME-001/evidence/commands/EVD-0000000000000000"); await mkdir(path, { recursive: true });
    await writeFile(join(path, "evidence.json"), JSON.stringify(evidence()));
    await writeFile(join(path, "stdout.txt"), "private output never read");
    const report = await getRunTiming(root, "TIME-001", { now: at(10) });
    expect(report.collector_command_ms).toBe(0);
    expect(JSON.stringify(report)).not.toContain("private output");
    expect(report.wall_ms).toBe(10000);
  });
});
