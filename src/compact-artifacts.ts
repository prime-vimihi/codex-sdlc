import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { stringify } from "yaml";

import { loadProject } from "./config.js";
import { readEvidenceReference } from "./evidence-validation.js";
import { publishRunAuthority, readAuthorityVersion } from "./manifest-transaction.js";
import { isPortableRepositoryPath, resolvePathInsideRoot } from "./paths.js";
import { acquireRunAuthorityLock, releaseRunAuthorityLock } from "./run-authority-lock.js";
import { loadRunSnapshotUnderLock } from "./runs.js";
import { validateDocument, type SchemaName } from "./schemas.js";
import { parseStrictYamlDocument, type SemanticClaim, type SemanticFact } from "./semantic-contracts.js";
import type { RunManifest, Task } from "./types.js";

export const compactPaths = {
  specification: "artifacts/ba/specification.yaml",
  semanticClaims: "artifacts/ba/semantic-claims.yaml",
  acceptanceCriteria: "artifacts/ba/acceptance-criteria.md",
  verification: "artifacts/qc/verification.yaml",
  summary: "artifacts/qc/summary.md",
} as const;

export type CompactEvidenceType = "command" | "api" | "ui" | "live_database" | "observation";
export interface CompactSpecificationInput {
  scope: { summary: string; in_scope: string[]; out_of_scope: string[] };
  requirements: Array<{ id: string; description: string; fact_ids: string[] }>;
  acceptance_criteria: Array<{ id: string; requirement_id: string; given: string; when: string; then: string; evidence_types: CompactEvidenceType[] }>;
  api_change: { kind: "unchanged" | "additive"; description: string };
}
export interface CompactSpecification extends CompactSpecificationInput {
  schema_version: 1;
  run_id: string;
  task_id: "BA-001";
  producer: "ba";
  revision: number;
  facts_sha256: string;
}
export interface CompactReview {
  specification_revision: number;
  specification_sha256: string;
  facts_sha256: string;
  semantic_claims_sha256: string;
  acceptance_criteria_sha256: string;
}
export interface CompactEvidenceReference { type: CompactEvidenceType; reference: string }
export interface CompactQcInput {
  results: Array<{ ac_id: string; status: "passed" | "failed" | "blocked" | "not_tested"; evidence: CompactEvidenceReference[]; notes: string }>;
  defects: Array<{ id: string; ac_ids: string[]; status: "open" | "resolved"; severity: "critical" | "high" | "medium" | "low"; summary: string }>;
}
export interface CompactQcVerification extends Omit<CompactQcInput, "results"> {
  schema_version: 1;
  run_id: string;
  task_id: "QC-001";
  producer: "qc";
  revision: number;
  reviewed_specification: CompactReview;
  collector_evidence: Array<{ reference: string; sha256: string; status: "passed" | "failed" }>;
  results: Array<Omit<CompactQcInput["results"][number], "evidence"> & { evidence: Array<CompactEvidenceReference & { sha256: string }> }>;
  recommendation: "ready" | "changes_requested";
}
/** Independently authored direct observation. It is evidence content, never a request/spec citation. */
export interface CompactObservation {
  schema_version: 1;
  run_id: string;
  task_id: "QC-001";
  producer: "qc";
  revision: number;
  evidence_type: Exclude<CompactEvidenceType, "command">;
  observed_at: string;
  environment: string;
  procedure: string;
  actual_result: string;
  status: "passed" | "failed";
}
export interface CompactArtifactOptions { dryRun?: boolean; expectedVersion?: number }
export interface CompactSpecificationPublication { dryRun: boolean; authorityVersion: number; paths: string[]; document: CompactSpecification }
export interface CompactQcPublication { dryRun: boolean; authorityVersion: number; paths: string[]; document: CompactQcVerification }
interface FactsDocument { schema_version: 1; run_id: string; producer: "pm"; revision: number; facts: SemanticFact[] }
type CompactManifest = RunManifest & { workflow_profile?: { name: string; revision: number; assessment: Record<string, unknown> }; compact_review?: CompactReview };
interface Context { manifest: RunManifest; version: number }

/** Publish one authored BA specification and two deterministic compatibility views. Never passes a gate. */
export async function publishCompactSpecification(root: string, runId: string, input: CompactSpecificationInput, options: CompactArtifactOptions = {}): Promise<CompactSpecificationPublication> {
  closed(input, ["scope", "requirements", "acceptance_criteria", "api_change"], "compact specification input");
  const context = await capture(root, runId, options);
  requireRunning(context.manifest, "BA-001");
  if ((context.manifest as CompactManifest).compact_review !== undefined) throw new Error("reviewed compact specification is frozen; start a new run to change approved scope");
  const factsSource = await source(root, runId, "facts.yaml");
  const previousSource = await optionalSource(root, runId, compactPaths.specification);
  const previous = previousSource === undefined ? undefined : parseStrictYamlDocument(previousSource) as CompactSpecification;
  if (previous !== undefined) assertSchema("compactSpecification", previous);
  const document: CompactSpecification = { ...structuredClone(input), schema_version: 1, run_id: runId, task_id: "BA-001", producer: "ba", revision: previous?.revision ?? 1, facts_sha256: sha256(factsSource) };
  if (previous !== undefined && !isDeepStrictEqual(document, previous)) document.revision = previous.revision + 1;
  const generated = specificationViews(context.manifest, document, factsSource);
  const publications = [{ path: compactPaths.specification, source: yaml(document) }, { path: compactPaths.semanticClaims, source: generated.claims }, { path: compactPaths.acceptanceCriteria, source: generated.criteria }];
  let authorityVersion = context.version;
  if (!options.dryRun) {
    const publication = await publishRunAuthority(root, runId, publications, {
      expectedVersion: context.version,
      beforeRelease: async () => { if (sha256(await source(root, runId, "facts.yaml")) !== document.facts_sha256) throw new Error("facts changed during compact specification publication"); },
    });
    authorityVersion = publication.authorityVersion;
  }
  return { dryRun: options.dryRun ?? false, authorityVersion, paths: publications.map((entry) => entry.path), document };
}

/** Validate bytes and deterministic views before PM records their exact review binding. */
export async function reviewCompactSpecification(root: string, runId: string, manifest: RunManifest): Promise<CompactReview> {
  return (await readCompactSpecification(root, runId, manifest)).review;
}

export async function readCompactSpecification(root: string, runId: string, manifest: RunManifest): Promise<{ document: CompactSpecification; review: CompactReview }> {
  assertCompact(manifest, runId);
  const [specificationSource, factsSource, claimsSource, criteriaSource] = await Promise.all([
    source(root, runId, compactPaths.specification), source(root, runId, "facts.yaml"),
    source(root, runId, compactPaths.semanticClaims), source(root, runId, compactPaths.acceptanceCriteria),
  ]);
  const document = parseStrictYamlDocument(specificationSource) as CompactSpecification;
  const expected = specificationViews(manifest, document, factsSource);
  if (claimsSource !== expected.claims || criteriaSource !== expected.criteria) throw new Error("compact generated views differ from the canonical specification/facts; regenerate before PM review");
  return { document, review: { specification_revision: document.revision, specification_sha256: sha256(specificationSource), facts_sha256: sha256(factsSource), semantic_claims_sha256: sha256(claimsSource), acceptance_criteria_sha256: sha256(criteriaSource) } };
}

/** Uses the supplied locked manifest; does not recursively acquire the run lock. */
export async function assertCompactReview(root: string, runId: string, manifest: RunManifest): Promise<void> {
  const actual = await reviewCompactSpecification(root, runId, manifest);
  const reviewed = (manifest as CompactManifest).compact_review;
  if (reviewed === undefined || !isDeepStrictEqual(actual, reviewed)) throw new Error("compact specification/facts/views do not match PM's frozen review");
}

/** Publish honest independent QC results, including incomplete/blocked results, without approving readiness. */
export async function publishCompactQc(root: string, runId: string, input: CompactQcInput, options: CompactArtifactOptions = {}): Promise<CompactQcPublication> {
  closed(input, ["results", "defects"], "compact QC input");
  if (!Array.isArray(input.results) || !Array.isArray(input.defects)) throw new Error("compact QC results and defects must be arrays");
  for (const result of input.results) {
    closed(result, ["ac_id", "status", "evidence", "notes"], "compact QC result");
    if (!Array.isArray(result.evidence)) throw new Error("compact QC evidence must be an array");
    for (const evidence of result.evidence) closed(evidence, ["type", "reference"], "compact QC evidence reference");
  }
  const context = await capture(root, runId, options);
  requireRunning(context.manifest, "QC-001");
  await assertCompactReview(root, runId, context.manifest);
  const { document: specification, review } = await readCompactSpecification(root, runId, context.manifest);
  const previousSource = await optionalSource(root, runId, compactPaths.verification);
  const previous = previousSource === undefined ? undefined : parseStrictYamlDocument(previousSource) as CompactQcVerification;
  if (previous !== undefined) assertSchema("compactQc", previous);
  const results: CompactQcVerification["results"] = [];
  for (const result of input.results) {
    const evidence: CompactQcVerification["results"][number]["evidence"] = [];
    for (const reference of result.evidence) {
      const proof = await readProof(root, runId, context.manifest, reference);
      evidence.push({ ...reference, sha256: proof.sha256 });
    }
    results.push({ ...structuredClone(result), evidence });
  }
  const document: CompactQcVerification = { schema_version: 1, run_id: runId, task_id: "QC-001", producer: "qc", revision: previous?.revision ?? 1, reviewed_specification: review, collector_evidence: await qcCollectors(root, runId, context.manifest), results, defects: structuredClone(input.defects), recommendation: "changes_requested" };
  document.recommendation = readyRecommendation(document, specification);
  if (previous !== undefined && !isDeepStrictEqual(previous, document)) document.revision = previous.revision + 1;
  await validateVerification(root, runId, context.manifest, document, specification, review);
  const publications = [{ path: compactPaths.verification, source: yaml(document) }, { path: compactPaths.summary, source: verificationSummary(document) }];
  let authorityVersion = context.version;
  if (!options.dryRun) {
    const published = await publishRunAuthority(root, runId, publications, { expectedVersion: context.version, beforeRelease: async () => {
      await assertCompactReview(root, runId, context.manifest);
      await validateVerification(root, runId, context.manifest, document, specification, review);
    } });
    authorityVersion = published.authorityVersion;
  }
  return { dryRun: options.dryRun ?? false, authorityVersion, paths: publications.map((entry) => entry.path), document };
}

export async function readCompactVerification(root: string, runId: string, manifest: RunManifest): Promise<CompactQcVerification> {
  await assertCompactReview(root, runId, manifest);
  const { document: specification, review } = await readCompactSpecification(root, runId, manifest);
  const document = parseStrictYamlDocument(await source(root, runId, compactPaths.verification)) as CompactQcVerification;
  await validateVerification(root, runId, manifest, document, specification, review);
  if (await source(root, runId, compactPaths.summary) !== verificationSummary(document)) throw new Error("compact QC summary differs from canonical verification");
  return document;
}

export async function assertCompactVerification(root: string, runId: string, manifest: RunManifest): Promise<void> {
  const document = await readCompactVerification(root, runId, manifest);
  if (document.recommendation !== "ready") throw new Error("compact QC is not ready: every AC needs passed direct evidence and no open defects");
}

function specificationViews(manifest: RunManifest, document: CompactSpecification, factsSource: string): { claims: string; criteria: string } {
  assertCompact(manifest, document.run_id);
  assertSchema("compactSpecification", document);
  const facts = parseStrictYamlDocument(factsSource) as FactsDocument;
  assertSchema("facts", facts);
  if (facts.run_id !== document.run_id || document.facts_sha256 !== sha256(factsSource)) throw new Error("compact specification facts binding is stale or belongs to another run");
  uniqueIds(facts.facts, "id", "facts");
  uniqueIds(document.requirements, "id", "requirements");
  uniqueIds(document.acceptance_criteria, "id", "acceptance criteria");
  if (document.scope.in_scope.some((item) => document.scope.out_of_scope.includes(item))) throw new Error("compact scope cannot include and exclude the same item");
  if (document.api_change.kind === "additive" && !manifest.affected_applications?.backend) throw new Error("additive API change requires an affected backend application");
  if (facts.facts.some((fact) => fact.status === "unresolved" || fact.status === "proposed")) throw new Error("Compact specification cannot omit unresolved or proposed feature facts; resolve or explicitly mark them out_of_scope first");
  const approved = facts.facts.filter((fact) => fact.status === "approved");
  if (approved.length === 0) throw new Error("compact specification requires approved facts");
  const references = new Map<string, string[]>();
  for (const requirement of document.requirements) {
    for (const factId of requirement.fact_ids) {
      const fact = facts.facts.find((candidate) => candidate.id === factId);
      if (fact?.status !== "approved") throw new Error(`requirement ${requirement.id} references missing or unresolved/unapproved fact ${factId}`);
      references.set(factId, [...(references.get(factId) ?? []), requirement.id]);
    }
    if (!document.acceptance_criteria.some((criterion) => criterion.requirement_id === requirement.id)) throw new Error(`requirement ${requirement.id} has no acceptance criterion`);
  }
  for (const fact of approved) if (!references.has(fact.id)) throw new Error(`approved fact ${fact.id} has no requirement link`);
  for (const criterion of document.acceptance_criteria) if (!document.requirements.some((requirement) => requirement.id === criterion.requirement_id)) throw new Error(`acceptance criterion ${criterion.id} references missing requirement ${criterion.requirement_id}`);
  const claims: SemanticClaim[] = approved.map((fact) => ({ ...structuredClone(fact), id: fact.id.replace("FACT-", "CLAIM-") as SemanticClaim["id"], source_fact_id: fact.id, requirement_ids: references.get(fact.id)! as SemanticClaim["requirement_ids"], question_ids: [] }));
  const claimsDocument = { schema_version: 1, run_id: document.run_id, task_id: "BA-001", producer: "ba", revision: document.revision, claims };
  assertSchema("semanticClaims", claimsDocument);
  const criteria = document.acceptance_criteria.map((criterion) => {
    const claimIds = claims.filter((claim) => claim.requirement_ids.includes(criterion.requirement_id as `REQ-${string}`)).map((claim) => claim.id);
    return `## ${criterion.id}\n\nrequirement_id: ${criterion.requirement_id}\nclaim_ids: [${claimIds.join(", ")}]\n\nGiven ${oneLine(criterion.given)}\nWhen ${oneLine(criterion.when)}\nThen ${oneLine(criterion.then)}\n\nevidence_expected: ${criterion.evidence_types.join(", ")}\n`;
  });
  return { claims: yaml(claimsDocument), criteria: `---\nrun_id: ${document.run_id}\ntask_id: BA-001\nproducer: ba\nstatus: draft\nrevision: ${document.revision}\n---\n\n# Acceptance criteria\n\n${criteria.join("\n")}` };
}

async function validateVerification(root: string, runId: string, manifest: RunManifest, document: CompactQcVerification, specification: CompactSpecification, review: CompactReview): Promise<void> {
  assertSchema("compactQc", document);
  if (document.run_id !== runId || !isDeepStrictEqual(document.reviewed_specification, review)) throw new Error("compact QC belongs to another run or reviewed specification");
  if (!isDeepStrictEqual(document.collector_evidence, await qcCollectors(root, runId, manifest))) throw new Error("compact QC collector evidence changed or does not belong to current independent QC");
  uniqueIds(document.results, "ac_id", "QC results");
  uniqueIds(document.defects, "id", "QC defects");
  const expected = new Set(specification.acceptance_criteria.map((criterion) => criterion.id));
  if (document.results.length !== expected.size || document.results.some((result) => !expected.has(result.ac_id))) throw new Error("compact QC must cover every canonical AC exactly once");
  for (const result of document.results) {
    const criterion = specification.acceptance_criteria.find((entry) => entry.id === result.ac_id)!;
    const seen = new Set<string>();
    for (const reference of result.evidence) {
      if (!criterion.evidence_types.includes(reference.type)) throw new Error(`${result.ac_id} cites undeclared evidence type ${reference.type}`);
      if (seen.has(reference.reference)) throw new Error(`${result.ac_id} duplicates evidence reference ${reference.reference}`);
      seen.add(reference.reference);
      if (reference.type === "command" && !document.collector_evidence.some((entry) => entry.reference === reference.reference)) throw new Error(`${result.ac_id} command evidence is superseded by a newer QC check`);
      const actual = await readProof(root, runId, manifest, reference);
      if (actual.sha256 !== reference.sha256) throw new Error(`compact QC evidence changed: ${reference.reference}`);
      if (result.status === "passed" && actual.status !== "passed") throw new Error(`${result.ac_id} cannot pass with failed direct evidence`);
    }
    if (result.status === "passed" && criterion.evidence_types.some((type) => !result.evidence.some((entry) => entry.type === type))) throw new Error(`${result.ac_id} passed without every required evidence type`);
  }
  for (const defect of document.defects) {
    if (defect.ac_ids.some((id) => !expected.has(id))) throw new Error(`defect ${defect.id} references an unknown acceptance criterion`);
    if (defect.status === "resolved" && defect.ac_ids.some((id) => document.results.find((result) => result.ac_id === id)?.status !== "passed")) throw new Error(`resolved defect ${defect.id} requires passed retest coverage`);
  }
  if (document.recommendation !== readyRecommendation(document, specification)) throw new Error("compact QC recommendation does not match direct coverage and open defects");
}

function readyRecommendation(document: Pick<CompactQcVerification, "results" | "defects" | "collector_evidence">, specification: CompactSpecification): "ready" | "changes_requested" {
  return document.collector_evidence.length > 0
    && document.collector_evidence.every((entry) => entry.status === "passed")
    && document.results.length === specification.acceptance_criteria.length
    && document.results.every((result) => result.status === "passed")
    && document.defects.every((defect) => defect.status !== "open") ? "ready" : "changes_requested";
}

async function readProof(root: string, runId: string, manifest: RunManifest, reference: CompactEvidenceReference): Promise<{ sha256: string; status: "passed" | "failed" }> {
  closed(reference, Object.hasOwn(reference, "sha256") ? ["type", "reference", "sha256"] : ["type", "reference"], "QC evidence");
  const qc = manifest.tasks.find((task) => task.id === "QC-001");
  if (qc?.role !== "qc" || qc.started_at === null) throw new Error("direct QC evidence requires an activated independent QC task");
  if (!isPortableRepositoryPath(reference.reference) || reference.reference === ".") throw new Error("QC evidence reference must be a portable run-relative path");
  if (reference.type === "command") {
    if (!qc.evidence.includes(reference.reference)) throw new Error("compact command evidence must be recorded by QC-001, not an implementation task");
    const evidence = await readEvidenceReference({ root, runId, manifest, reference: reference.reference, project: await loadProject(root), owner: "qc", expectedTask: qc, expectedStage: "qc" });
    if (Date.parse(evidence.record.started_at) < Date.parse(qc.started_at)) throw new Error("compact command evidence predates the independent QC activation");
    if (Date.parse(evidence.record.started_at) > Date.now() || Date.parse(evidence.record.completed_at) > Date.now() || Date.parse(evidence.record.completed_at) < Date.parse(evidence.record.started_at)) throw new Error("compact command evidence has future or reversed timestamps");
    return { sha256: sha256(evidence.source), status: evidence.record.result_status };
  }
  if (!["api", "ui", "live_database", "observation"].includes(reference.type)
    || !reference.reference.startsWith("artifacts/qc/evidence/") || !/\.ya?ml$/u.test(reference.reference)) throw new Error("direct observations must be QC evidence YAML artifacts, never request/specification/self citations");
  const observationSource = await source(root, runId, reference.reference);
  const observation = parseStrictYamlDocument(observationSource) as CompactObservation;
  closed(observation, ["schema_version", "run_id", "task_id", "producer", "revision", "evidence_type", "observed_at", "environment", "procedure", "actual_result", "status"], "direct QC observation");
  if (observation.schema_version !== 1 || observation.run_id !== runId || observation.task_id !== "QC-001" || observation.producer !== "qc"
    || !Number.isInteger(observation.revision) || observation.revision < 1 || observation.evidence_type !== reference.type
    || !["passed", "failed"].includes(observation.status)
    || !Number.isFinite(Date.parse(observation.observed_at)) || Date.parse(observation.observed_at) < Date.parse(qc.started_at) || Date.parse(observation.observed_at) > Date.now()
    || [observation.environment, observation.procedure, observation.actual_result].some((value) => typeof value !== "string" || !value.trim())) throw new Error("direct QC observation lacks matching identity, type, time, environment, procedure, or actual result");
  const repair = manifest.repair_history?.findLast((record) => record.affected_task_ids.includes("QC-001"));
  if (repair !== undefined && Date.parse(observation.observed_at) < Date.parse(repair.at)) throw new Error("direct QC observation predates the current repair cycle");
  return { sha256: sha256(observationSource), status: observation.status };
}

async function qcCollectors(root: string, runId: string, manifest: RunManifest): Promise<Array<{ reference: string; sha256: string; status: "passed" | "failed" }>> {
  const qc = manifest.tasks.find((task) => task.id === "QC-001");
  if (qc?.role !== "qc" || qc.started_at === null) throw new Error("compact verification requires an activated independent QC task");
  const project = await loadProject(root);
  const latest = new Map<string, { reference: string; sha256: string; status: "passed" | "failed" }>();
  for (const reference of qc.evidence) {
    const evidence = await readEvidenceReference({ root, runId, manifest, reference, project, owner: "qc", expectedTask: qc, expectedStage: "qc" });
    if (Date.parse(evidence.record.started_at) < Date.parse(qc.started_at)) throw new Error("QC collector evidence predates its current activation");
    if (Date.parse(evidence.record.started_at) > Date.now() || Date.parse(evidence.record.completed_at) > Date.now() || Date.parse(evidence.record.completed_at) < Date.parse(evidence.record.started_at)) throw new Error("QC collector evidence has future or reversed timestamps");
    latest.set(evidence.record.command_id, { reference, sha256: sha256(evidence.source), status: evidence.record.result_status });
  }
  return [...latest.values()];
}

function verificationSummary(document: CompactQcVerification): string {
  return `---\nrun_id: ${document.run_id}\ntask_id: QC-001\nproducer: qc\nrevision: ${document.revision}\n---\n\n# Independent verification\n\nRecommendation: ${document.recommendation}\n\n${document.results.map((result) => `- ${result.ac_id}: ${result.status}. ${oneLine(result.notes)}`).join("\n")}\n\nOpen defects: ${document.defects.filter((defect) => defect.status === "open").map((defect) => defect.id).join(", ") || "none"}\n`;
}

async function capture(root: string, runId: string, options: CompactArtifactOptions): Promise<Context> {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(runId)) throw new Error("compact artifacts require a canonical run ID");
  const lock = await acquireRunAuthorityLock(root, runId);
  try {
    const { manifest } = await loadRunSnapshotUnderLock(root, runId, false, lock);
    assertCompact(manifest, runId);
    const version = await readAuthorityVersion(root, runId);
    if (options.expectedVersion !== undefined && options.expectedVersion !== version) throw new Error(`stale authority version: expected ${options.expectedVersion} but actual ${version}`);
    return { manifest, version };
  } finally { await releaseRunAuthorityLock(lock); }
}
function assertCompact(manifest: RunManifest, runId: string): void {
  const profile = (manifest as CompactManifest).workflow_profile;
  const assessment = profile?.assessment;
  if (manifest.run.id !== runId || profile?.name !== "compact" || profile.revision !== 1 || !assessment
    || assessment.bounded_scope !== true || assessment.existing_patterns !== true
    || ["migrations", "breaking_api", "authorization_changes", "sensitive_data_exposure", "cross_system_uncertainty"].some((key) => assessment[key] !== false)
    || typeof assessment.rationale !== "string" || !assessment.rationale.trim()) throw new Error("compact artifacts require an eligible bounded Compact workflow assessment");
}
function requireRunning(manifest: RunManifest, taskId: string): Task {
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  if (task?.status !== "running" || task.dependencies.some((id) => manifest.tasks.find((entry) => entry.id === id)?.status !== "completed")) throw new Error(`${taskId} must be running with completed dependencies to author compact artifacts`);
  return task;
}
function uniqueIds<T extends object>(items: T[], key: keyof T, label: string): void {
  const ids = items.map((item) => item[key]);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contain duplicate ${String(key)} values`);
}
function assertSchema(name: SchemaName, value: unknown): void {
  const validation = validateDocument(name, value);
  if (!validation.valid) throw new Error(`invalid ${name}: ${validation.diagnostics.join("; ")}`);
}
function closed(value: unknown, keys: string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`${label} must contain exactly ${keys.join(", ")}`);
}
async function source(root: string, runId: string, path: string): Promise<string> {
  if (!isPortableRepositoryPath(path) || path === ".") throw new Error("invalid compact artifact path");
  return readFile(await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${path}`, { mustExist: true }), "utf8");
}
async function optionalSource(root: string, runId: string, path: string): Promise<string | undefined> {
  try { return await source(root, runId, path); }
  catch (error) { if (error instanceof Error && /path does not exist inside repository root/.test(error.message)) return undefined; throw error; }
}
function yaml(value: unknown): string { return stringify(value, { aliasDuplicateObjects: false }); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function oneLine(value: string): string { return value.replace(/[\r\n]+/gu, " "); }
