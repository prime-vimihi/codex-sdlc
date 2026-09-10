import { describe, expect, test } from "vitest";

import { assignmentStateDiagnostics, normalizePermissionPolicyRoot } from "../src/delivery-authority-resolver.js";
import { validateDocument } from "../src/schemas.js";
import {
  reconcileDeliveryAssignmentAuthority,
  type DeliveryAuthorityIntegrityInputs,
  type DeliveryAuthoritySnapshot,
  type WebDeliveryAssignment,
} from "../src/semantic-contracts.js";
import type { Task } from "../src/types.js";

const hash = "0".repeat(64);

function webAssignment(): WebDeliveryAssignment {
  return {
    schema_version: 1,
    kind: "delivery_assignment",
    assignment_id: "ASN-001",
    run_id: "TEST-001",
    task_id: "WEB-001",
    producer: "pm",
    role: "frontend",
    target: "web",
    stage: "web_implementation",
    scenario: "full_task",
    revision: 1,
    facts_revision: 1,
    facts_sha256: hash,
    task_status: "running",
    scaffold_status: "scaffolded",
    dependencies: [{ task_id: "PM-002", status: "completed" }],
    required_inputs: [],
    required_outputs: [{
      path: ".sdlc/runs/TEST-001/artifacts/web/implementation-summary.md",
      artifact_kind: "implementation_summary",
      producer: "frontend",
      required: true,
    }],
    allowed_write_roots: ["."],
    available_evidence: [],
    evidence_requirements: [{ command_key: "sdlc_test", required: true, owner: "runtime_collector" }],
    transition_policy: { current_status: "running", allowed_request: "awaiting_review", unmet_disposition: "refuse" },
    controls: {
      api_contract_status: "approved",
      gaps: [],
      questions: [],
      requirements: [
        { requirement_id: "REQ-001", capability: "named_export", required: true, parameters: {}, source_references: [{ kind: "fact", reference: "FACT-001" }] },
        { requirement_id: "REQ-002", capability: "semantic_status", required: true, parameters: {}, source_references: [{ kind: "claim", reference: "CLAIM-001" }] },
        { requirement_id: "REQ-003", capability: "safe_fallback", required: true, parameters: {}, source_references: [{ kind: "claim", reference: "CLAIM-002" }] },
        { requirement_id: "REQ-004", capability: "output_escaping", required: true, parameters: {}, source_references: [{ kind: "claim", reference: "CLAIM-003" }] },
        { requirement_id: "REQ-005", capability: "automated_verification", required: true, parameters: {}, source_references: [{ kind: "claim", reference: "CLAIM-004" }] },
      ],
    },
  };
}

describe("delivery authority regressions", () => {
  test("maps a whole-project policy only to the configured root marker", () => {
    expect(normalizePermissionPolicyRoot("**", "TEST-001")).toBe(".");
    expect(normalizePermissionPolicyRoot("web/**", "TEST-001")).toBe("web");
    expect(normalizePermissionPolicyRoot(".sdlc/runs/*/artifacts/web/**", "TEST-001"))
      .toBe(".sdlc/runs/TEST-001/artifacts/web");
  });

  test("accepts required future command evidence before evidence is collected", () => {
    const assignment = webAssignment();
    const authority: DeliveryAuthoritySnapshot = {
      schema_version: 1,
      kind: "delivery_authority_snapshot",
      captured_at: "2026-09-10T00:00:00.000Z",
      assignment: { path: ".sdlc/runs/TEST-001/tasks/WEB-001.assignment.yaml", assignment_id: "ASN-001", revision: 1, sha256: hash },
      run: { path: ".sdlc/runs/TEST-001/manifest.yaml", run_id: "TEST-001", sha256: hash },
      task: { task_id: "WEB-001", role: "frontend", target: "web", stage: "web_implementation", status: "running", dependencies: assignment.dependencies },
      facts: { path: ".sdlc/runs/TEST-001/facts.yaml", producer: "pm", revision: 1, sha256: hash },
      required_inputs: [],
      workflow: { required_outputs: assignment.required_outputs, permission_roots: ["."] },
      evidence_documents: [],
      changed_files: { path: "evidence/diffs/changed-files.json", sha256: hash, files: [] },
      approval_decisions: [],
    };
    const integrity: DeliveryAuthorityIntegrityInputs = {
      assignment_sha256: hash,
      run_sha256: hash,
      facts_sha256: hash,
      required_inputs: [],
      evidence_documents: [],
      changed_files: authority.changed_files,
      approval_decisions: [],
    };

    expect(reconcileDeliveryAssignmentAuthority(assignment, authority, integrity)).toEqual({ valid: true, diagnostics: [] });
  });

  test("accepts unique canonical custom frontend capabilities", () => {
    expect(validateDocument("deliveryAssignment", webAssignment())).toEqual({ valid: true, diagnostics: [] });
    const invalid = webAssignment();
    invalid.controls.requirements[0]!.capability = "Output Escaping";
    expect(validateDocument("deliveryAssignment", invalid).valid).toBe(false);
  });

  test("allows PM to publish running execution authority immediately before activation", () => {
    const assignment = webAssignment();
    const task: Task = {
      id: "WEB-001",
      title: "Web implementation",
      stage: "web_implementation",
      role: "frontend",
      target: "web",
      status: "ready",
      dependencies: ["PM-002"],
      required_inputs: [],
      required_outputs: ["artifacts/web/implementation-summary.md"],
      outputs: [],
      evidence: [],
      transitions: [],
      started_at: null,
      completed_at: null,
      commit: null,
      blocker_reason: null,
      failure_reason: null,
    };

    expect(assignmentStateDiagnostics(task, assignment)).toEqual([]);
  });
});
