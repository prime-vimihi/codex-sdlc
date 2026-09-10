import { readFile } from "node:fs/promises";

import { canonicalizeCommandDeclaration } from "./command-provenance.js";
import { evidenceIdFromReference, evidencePathsForId } from "./evidence-identifiers.js";
import { taskStageContract } from "./quality-gates.js";
import { resolvePathInsideRoot } from "./paths.js";
import { configuredSecretValues } from "./redaction.js";
import { validateDocument } from "./schemas.js";
import type { EvidenceRecord, ProjectConfig, RunManifest, Task, TaskStage } from "./types.js";

export interface EvidenceReferenceValidationInput {
  root: string;
  runId: string;
  manifest: RunManifest;
  reference: string;
  project: ProjectConfig;
  owner: string;
  expectedTask?: Task;
  expectedStage?: TaskStage;
}

export async function assertEvidenceReference(input: EvidenceReferenceValidationInput): Promise<EvidenceRecord> {
  return (await readEvidenceReference(input)).record;
}

export async function readEvidenceReference(input: EvidenceReferenceValidationInput): Promise<{ record: EvidenceRecord; source: string }> {
  if (input.manifest.run.id !== input.runId) {
    throw new Error(`active manifest run ID does not match run: ${input.runId}`);
  }
  const id = evidenceIdFromReference(input.reference);
  if (id === undefined) {
    throw new Error(`evidence reference is not a canonical command evidence path for ${input.owner}: ${input.reference}`);
  }
  const paths = evidencePathsForId(id);

  const path = await resolveRunReference(input.root, input.runId, input.reference);
  let source: string;
  let value: unknown;
  try {
    source = await readFile(path, "utf8");
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`evidence is unreadable for ${input.owner}: ${input.reference}; ${errorMessage(error)}`);
  }
  assertStatusExitConsistency(value, input.owner, input.reference);
  const validation = validateDocument("evidence", value);
  if (!validation.valid) {
    throw new Error(`evidence is invalid for ${input.owner}: ${input.reference}; ${validation.diagnostics.join("; ")}`);
  }
  const evidence = value as EvidenceRecord;
  const task = input.manifest.tasks.find((candidate) => candidate.id === evidence.task_id);
  if (task === undefined) {
    throw new Error(`evidence task ID does not exist in the active run: ${input.reference}`);
  }
  try {
    taskStageContract(task);
  } catch (error) {
    throw new Error(`evidence task does not match its stage contract: ${input.reference}; ${errorMessage(error)}`);
  }
  if (input.expectedTask !== undefined && task.id !== input.expectedTask.id) {
    throw new Error(`evidence task ID does not match task: ${input.reference}`);
  }
  if (input.expectedStage !== undefined && task.stage !== input.expectedStage) {
    throw new Error(`evidence task stage does not match ${input.expectedStage}: ${input.reference}`);
  }

  if (
    evidence.id !== id
    || evidence.evidence_path !== input.reference
    || evidence.evidence_path !== paths.evidence
  ) {
    throw new Error(`evidence path or ID binding does not match reference: ${input.reference}`);
  }
  if (evidence.run_id !== input.runId) {
    throw new Error(`evidence run ID does not match run: ${input.reference}`);
  }
  if (evidence.task_id !== task.id) {
    throw new Error(`evidence task ID does not match task: ${input.reference}`);
  }
  if (evidence.stdout_path !== paths.stdout || evidence.stderr_path !== paths.stderr) {
    throw new Error(`evidence stream path does not match evidence ID: ${input.reference}`);
  }
  if (!Object.hasOwn(input.project.commands, evidence.command_id)) {
    throw new Error(`evidence command ID is not declared for the active project workflow task: ${input.reference}`);
  }
  const command = input.project.commands[evidence.command_id as keyof typeof input.project.commands];
  const secretValues = configuredSecretValues(input.project.security.secret_environment_variables);
  const canonicalCommand = await canonicalizeCommandDeclaration(input.root, command, secretValues);
  const provenanceMatches = evidence.executable === canonicalCommand.provenance.executable
    && equalOrderedStrings(evidence.args, canonicalCommand.provenance.args)
    && evidence.cwd === canonicalCommand.provenance.cwd;
  if (!provenanceMatches) {
    throw new Error(`evidence command provenance does not match the active project command declaration: ${input.reference}`);
  }

  // The v0.1 evidence envelope does not record network or mutates metadata,
  // so provenance validation intentionally does not attest either policy field.

  for (const outputPath of [evidence.evidence_path, evidence.stdout_path, evidence.stderr_path]) {
    try {
      await resolveRunReference(input.root, input.runId, outputPath);
    } catch (error) {
      throw new Error(`evidence output is missing or unsafe for ${input.owner}: ${outputPath}; ${errorMessage(error)}`);
    }
  }
  return { record: evidence, source };
}

export async function resolveRunReference(root: string, runId: string, reference: string): Promise<string> {
  if (
    reference.trim() === ""
    || reference.split(/[\\/]+/).includes("..")
    || reference.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(reference)
  ) {
    throw new Error("run reference escapes its directory");
  }
  return resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${reference}`, { mustExist: true });
}

function assertStatusExitConsistency(value: unknown, owner: string, reference: string): void {
  if (value === null || typeof value !== "object") return;
  const record = value as { exit_code?: unknown; result_status?: unknown };
  if (
    typeof record.exit_code === "number"
    && record.exit_code >= 0
    && (record.result_status === "passed" || record.result_status === "failed")
  ) {
    const consistent = record.result_status === "passed" ? record.exit_code === 0 : record.exit_code > 0;
    if (!consistent) {
      throw new Error(`evidence result status and exit code are inconsistent for ${owner}: ${reference}`);
    }
  }
}

function equalOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
