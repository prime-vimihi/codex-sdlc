import { readFile } from "node:fs/promises";

import { resolveRunReference } from "./evidence-validation.js";
import { parseStrictYamlDocument } from "./semantic-contracts.js";
import { validateDocument } from "./schemas.js";
import type { RunManifest } from "./types.js";

export const advisoryPath = "artifacts/po/advisory-review.yaml";

export interface ProductOwnerAdvisory {
  schema_version: 1;
  run_id: string;
  task_id: "PO-001";
  producer: "po";
  advisory_only: true;
  recommendation: "ready_for_human_review" | "changes_recommended";
  summary: string;
  acceptance_coverage: Array<{ acceptance_criteria_id: string; requirement_id: string; assessment: "supported" | "gap" | "unverified"; sources: string[] }>;
  findings: Array<{ description: string; sources: string[] }>;
}

export async function validateAdvisorySource(root: string, runId: string, manifest: RunManifest, source: string): Promise<ProductOwnerAdvisory> {
  const value = parseStrictYamlDocument(source) as ProductOwnerAdvisory;
  const validation = validateDocument("productOwnerAdvisory", value);
  if (!validation.valid) throw new Error(`invalid Product Owner advisory: ${validation.diagnostics.join("; ")}`);
  const task = manifest.tasks.find((candidate) => candidate.id === "PO-001");
  if (value.run_id !== runId || task?.role !== "po" || manifest.agent_policy?.product_owner_review !== "advisory") {
    throw new Error("Product Owner advisory identity does not match an enabled review task");
  }
  if (new Set(value.acceptance_coverage.map((entry) => entry.acceptance_criteria_id)).size !== value.acceptance_coverage.length) {
    throw new Error("Product Owner advisory contains duplicate acceptance coverage IDs");
  }
  const criteriaPath = await resolveRunReference(root, runId, "artifacts/ba/acceptance-criteria.md");
  const criteria = acceptanceInventory(await readFile(criteriaPath, "utf8"));
  if (criteria.size !== value.acceptance_coverage.length || value.acceptance_coverage.some((entry) => criteria.get(entry.acceptance_criteria_id) !== entry.requirement_id)) {
    throw new Error("Product Owner advisory must cover every authoritative acceptance criterion with its matching requirement ID");
  }
  if (value.recommendation === "ready_for_human_review" && value.acceptance_coverage.some((entry) => entry.assessment !== "supported")) {
    throw new Error("unverified or missing acceptance coverage requires changes_recommended");
  }
  for (const reference of new Set([...value.acceptance_coverage, ...value.findings].flatMap((entry) => entry.sources))) {
    if (reference === advisoryPath) throw new Error("the advisory cannot cite itself as evidence");
    await resolveRunReference(root, runId, reference);
  }
  return value;
}

/** BA's maintained format is one ## AC-* section with a requirement_id per criterion. */
function acceptanceInventory(source: string): Map<string, string> {
  const sections = [...source.matchAll(/^##\s+(AC-[A-Za-z0-9-]+)\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)];
  const inventory = new Map<string, string>();
  for (const section of sections) {
    const id = section[1];
    const requirements = [...section[2].matchAll(/^requirement_id:\s*(REQ-[A-Za-z0-9-]+)\s*$/gm)];
    if (inventory.has(id) || requirements.length !== 1) throw new Error("BA acceptance inventory has duplicate criteria or an invalid requirement mapping");
    inventory.set(id, requirements[0][1]);
  }
  if (inventory.size === 0) throw new Error("BA acceptance inventory has no canonical ## AC-* criteria");
  return inventory;
}

export async function assertProductOwnerAdvisory(root: string, runId: string, manifest: RunManifest): Promise<ProductOwnerAdvisory> {
  const path = await resolveRunReference(root, runId, advisoryPath);
  return validateAdvisorySource(root, runId, manifest, await readFile(path, "utf8"));
}
