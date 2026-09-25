import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isPortableRepositoryPath, resolvePathInsideRoot } from "./paths.js";
import { validateDocument } from "./schemas.js";
import type { RunManifest } from "./types.js";

/** Archived cycles remain durable evidence; current activation counters cannot erase their lineage. */
export async function repairHistoryDiagnostics(root: string, runId: string, manifest: RunManifest): Promise<string[]> {
  const diagnostics: string[] = [];
  const offsets = new Map<string, number>();
  let previousAt = -Infinity;
  for (const [index, record] of (manifest.repair_history ?? []).entries()) {
    if (record.id !== `RPR-${String(index + 1).padStart(3, "0")}`) diagnostics.push("repair history IDs must be sequential");
    if (Date.parse(record.at) < previousAt) diagnostics.push(`${record.id} predates the previous repair`);
    previousAt = Date.parse(record.at);
    const ids = record.tasks.map((task) => task.id);
    if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(record.affected_task_ids) || !ids.includes(record.task_id)) diagnostics.push(`${record.id} archived tasks do not match its affected tasks`);
    const primary = record.tasks.find((task) => task.id === record.task_id);
    if (primary === undefined || !["completed", "awaiting_review"].includes(primary.status) || !primary.stage.endsWith("_implementation")) diagnostics.push(`${record.id} must archive a completed implementation task or implementation awaiting review`);
    for (const task of record.tasks) {
      diagnostics.push(...validateDocument("task", task).diagnostics.map((message) => `${record.id}/${task.id}: ${message}`));
      const current = manifest.tasks.find((candidate) => candidate.id === task.id);
      if (current === undefined || current.role !== task.role || current.stage !== task.stage || current.target !== task.target
        || JSON.stringify(current.dependencies) !== JSON.stringify(task.dependencies)
        || JSON.stringify(current.required_outputs) !== JSON.stringify(task.required_outputs)) diagnostics.push(`${record.id} changed the canonical identity of ${task.id}`);
      if ((task.activation_offset ?? 0) !== (offsets.get(task.id) ?? 0)) diagnostics.push(`${record.id}/${task.id} has inconsistent activation history`);
      if (task.transitions.some((transition) => Date.parse(transition.at) > Date.parse(record.at))) diagnostics.push(`${record.id}/${task.id} contains transitions after its archive time`);
      offsets.set(task.id, (offsets.get(task.id) ?? 0) + task.transitions.filter((entry) => entry.to === "ready").length);
    }
    const seen = new Set<string>();
    for (const archive of record.archives) {
      if (!isPortableRepositoryPath(archive.path) || archive.path === "." || archive.archive_path !== `repairs/${record.id}/${archive.path}` || seen.has(archive.path)) {
        diagnostics.push(`${record.id} has an invalid archive path`); continue;
      }
      seen.add(archive.path);
      try {
        const path = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${archive.archive_path}`, { mustExist: true });
        const digest = createHash("sha256").update(await readFile(path)).digest("hex");
        if (digest !== archive.sha256) diagnostics.push(`${record.id} archive integrity changed: ${archive.path}`);
      } catch (error) { diagnostics.push(`${record.id} archive unavailable: ${archive.path}; ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  for (const task of manifest.tasks) {
    if ((task.activation_offset ?? 0) !== (offsets.get(task.id) ?? 0)) diagnostics.push(`${task.id} activation offset does not match archived repair cycles`);
  }
  return diagnostics;
}
