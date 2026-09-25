import { readFile } from "node:fs/promises";

import { evidenceIdFromReference } from "./evidence-identifiers.js";
import { resolvePathInsideRoot } from "./paths.js";
import { loadRun } from "./runs.js";
import { validateDocument } from "./schemas.js";
import type { EvidenceRecord, RunManifest, Task, TaskStatus } from "./types.js";

export interface ArchivedTimingCycle { id: string; tasks: Task[]; ended_at: string }
export interface RunTimingOptions { now?: string; evidence?: EvidenceRecord[]; archivedCycles?: ArchivedTimingCycle[] }
export interface TimingInterval { status: TaskStatus; started_at: string; ended_at: string; duration_ms: number; ongoing: boolean }
export interface TaskTiming {
  task_id: string;
  cycle: string;
  intervals: TimingInterval[];
  status_ms: Partial<Record<TaskStatus, number>>;
}
export interface RunTimingReport {
  run_id: string;
  as_of: string;
  wall_ms: number | null;
  wall_started_at: string | null;
  wall_ended_at: string | null;
  tasks: TaskTiming[];
  /** Task-state totals can overlap; these are not elapsed run wall time. */
  task_status_ms: Partial<Record<TaskStatus, number>>;
  collector_command_ms: number;
  collector_commands: Array<{ evidence_path: string; task_id: string; command_id: string; duration_ms: number }>;
  diagnostics: string[];
  limitations: string[];
}

const terminal = new Set<TaskStatus>(["completed", "cancelled"]);

/** Derive time from durable lifecycle events; never infer LLM compute from task state. */
export function summarizeRunTiming(manifest: RunManifest, options: RunTimingOptions = {}): RunTimingReport {
  const now = options.now ?? new Date().toISOString();
  const diagnostics: string[] = [];
  const currentTime = timestamp(now);
  if (currentTime === null) throw new Error("Timing as-of timestamp is invalid");
  const started = timestamp(manifest.run.created_at);
  const review = manifest.product_owner_review;
  const humanDecisionFinal = review?.status === "completed" && review.decision !== null && review.decision !== "deferred";
  const runEnded = ["completed", "cancelled"].includes(manifest.run.status)
    || ["completed", "failed", "cancelled"].includes(manifest.final_result?.status ?? "") || humanDecisionFinal;
  const end = runEnded
    ? timestamp(manifest.final_result?.completed_at ?? (humanDecisionFinal ? review?.decided_at : null) ?? manifest.run.updated_at)
    : currentTime;
  let wall: number | null = null;
  if (started !== null && end !== null && end >= started && end <= currentTime) wall = end - started;
  else diagnostics.push("Run wall time is unavailable because its timestamps are absent, invalid, reversed, or later than the as-of timestamp.");
  const archived = options.archivedCycles ?? repairCycles(manifest);
  const cycles = [...archived, { id: "current", tasks: manifest.tasks, ended_at: end === null ? now : new Date(end).toISOString() }];
  const tasks: TaskTiming[] = [];
  const totals: Partial<Record<TaskStatus, number>> = {};
  for (const cycle of cycles) {
    const cutoff = timestamp(cycle.ended_at);
    for (const task of cycle.tasks) {
      const result: TaskTiming = { task_id: task.id, cycle: cycle.id, intervals: [], status_ms: {} };
      tasks.push(result);
      const times = task.transitions.map((transition) => timestamp(transition.at));
      if (cutoff === null || cutoff > currentTime || times.some((time, index) => time === null || time > cutoff || (index > 0 && (times[index - 1] === null || time < times[index - 1]!)))) {
        diagnostics.push(`${cycle.id}/${task.id}: invalid or nonchronological lifecycle timestamps; intervals were not counted.`);
        continue;
      }
      for (const [index, transition] of task.transitions.entries()) {
        if (terminal.has(transition.to)) continue;
        const next = times[index + 1];
        const intervalEnd = next ?? cutoff;
        const intervalStart = times[index]!;
        const duration = intervalEnd - intervalStart;
        result.intervals.push({ status: transition.to, started_at: transition.at, ended_at: new Date(intervalEnd).toISOString(), duration_ms: duration, ongoing: next === undefined && cycle.id === "current" && !runEnded });
        result.status_ms[transition.to] = (result.status_ms[transition.to] ?? 0) + duration;
        totals[transition.to] = (totals[transition.to] ?? 0) + duration;
      }
      if (!task.transitions.length && !["pending", "ready"].includes(task.status)) diagnostics.push(`${cycle.id}/${task.id}: no lifecycle transitions; task time was not inferred from status.`);
    }
  }
  const collectorCommands: RunTimingReport["collector_commands"] = [];
  const seen = new Set<string>();
  const knownTasks = new Set(cycles.flatMap((cycle) => cycle.tasks.map((task) => task.id)));
  for (const evidence of options.evidence ?? []) {
    if (seen.has(evidence.evidence_path)) continue;
    seen.add(evidence.evidence_path);
    const commandStart = timestamp(evidence.started_at);
    const commandEnd = timestamp(evidence.completed_at);
    if (evidence.run_id !== manifest.run.id || evidenceIdFromReference(evidence.evidence_path) !== evidence.id || !knownTasks.has(evidence.task_id) || commandStart === null || commandEnd === null || commandEnd < commandStart || commandEnd > currentTime) {
      diagnostics.push(`Collector evidence ${evidence.id}: invalid identity or timestamps; duration was not counted.`);
      continue;
    }
    collectorCommands.push({ evidence_path: evidence.evidence_path, task_id: evidence.task_id, command_id: evidence.command_id, duration_ms: commandEnd - commandStart });
  }
  return {
    run_id: manifest.run.id, as_of: now, wall_ms: wall,
    wall_started_at: started === null ? null : new Date(started).toISOString(),
    wall_ended_at: end === null ? null : new Date(end).toISOString(),
    tasks, task_status_ms: totals,
    collector_command_ms: collectorCommands.reduce((sum, command) => sum + command.duration_ms, 0),
    collector_commands: collectorCommands, diagnostics,
    limitations: [
      "Wall time is one elapsed run span, not a sum of overlapping task durations.",
      "Task-state durations include orchestration and waiting; running time is not LLM compute time.",
      "Collector command totals count only referenced collector evidence and may overlap; LLM execution and builds/tests outside the collector are excluded.",
      "Unrecorded activity and time before the first recorded transition cannot be reconstructed.",
    ],
  };
}

/** Reads evidence JSON only, never stdout/stderr logs or external telemetry. */
export async function getRunTiming(root: string, runId: string, options: { now?: string } = {}): Promise<RunTimingReport> {
  const manifest = await loadRun(root, runId);
  const archivedCycles = repairCycles(manifest);
  const references = new Set([...manifest.tasks, ...archivedCycles.flatMap((cycle) => cycle.tasks)].flatMap((task) => task.evidence));
  const evidence: EvidenceRecord[] = [];
  const diagnostics: string[] = [];
  for (const reference of references) {
    if (!evidenceIdFromReference(reference)) continue;
    try {
      const path = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${reference}`, { mustExist: true });
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      const validation = validateDocument("evidence", record);
      if (!validation.valid) throw new Error("invalid collector evidence schema");
      const typed = record as EvidenceRecord;
      if (typed.evidence_path !== reference || typed.id !== evidenceIdFromReference(reference)) throw new Error("collector evidence identity differs from reference");
      evidence.push(typed);
    } catch {
      // Do not echo file contents, JSON parse fragments, command args, or output logs.
      diagnostics.push(`Unable to read valid collector timing metadata at ${reference}.`);
    }
  }
  const report = summarizeRunTiming(manifest, { ...options, evidence, archivedCycles });
  report.diagnostics.push(...diagnostics);
  return report;
}

function repairCycles(manifest: RunManifest): ArchivedTimingCycle[] {
  const history = (manifest as RunManifest & { repair_history?: Array<{ id: string; tasks: Task[]; at: string }> }).repair_history ?? [];
  return history.map((repair) => ({ id: repair.id, tasks: repair.tasks, ended_at: repair.at }));
}
function timestamp(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
