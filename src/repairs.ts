import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "yaml";

import { mutateRunManifest, readAuthorityVersion, writeAuthorityVersion, type ManifestTransactionOptions } from "./manifest-transaction.js";
import { isPortableRepositoryPath, resolvePathInsideRoot } from "./paths.js";
import { qualityGateForTask } from "./quality-gates.js";
import { acquireRunAuthorityLock, releaseRunAuthorityLock } from "./run-authority-lock.js";
import { loadRun, parseManifest } from "./runs.js";
import { synchronizeRunState } from "./transitions.js";
import type { RepairRecord, RunManifest, Task } from "./types.js";

const journalName = ".repair-transaction.json";
const diffPath = "evidence/diffs/changed-files.json";
const implementationStages = new Set(["backend_implementation", "web_implementation", "mobile_implementation"]);

export interface RepairOptions {
  defectId: string;
  actor: string;
  reason: string;
  dryRun?: boolean;
  now?: string;
}

interface FileChange { path: string; before: string | null; after: string | null }
interface RepairJournal {
  schema_version: 1;
  run_id: string;
  repair_id: string;
  before_manifest: string;
  after_manifest: string;
  before_version: number;
  after_version: number;
  changes: FileChange[];
}

/** Explicit repair starts a new cycle while retaining prior task, gate, and artifact history. */
export async function repairTask(root: string, runId: string, taskId: string, options: RepairOptions, transactionOptions: ManifestTransactionOptions = {}) {
  if (options.actor !== "pm") throw new Error("only pm may open a repair cycle");
  if (!/^DEF-[A-Z0-9-]+$/.test(options.defectId)) throw new Error("repair requires a canonical DEF-* defect ID");
  if (!options.reason.trim()) throw new Error("repair requires a reason");
  const at = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error("repair time is invalid");
  const journalPath = await runPath(root, runId, journalName);
  if (await optionalFile(journalPath) !== null) throw new Error("an interrupted repair needs recover-repair before continuing");
  const current = await loadRun(root, runId);
  const latest = current.repair_history?.at(-1);
  if (latest?.task_id === taskId && latest.defect_id === options.defectId && !["completed", "awaiting_review"].includes(current.tasks.find((task) => task.id === taskId)?.status ?? "")) {
    return { dry_run: options.dryRun ?? false, already_open: true, repair: latest, status: current.run.status };
  }
  const preview = planRepair(current, taskId, options, at);
  if (options.dryRun) return { dry_run: true, already_open: false, repair: preview.record, status: preview.manifest.run.status };

  let journal: RepairJournal | undefined;
  const rollbackChanges = async () => {
    if (journal === undefined) return;
    await applyChanges(root, runId, journal.changes, "before");
    await rm(journalPath, { force: true });
  };
  const transaction = await mutateRunManifest(root, runId, async (manifest) => {
    const planned = planRepair(manifest, taskId, options, at);
    const changes: FileChange[] = [];
    for (const path of repairPaths(planned.record.tasks)) {
      const before = await optionalFile(await runPath(root, runId, path));
      if (before === null) continue;
      const archivePath = `repairs/${planned.record.id}/${path}`;
      if (await optionalFile(await runPath(root, runId, archivePath)) !== null) throw new Error(`repair archive already exists: ${archivePath}`);
      planned.record.archives.push({ path, archive_path: archivePath, sha256: hash(Buffer.from(before, "base64")) });
      changes.push({ path: archivePath, before: null, after: before });
      changes.push({ path, before, after: null });
    }
    const beforeDiff = await optionalFile(await runPath(root, runId, diffPath));
    if (beforeDiff !== null) {
      const document = JSON.parse(Buffer.from(beforeDiff, "base64").toString("utf8")) as { files: Array<string | { repository: string; path: string }>; ownership?: Array<{ task_id: string; path: string; repository?: string }> };
      const affected = new Set(planned.record.affected_task_ids);
      const removed = new Set((document.ownership ?? []).filter((entry) => affected.has(entry.task_id)).map(pathIdentity));
      const removedArtifacts = new Set(planned.record.archives.map((entry) => `.sdlc/runs/${runId}/${entry.path}`));
      document.files = document.files.filter((entry) => !removed.has(pathIdentity(entry)) && !(typeof entry === "string" && removedArtifacts.has(entry)));
      document.ownership = (document.ownership ?? []).filter((entry) => !affected.has(entry.task_id));
      const archivePath = `repairs/${planned.record.id}/${diffPath}`;
      planned.record.archives.push({ path: diffPath, archive_path: archivePath, sha256: hash(Buffer.from(beforeDiff, "base64")) });
      changes.push({ path: archivePath, before: null, after: beforeDiff });
      changes.push({ path: diffPath, before: beforeDiff, after: Buffer.from(JSON.stringify(document, null, 2) + "\n").toString("base64") });
    }
    planned.manifest.repair_history = [...(manifest.repair_history ?? []), planned.record];
    const originalSource = await readFile(await runPath(root, runId, "manifest.yaml"));
    Object.assign(manifest, planned.manifest);
    journal = {
      schema_version: 1, run_id: runId, repair_id: planned.record.id,
      before_manifest: hash(originalSource),
      after_manifest: hash(Buffer.from(stringify(manifest, { aliasDuplicateObjects: false }))),
      before_version: await readAuthorityVersion(root, runId),
      after_version: (await readAuthorityVersion(root, runId)) + 1,
      changes,
    };
    await writeFile(journalPath, JSON.stringify(journal), { flag: "wx" });
    await applyChanges(root, runId, changes, "after");
    return planned.record;
  }, { ...transactionOptions, rollbackChanges });
  await rm(journalPath, { force: true });
  return { dry_run: false, already_open: false, repair: transaction.value, status: transaction.manifest.run.status };
}

export function planRepair(current: RunManifest, taskId: string, options: Pick<RepairOptions, "defectId" | "reason" | "actor">, at: string): { record: RepairRecord; manifest: RunManifest } {
  if (options.actor !== "pm" || !options.reason.trim() || !/^DEF-[A-Z0-9-]+$/.test(options.defectId)) throw new Error("repair requires pm, a defect ID, and reason");
  if (["completed", "cancelled"].includes(current.run.status) || ["failed", "cancelled"].includes(current.final_result?.status ?? "") || current.product_owner_review?.decision != null) throw new Error("a terminal or human-reviewed run cannot be repaired; start a new run");
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(current.run.updated_at ?? current.run.created_at ?? at)) throw new Error("repair time predates run state");
  const selected = current.tasks.find((task) => task.id === taskId);
  if (selected === undefined || !implementationStages.has(selected.stage) || !["completed", "awaiting_review"].includes(selected.status)) throw new Error("repair requires a completed implementation task or an implementation awaiting review");
  const affected = new Set([taskId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const task of current.tasks) if (!affected.has(task.id) && task.dependencies.some((id) => affected.has(id))) { affected.add(task.id); changed = true; }
  }
  if (current.tasks.some((task) => affected.has(task.id) && task.status === "awaiting_approval")) throw new Error("resolve pending approvals before opening a repair");
  if (current.blockers.some((blocker) => blocker.status === "open" && affected.has(blocker.task_id))) throw new Error("resolve affected external blockers before opening a repair; repair does not waive them");
  if (current.decisions?.some((decision) => decision.action?.startsWith("transition:") && decision.affected_tasks.some((id) => affected.has(id)) && decision.status === "approved" && decision.consumed_at === null)) throw new Error("an unconsumed affected approval must be resolved before repair");
  const manifest = structuredClone(current);
  const record: RepairRecord = {
    id: `RPR-${String((current.repair_history?.length ?? 0) + 1).padStart(3, "0")}`,
    task_id: taskId, defect_id: options.defectId, reason: options.reason, actor: "pm", at,
    affected_task_ids: current.tasks.filter((task) => affected.has(task.id)).map((task) => task.id),
    tasks: structuredClone(current.tasks.filter((task) => affected.has(task.id))), quality_gates: {}, archives: [],
  };
  for (const task of manifest.tasks.filter((task) => affected.has(task.id))) {
    const gateId = qualityGateForTask(task);
    if (gateId !== undefined && manifest.quality_gates[gateId] !== undefined) {
      record.quality_gates[gateId] = structuredClone(manifest.quality_gates[gateId]);
      const gate = manifest.quality_gates[gateId];
      gate.status = "pending"; gate.evidence = [];
      gate.history = [...(gate.history ?? []), { status: "pending", evidence: [], actor: "pm", reason: `Invalidated by ${record.id}: ${options.reason}`, at }];
    }
    task.activation_offset = (task.activation_offset ?? 0) + task.transitions.filter((transition) => transition.to === "ready").length;
    task.status = task.id === taskId ? "ready" : "pending";
    task.transitions = task.status === "ready" ? [{ from: "pending", to: "ready", actor: "pm", reason: `${record.id}: ${options.reason}`, at }] : [];
    task.started_at = null; task.completed_at = null; task.commit = null;
    task.outputs = []; task.evidence = []; task.agent_dispatches = [];
    task.blocker_reason = null; task.failure_reason = null;
  }
  if (manifest.product_owner_review) manifest.product_owner_review = { status: "pending", decision: null, comments: null, decided_at: null };
  if (manifest.final_result) manifest.final_result = { ...manifest.final_result, status: "pending", completed_at: null };
  manifest.repair_history = [...(manifest.repair_history ?? []), record];
  manifest.run.updated_at = at;
  synchronizeRunState(manifest);
  return { record, manifest };
}

/** A journal permits recovery after process interruption without treating partial writes as valid authority. */
export async function recoverRepair(root: string, runId: string, actor: string) {
  if (actor !== "pm") throw new Error("only pm may recover a repair transaction");
  const lock = await acquireRunAuthorityLock(root, runId);
  try {
    const path = await runPath(root, runId, journalName);
    const source = await optionalFile(path);
    if (source === null) return { recovered: false };
    const journal = JSON.parse(Buffer.from(source, "base64").toString("utf8")) as RepairJournal;
    const manifestSource = await readFile(await runPath(root, runId, "manifest.yaml"));
    const manifest = parseManifest(manifestSource.toString("utf8"));
    const allowed = new Set([...repairPaths(manifest.tasks), diffPath]);
    if (journal.schema_version !== 1 || journal.run_id !== runId || !/^RPR-[0-9]+$/.test(journal.repair_id) || !Array.isArray(journal.changes)
      || !Number.isSafeInteger(journal.before_version) || journal.before_version < 0 || journal.after_version !== journal.before_version + 1) throw new Error("invalid repair recovery journal");
    const seen = new Set<string>();
    for (const change of journal.changes) {
      const original = change.path?.startsWith(`repairs/${journal.repair_id}/`) ? change.path.slice(`repairs/${journal.repair_id}/`.length) : change.path;
      if (!isPortableRepositoryPath(change.path) || !allowed.has(original) || seen.has(change.path) || ![change.before, change.after].every((value) => value === null || typeof value === "string")) throw new Error("repair journal contains an unsafe file change");
      seen.add(change.path);
    }
    const manifestHash = hash(manifestSource);
    const direction = manifestHash === journal.before_manifest ? "before" : manifestHash === journal.after_manifest ? "after" : null;
    if (direction === null) throw new Error("run changed after interrupted repair; refusing automatic recovery");
    const version = await readAuthorityVersion(root, runId);
    if (version !== journal.before_version && version !== journal.after_version) throw new Error("run authority version changed after interrupted repair; refusing recovery");
    await applyChanges(root, runId, journal.changes, direction);
    await writeAuthorityVersion(root, runId, direction === "after" ? journal.after_version : journal.before_version);
    await rm(path);
    return { recovered: true, repair_id: journal.repair_id, outcome: direction === "before" ? "rolled_back" : "committed" };
  } finally { await releaseRunAuthorityLock(lock); }
}

function repairPaths(tasks: Task[]): string[] {
  return [...new Set(tasks.flatMap((task) => [
    ...task.required_outputs, ...task.outputs,
    ...(task.role === "backend" || task.role === "frontend" ? [`tasks/${task.id}.assignment.yaml`, `tasks/${task.id}.handoff.json`] : []),
  ]))].filter((path) => !["request.md", "manifest.yaml", "facts.yaml"].includes(path) && !path.startsWith("evidence/commands/"));
}

async function applyChanges(root: string, runId: string, changes: FileChange[], direction: "before" | "after") {
  const ordered = direction === "before" ? [...changes].reverse() : changes;
  for (const change of ordered) {
    const path = await runPath(root, runId, change.path);
    const existing = await optionalFile(path);
    if (existing !== change.before && existing !== change.after) throw new Error(`file changed outside repair transaction: ${change.path}`);
    const next = change[direction];
    if (existing === next) continue;
    if (next === null) await rm(path, { force: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, Buffer.from(next, "base64"), { flag: "wx" }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    }
  }
}

function pathIdentity(value: string | { repository?: string; path: string }): string {
  return typeof value === "string" ? `coordinator:${value}` : `${value.repository ?? "coordinator"}:${value.path}`;
}
async function runPath(root: string, runId: string, path: string): Promise<string> {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(runId) || !isPortableRepositoryPath(path) || path === ".") throw new Error("invalid repair path");
  return resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${path}`);
}
async function optionalFile(path: string): Promise<string | null> {
  try { return (await readFile(path)).toString("base64"); }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null; throw error; }
}
function hash(source: Uint8Array): string { return createHash("sha256").update(source).digest("hex"); }
