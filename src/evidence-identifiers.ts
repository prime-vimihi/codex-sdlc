export const EVIDENCE_ID_COMPONENT_PATTERN_SOURCE = String.raw`EVD-[0-9a-f]{16}(?:-(?:[2-9]|[1-9][0-9]+))?`;
export const EVIDENCE_ID_PATTERN_SOURCE = `^${EVIDENCE_ID_COMPONENT_PATTERN_SOURCE}$`;
export const EVIDENCE_REFERENCE_PATTERN_SOURCE = String.raw`^evidence/commands/(${EVIDENCE_ID_COMPONENT_PATTERN_SOURCE})/evidence\.json$`;

const evidenceIdPattern = new RegExp(EVIDENCE_ID_PATTERN_SOURCE);
const evidenceReferencePattern = new RegExp(EVIDENCE_REFERENCE_PATTERN_SOURCE);

export interface EvidencePaths {
  base: string;
  evidence: string;
  stdout: string;
  stderr: string;
}

export function createEvidenceId(digest: string, allocation: number): string {
  if (!/^[0-9a-f]{16}$/.test(digest)) {
    throw new Error("evidence digest must be exactly 16 lowercase hexadecimal characters");
  }
  if (!Number.isSafeInteger(allocation) || allocation < 1) {
    throw new Error("evidence allocation must be a positive safe integer");
  }
  const id = `EVD-${digest}${allocation === 1 ? "" : `-${allocation}`}`;
  if (!evidenceIdPattern.test(id)) {
    throw new Error(`generated evidence ID is not canonical: ${id}`);
  }
  return id;
}

export function evidenceIdFromReference(reference: string): string | undefined {
  return evidenceReferencePattern.exec(reference)?.[1];
}

export function evidencePathsForId(id: string): EvidencePaths {
  if (!evidenceIdPattern.test(id)) {
    throw new Error(`evidence ID is not canonical: ${id}`);
  }
  const base = `evidence/commands/${id}`;
  return {
    base,
    evidence: `${base}/evidence.json`,
    stdout: `${base}/stdout.txt`,
    stderr: `${base}/stderr.txt`,
  };
}
