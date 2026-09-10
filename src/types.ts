export type ApplicationLifecycle = "planned" | "scaffolded" | "active";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting_review"
  | "awaiting_approval"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

export type RunStatus =
  | "draft"
  | "intake"
  | "requirements"
  | "awaiting_approval"
  | "technical_design"
  | "implementation"
  | "integration"
  | "qc"
  | "product_owner_review"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface CommandDefinition {
  executable: string;
  args: string[];
  cwd: string;
  network: "disabled" | "restricted" | "required";
  mutates: boolean;
}

export interface FrameworkConfig {
  schema_version: 1;
  framework: {
    name: "codex-sdlc";
    version: string;
    run_schema_version: 1;
    project_schema_version: 1;
  };
  installation: {
    mode: "repository";
    managed_paths: string[];
    repository_specific_paths: string[];
  };
}

export interface ProjectConfig {
  schema_version: 1;
  framework: {
    name: "codex-sdlc";
    version: string;
  };
  project: {
    name: string;
    type: string;
    default_branch: string;
    repository_structure: string;
  };
  applications: Record<string, ApplicationConfig> & {
    backend?: ApplicationConfig;
    web?: ApplicationConfig;
    mobile?: ApplicationConfig;
  };
  data: {
    primary_database: string;
    redis: {
      enabled: boolean;
      roles: string[];
    };
    media: {
      object_storage: string;
      cdn: boolean;
    };
    future_capabilities: Record<string, FutureCapability>;
  };
  security: {
    secret_environment_variables: string[];
    network_policy_attestation_environment: string;
  };
  commands: Record<string, CommandDefinition> & {
    sdlc_test: CommandDefinition;
    sdlc_typecheck: CommandDefinition;
    sdlc_validate: CommandDefinition;
  };
}

export interface ApplicationConfig {
  lifecycle: ApplicationLifecycle;
  root: string;
  framework: string;
  language: string;
  identifiers?: Record<string, string>;
}

export interface FutureCapability {
  enabled: boolean;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: string[];
}

export class SdlcValidationError extends Error {
  public readonly diagnostics: readonly string[];

  public constructor(diagnostics: string[]) {
    super(`SDLC configuration validation failed:\n${diagnostics.join("\n")}`);
    this.name = "SdlcValidationError";
    this.diagnostics = diagnostics;
  }
}

export type TaskRole = "pm" | "ba" | "backend" | "frontend" | "qc";

export type TaskTarget = "backend" | "web" | "mobile" | "integration" | "qc" | null;

export type TaskStage =
  | "intake"
  | "requirements"
  | "requirements_review"
  | "api_contract"
  | "api_contract_review"
  | "backend_implementation"
  | "web_implementation"
  | "mobile_implementation"
  | "integration"
  | "qc"
  | "product_owner_review";

export interface TaskTransition {
  from: TaskStatus | null;
  to: TaskStatus;
  actor: string;
  reason: string;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  stage: TaskStage;
  role: TaskRole;
  target: TaskTarget;
  status: TaskStatus;
  dependencies: string[];
  required_inputs: string[];
  required_outputs: string[];
  outputs: string[];
  evidence: string[];
  transitions: TaskTransition[];
  started_at: string | null;
  completed_at: string | null;
  commit: string | null;
  blocker_reason: string | null;
  failure_reason: string | null;
}

export interface QualityGate {
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "not_applicable";
  evidence: string[];
  history?: QualityGateAudit[];
}

export interface QualityGateAudit {
  status: QualityGate["status"];
  evidence: string[];
  actor: string;
  reason: string;
  at: string;
}

export interface EvidenceRecord {
  schema_version: 1;
  id: string;
  run_id: string;
  task_id: string;
  command_id: string;
  executable: string;
  args: string[];
  cwd: string;
  started_at: string;
  completed_at: string;
  exit_code: number;
  result_status: "passed" | "failed";
  evidence_path: string;
  stdout_path: string;
  stderr_path: string;
}

export interface SdlcDecision {
  id: string;
  topic: string;
  status: "pending" | "approved" | "rejected" | "deferred";
  decision: string | null;
  requested_by: string;
  approved_by: string | null;
  affected_tasks: string[];
  action?: string;
  requested_at?: string;
  decided_at?: string | null;
  consumed_at: string | null;
  consumed_by_transition: string | null;
  transition?: {
    from: RunStatus;
    to: RunStatus;
    actor: string;
    at: string;
  };
}

export interface WorkflowConfig {
  schema_version: 1;
  workflow: { id: "feature-development"; name: string; description: string };
  stages: Array<{
    id: TaskStage;
    name: string;
    owner: TaskRole;
    target?: Exclude<TaskTarget, "integration" | "qc" | null>;
    when_affected?: "backend" | "web" | "mobile";
    depends_on: TaskStage[];
    required_outputs: string[];
    completion_conditions: string[];
  }>;
  [key: string]: unknown;
}

export interface SdlcBlocker {
  id: string;
  task_id: string;
  description: string;
  status: "open" | "resolved";
}

export interface RunManifest {
  schema_version: 1;
  run: {
    id: string;
    title: string;
    workflow: "feature-development";
    status: RunStatus;
    current_stage: string;
    created_at: string | null;
    updated_at: string | null;
    created_by: string;
    current_owner: string;
    branch: string | null;
    framework_version: string;
  };
  request?: {
    source: string;
    file: string;
  };
  affected_applications?: {
    backend: boolean;
    web: boolean;
    mobile: boolean;
    database: boolean;
    shared_packages: boolean;
  };
  tasks: Task[];
  blockers: SdlcBlocker[];
  decisions?: SdlcDecision[];
  defects?: {
    blocker: number;
    critical: number;
    major: number;
    minor: number;
  };
  quality_gates: Record<string, QualityGate>;
  product_owner_review?: {
    status: "pending" | "ready" | "completed";
    decision: "accepted" | "accepted_with_limitations" | "changes_requested" | "rejected" | "deferred" | null;
    comments: string | null;
    decided_at: string | null;
  };
  final_result?: {
    status: "pending" | "ready" | "completed" | "failed" | "cancelled";
    completed_at: string | null;
    report: string;
  };
  [key: string]: unknown;
}
