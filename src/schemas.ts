import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { ValidateFunction } from "ajv";
import type { Ajv2020 as Ajv2020Instance } from "ajv/dist/2020.js";

import { evidencePathsForId } from "./evidence-identifiers.js";
import type { ValidationResult } from "./types.js";

const schemaFileNames = {
  agentPolicy: "agent-policy.schema.json",
  agentCapabilities: "agent-capabilities.schema.json",
  agentDispatch: "agent-dispatch.schema.json",
  productOwnerAdvisory: "product-owner-advisory.schema.json",
  framework: "framework.schema.json",
  project: "project.schema.json",
  local: "local.schema.json",
  workflow: "workflow.schema.json",
  task: "task.schema.json",
  run: "run.schema.json",
  evidence: "evidence.schema.json",
  facts: "facts.schema.json",
  semanticClaims: "semantic-claims.schema.json",
  openapi: "openapi.schema.json",
  deliveryAssignment: "delivery-assignment.schema.json",
  deliveryReport: "delivery-report.schema.json",
  deliveryAuthoritySnapshot: "delivery-authority-snapshot.schema.json",
} as const;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default as new (options: Record<string, unknown>) => Ajv2020Instance;
const addFormats = require("ajv-formats").default as (ajv: Ajv2020Instance) => void;

export type SchemaName = keyof typeof schemaFileNames;

let validatorCache: Map<SchemaName, ValidateFunction> | undefined;

export function validateDocument(schemaName: SchemaName, value: unknown): ValidationResult {
  try {
    const validator = validators().get(schemaName);
    if (validator === undefined) {
      throw new Error(`schema is not registered: ${schemaFileNames[schemaName]}`);
    }
    const valid = validator(value);

    const diagnostics = (validator.errors ?? []).map((error) => {
        const path = error.instancePath === "" ? "/" : error.instancePath;
        return `${path} ${error.message ?? "failed validation"}`;
      });
    if (valid) {
      diagnostics.push(...transitionHistoryDiagnostics(schemaName, value));
      diagnostics.push(...deliveryContractDiagnostics(schemaName, value));
    }

    return {
      valid: Boolean(valid) && diagnostics.length === 0,
      diagnostics,
    };
  } catch (error) {
    return {
      valid: false,
      diagnostics: [`unable to load ${schemaName} schema: ${errorMessage(error)}`],
    };
  }
}

function validators(): Map<SchemaName, ValidateFunction> {
  if (validatorCache !== undefined) return validatorCache;

  const schemasDirectory = fileURLToPath(new URL("../assets/schemas/", import.meta.url));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const fileName of readdirSync(schemasDirectory)) {
    if (fileName.endsWith(".schema.json")) {
      ajv.addSchema(JSON.parse(readFileSync(resolve(schemasDirectory, fileName), "utf8")) as object);
    }
  }

  const cache = new Map<SchemaName, ValidateFunction>();
  for (const [schemaName, fileName] of Object.entries(schemaFileNames) as Array<[SchemaName, string]>) {
    const schema = JSON.parse(readFileSync(resolve(schemasDirectory, fileName), "utf8")) as { $id?: string };
    const validator = schema.$id === undefined ? undefined : ajv.getSchema(schema.$id);
    if (validator === undefined) throw new Error(`schema is not registered: ${fileName}`);
    cache.set(schemaName, validator);
  }
  validatorCache = cache;
  return cache;
}

function deliveryContractDiagnostics(schemaName: SchemaName, value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;

  if (schemaName === "deliveryAssignment") return assignmentSemanticDiagnostics(record);
  if (schemaName === "deliveryReport") return reportSemanticDiagnostics(record);
  if (schemaName === "deliveryAuthoritySnapshot") return authoritySemanticDiagnostics(record);
  return [];
}

function assignmentSemanticDiagnostics(value: Record<string, unknown>): string[] {
  const controls = objectRecord(value.controls);
  const diagnostics = [
    ...duplicateKeyDiagnostics(value.dependencies, "task_id", "dependencies"),
    ...duplicateKeyDiagnostics(value.required_inputs, "path", "required_inputs"),
    ...duplicateKeyDiagnostics(value.required_outputs, "path", "required_outputs"),
    ...duplicateScalarDiagnostics(value.allowed_write_roots, "allowed_write_roots"),
    ...duplicateKeyDiagnostics(value.available_evidence, "evidence_id", "available_evidence"),
    ...duplicateKeyDiagnostics(value.available_evidence, "command_key", "available_evidence"),
    ...evidenceReferenceDiagnostics(value.available_evidence, "available_evidence"),
    ...duplicateKeyDiagnostics(value.evidence_requirements, "command_key", "evidence_requirements"),
    ...duplicateKeyDiagnostics(controls.api_requirements ?? controls.requirements, "requirement_id", "controls.requirements"),
    ...duplicateKeyDiagnostics(controls.api_requirements ?? controls.requirements, "capability", "controls.requirements"),
    ...sourceReferenceDiagnostics(controls.api_requirements ?? controls.requirements, "controls.requirements"),
    ...gapQuestionDiagnostics(controls, "controls"),
  ];
  for (const [index, output] of objectArray(value.required_outputs).entries()) {
    if (output.producer !== value.role) diagnostics.push(`required_outputs[${index}].producer must match assignment role`);
  }
  if (objectRecord(value.transition_policy).current_status !== value.task_status) {
    diagnostics.push("transition_policy.current_status must match assignment task_status");
  }
  if (value.role === "backend") {
    const requiredMode = value.stage === "api_contract" ? "api_contract" : "implementation";
    if (controls.mode !== requiredMode) diagnostics.push(`controls.mode must be ${requiredMode} for ${String(value.stage)}`);
  }
  return diagnostics;
}

function reportSemanticDiagnostics(value: Record<string, unknown>): string[] {
  const observations = objectRecord(value.observations);
  const diagnostics = [
    ...duplicateKeyDiagnostics(value.artifacts, "path", "artifacts"),
    ...duplicateKeyDiagnostics(value.writes, "path", "writes"),
    ...duplicateKeyDiagnostics(value.evidence, "evidence_id", "evidence"),
    ...duplicateKeyDiagnostics(value.evidence, "command_key", "evidence"),
    ...evidenceReferenceDiagnostics(value.evidence, "evidence"),
    ...duplicateKeyDiagnostics(observations.requirement_results, "requirement_id", "observations.requirement_results"),
    ...duplicateKeyDiagnostics(observations.requirement_results, "capability", "observations.requirement_results"),
    ...gapQuestionDiagnostics(observations, "observations"),
  ];
  for (const [index, artifact] of objectArray(value.artifacts).entries()) {
    if (artifact.producer !== value.role) diagnostics.push(`artifacts[${index}].producer must match report role`);
  }
  if (value.role === "backend") {
    const requiredMode = value.stage === "api_contract" ? "api_contract" : "implementation";
    if (observations.mode !== requiredMode) diagnostics.push(`observations.mode must be ${requiredMode} for ${String(value.stage)}`);
  }
  return diagnostics;
}

function authoritySemanticDiagnostics(value: Record<string, unknown>): string[] {
  const task = objectRecord(value.task);
  const workflow = objectRecord(value.workflow);
  const changedFiles = objectRecord(value.changed_files);
  const approvals = objectArray(value.approval_decisions);
  const diagnostics = [
    ...duplicateKeyDiagnostics(task.dependencies, "task_id", "task.dependencies"),
    ...duplicateKeyDiagnostics(value.required_inputs, "path", "required_inputs"),
    ...duplicateKeyDiagnostics(workflow.required_outputs, "path", "workflow.required_outputs"),
    ...duplicateScalarDiagnostics(workflow.permission_roots, "workflow.permission_roots"),
    ...duplicateKeyDiagnostics(value.evidence_documents, "evidence_id", "evidence_documents"),
    ...duplicateKeyDiagnostics(value.evidence_documents, "command_key", "evidence_documents"),
    ...evidenceReferenceDiagnostics(value.evidence_documents, "evidence_documents"),
    ...duplicateScalarDiagnostics(changedFiles.files, "changed_files.files"),
    ...duplicateKeyDiagnostics(value.approval_decisions, "decision_id", "approval_decisions"),
  ];
  const runId = objectRecord(value.run).run_id;
  const taskId = task.task_id;
  const canonicalRunPrefix = typeof runId === "string" ? `.sdlc/runs/${runId}` : undefined;
  if (canonicalRunPrefix !== undefined) {
    if (objectRecord(value.assignment).path !== `${canonicalRunPrefix}/tasks/${String(taskId)}.assignment.yaml`) {
      diagnostics.push("assignment.path must be canonical for the snapshot run and task");
    }
    if (objectRecord(value.run).path !== `${canonicalRunPrefix}/manifest.yaml`) {
      diagnostics.push("run.path must be canonical for the snapshot run");
    }
    if (objectRecord(value.facts).path !== `${canonicalRunPrefix}/facts.yaml`) {
      diagnostics.push("facts.path must be canonical for the snapshot run");
    }
  }
  for (const [index, output] of objectArray(workflow.required_outputs).entries()) {
    if (output.producer !== task.role) diagnostics.push(`workflow.required_outputs[${index}].producer must match task role`);
  }
  for (const [index, approval] of approvals.entries()) {
    const binding = objectRecord(approval.binding);
    if (binding.run_id !== runId || binding.task_id !== taskId) {
      diagnostics.push(`approval_decisions[${index}].binding must match snapshot run and task identity`);
    }
  }
  return diagnostics;
}

function gapQuestionDiagnostics(controls: Record<string, unknown>, path: "controls" | "observations"): string[] {
  const diagnostics = [
    ...duplicateKeyDiagnostics(controls.gaps, "gap_id", `${path}.gaps`),
    ...duplicateKeyDiagnostics(controls.questions, "question_id", `${path}.questions`),
  ];
  const questions = new Set(objectArray(controls.questions).map((question) => question.question_id).filter((id): id is string => typeof id === "string"));
  const referenced = new Set<string>();
  for (const [gapIndex, gap] of objectArray(controls.gaps).entries()) {
    for (const questionId of Array.isArray(gap.question_ids) ? gap.question_ids : []) {
      if (typeof questionId !== "string") continue;
      if (!questions.has(questionId)) diagnostics.push(`${path}.gaps[${gapIndex}] references missing question ${questionId}`);
      if (referenced.has(questionId)) diagnostics.push(`${path}.gaps references duplicate question ${questionId}`);
      referenced.add(questionId);
    }
  }
  return diagnostics;
}

function evidenceReferenceDiagnostics(value: unknown, path: string): string[] {
  const diagnostics: string[] = [];
  for (const [index, evidence] of objectArray(value).entries()) {
    if (typeof evidence.evidence_id !== "string" || typeof evidence.reference !== "string") continue;
    let expectedReference: string;
    try {
      expectedReference = evidencePathsForId(evidence.evidence_id).evidence;
    } catch {
      continue;
    }
    if (evidence.reference !== expectedReference) {
      diagnostics.push(`${path}[${index}].reference must be ${expectedReference} for evidence_id ${evidence.evidence_id}`);
    }
  }
  return diagnostics;
}

function sourceReferenceDiagnostics(value: unknown, path: string): string[] {
  return objectArray(value).flatMap((requirement, index) =>
    duplicateKeyDiagnostics(requirement.source_references, "reference", `${path}[${index}].source_references`),
  );
}

function duplicateKeyDiagnostics(value: unknown, key: string, path: string): string[] {
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  for (const [index, entry] of objectArray(value).entries()) {
    const semanticKey = semanticValueIdentity(entry[key]);
    if (seen.has(semanticKey)) diagnostics.push(`${path}[${index}] duplicates semantic key ${key}=${String(semanticKey)}`);
    seen.add(semanticKey);
  }
  return diagnostics;
}

function duplicateScalarDiagnostics(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  for (const [index, entry] of value.entries()) {
    const identity = semanticValueIdentity(entry);
    if (seen.has(identity)) diagnostics.push(`${path}[${index}] duplicates semantic value ${identity}`);
    seen.add(identity);
  }
  return diagnostics;
}

function semanticValueIdentity(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
  }
  return String(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function transitionHistoryDiagnostics(schemaName: SchemaName, value: unknown): string[] {
  if (schemaName === "task") {
    return taskTransitionDiagnostics(value, "$task");
  }
  if (schemaName !== "run" || value === null || typeof value !== "object") {
    return [];
  }

  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    return [];
  }
  return tasks.flatMap((task, index) => taskTransitionDiagnostics(task, `tasks[${index}]`));
}

function taskTransitionDiagnostics(value: unknown, path: string): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }

  const task = value as { status?: unknown; transitions?: unknown };
  if (!Array.isArray(task.transitions)) {
    return [];
  }
  if (task.transitions.length === 0) {
    return task.status === "pending" ? [] : [`${path} is missing activation history for current status`];
  }

  const transitions = task.transitions as Array<{ from?: unknown; to?: unknown }>;
  const diagnostics: string[] = [];
  if (transitions[0].from !== "pending") {
    diagnostics.push(`${path}.transitions[0] must begin from pending activation state`);
  }
  for (let index = 1; index < transitions.length; index += 1) {
    if (transitions[index].from !== transitions[index - 1].to) {
      diagnostics.push(`${path}.transitions[${index}] does not continue from the previous transition`);
    }
  }
  if (transitions.at(-1)?.to !== task.status) {
    diagnostics.push(`${path}.transitions final status does not match current status`);
  }
  return diagnostics;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
