import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import { Command, CommanderError } from "commander";

import { loadFramework, loadProject } from "./config.js";
import { validateCliArguments } from "./cli-grammar.js";
import { executeConfiguredCommand } from "./evidence.js";
import { finalizeRun } from "./finalize.js";
import { decideApproval, recordProductOwnerDecision, recordQualityGate, requestApproval } from "./lifecycle.js";
import { initializeProject, inspectProject } from "./install.js";
import { rollbackProject, uninstallProject, upgradeProject } from "./installation-lifecycle.js";
import { FRAMEWORK_VERSION } from "./constants.js";
import { mutateRunManifest, publishRunAuthority, type RunAuthorityPublication } from "./manifest-transaction.js";
import { isPortableRepositoryPath, portableRepositoryPathKey, resolvePathInsideRoot, SdlcPathError } from "./paths.js";
import { SdlcPolicyError } from "./policy.js";
import { loadRun, startRun, validateRun } from "./runs.js";
import { parseStrictYamlDocument } from "./semantic-contracts.js";
import { prepareTransitionContext, SdlcTransitionError, SdlcTransitionUsageError, transitionTask } from "./transitions.js";
import { SdlcValidationError, type TaskStatus } from "./types.js";

const exitCodes = {
  success: 0,
  failure: 1,
  usage: 2,
  unsafe: 3,
} as const;

type Diagnostic = { code: string; path?: string; message: string };

interface CliResult<T = unknown> {
  ok: boolean;
  command: string;
  result?: T;
  diagnostics: Diagnostic[];
}

class CliFailure extends Error {
  public constructor(
    public readonly exitCode: number,
    public readonly diagnostic: Diagnostic,
  ) {
    super(diagnostic.message);
    this.name = "CliFailure";
  }
}

interface StartOptions {
  id: string;
  title: string;
  request: string;
  applications: string;
}

interface InitOptions {
  root?: string;
  name: string;
  applications?: string;
  backendRoot?: string;
  webRoot?: string;
  mobileRoot?: string;
  backendPreset?: string;
  webPreset?: string;
  mobilePreset?: string;
  databasePreset?: string;
  redis?: boolean;
  dryRun?: boolean;
  runtimeSpec?: string;
}

interface RootOptions { root?: string }

interface UpgradeOptions extends RootOptions {
  runtimeSpec?: string;
  dryRun?: boolean;
}

interface UninstallOptions extends RootOptions { dryRun?: boolean }

interface RollbackOptions extends RootOptions {
  backup?: string;
  dryRun?: boolean;
}

interface TransitionOptions {
  actor: string;
  reason: string;
  resolveBlocker?: string;
  retryReason?: string;
  decision?: string;
}

interface ActorOptions {
  actor: string;
}

interface GateOptions extends ActorOptions { reason: string; evidence: string[] }
interface ApprovalRequestOptions extends ActorOptions { id: string; topic: string }
interface ApprovalDecisionOptions { approver: string; decision: string }
interface ProductOwnerDecisionOptions extends ActorOptions { comments: string }
interface AuthorityPublicationOptions extends ActorOptions { expectedVersion: string }

type PublicationActor = "pm" | "ba" | "backend" | "frontend" | "qc" | "runtime_collector";

interface AffectedApplications {
  backend: boolean;
  web: boolean;
  mobile: boolean;
  database: boolean;
  sharedPackages: boolean;
}

export async function main(rawArguments = process.argv.slice(2)): Promise<number> {
  const root = process.cwd();
  const now = new Date().toISOString();
  let executed = false;
  let resultWritten = false;
  let activeCommand: string | undefined;
  const program = new Command();

  program
    .name("codex-sdlc")
    .description("Deterministic repository-scoped SDLC workflow commands")
    .version(FRAMEWORK_VERSION)
    .option("--json", "emit one JSON result document")
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({ writeOut: (value) => process.stdout.write(value), writeErr: () => undefined });

  const emit = <T>(command: string, result: T, summary: string, diagnostics: Diagnostic[] = [], code: number = exitCodes.success): void => {
    const payload: CliResult<T> = { ok: code === exitCodes.success, command, result, diagnostics };
    if (program.opts<{ json?: boolean }>().json === true || rawArguments.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`${code === exitCodes.success ? "OK" : "FAILED"}: ${summary}\n`);
      for (const diagnostic of diagnostics) {
        process.stdout.write(`${diagnostic.code}: ${diagnostic.message}\n`);
      }
    }
    resultWritten = true;
    process.exitCode = code;
  };

  program.command("init")
    .requiredOption("--name <project-name>")
    .option("--root <path>", "repository root", ".")
    .option("--applications <csv>", "backend, web, mobile, or a comma-separated combination", "backend")
    .option("--backend-root <path>", "backend application root")
    .option("--web-root <path>", "web application root")
    .option("--mobile-root <path>", "mobile application root")
    .option("--backend-preset <id>", "generic or go", "generic")
    .option("--web-preset <id>", "generic or nextjs", "generic")
    .option("--mobile-preset <id>", "generic or flutter", "generic")
    .option("--database-preset <id>", "none or postgresql", "none")
    .option("--redis", "enable the Redis cache preset")
    .option("--runtime-spec <npm-spec>", "exact npm dependency spec for the project runtime")
    .option("--dry-run", "show the installation plan without writing")
    .action(async (options: InitOptions) => {
      executed = true;
      activeCommand = "init";
      const result = await initializeProject({
        root: options.root ?? ".",
        projectName: options.name,
        applications: parseConfiguredApplications(options.applications ?? "backend"),
        backendRoot: options.backendRoot,
        webRoot: options.webRoot,
        mobileRoot: options.mobileRoot,
        backendPreset: assertPreset(options.backendPreset ?? "generic", ["generic", "go"], "backend") as "generic" | "go",
        webPreset: assertPreset(options.webPreset ?? "generic", ["generic", "nextjs"], "web") as "generic" | "nextjs",
        mobilePreset: assertPreset(options.mobilePreset ?? "generic", ["generic", "flutter"], "mobile") as "generic" | "flutter",
        databasePreset: assertPreset(options.databasePreset ?? "none", ["none", "postgresql"], "database") as "none" | "postgresql",
        redis: options.redis ?? false,
        dryRun: options.dryRun ?? false,
        runtimeSpec: options.runtimeSpec,
      });
      emit("init", result, result.dry_run ? `planned ${result.files.length} files` : `initialized ${result.root}`);
    });

  program.command("doctor")
    .option("--root <path>", "repository root", ".")
    .action(async (options: RootOptions) => {
      executed = true;
      activeCommand = "doctor";
      const result = await inspectProject(options.root ?? ".");
      const diagnostics = result.diagnostics.map((message) => ({ code: "DIAGNOSTIC", message }));
      emit("doctor", result, result.ready ? "installation is ready" : "installation needs attention", diagnostics, result.ready ? exitCodes.success : exitCodes.failure);
    });

  program.command("upgrade")
    .option("--root <path>", "repository root", ".")
    .option("--runtime-spec <npm-spec>", "exact npm dependency spec for the upgraded project runtime")
    .option("--dry-run", "show the upgrade plan without writing")
    .action(async (options: UpgradeOptions) => {
      executed = true;
      activeCommand = "upgrade";
      const result = await upgradeProject({
        root: options.root ?? ".",
        runtimeSpec: options.runtimeSpec,
        dryRun: options.dryRun ?? false,
      });
      const summary = result.dry_run
        ? `planned upgrade from ${result.from_version} to ${result.to_version}; backup ${result.backup_id}`
        : `upgraded from ${result.from_version} to ${result.to_version}; backup ${result.backup_id}; run node .sdlc/runtime.cjs restore`;
      emit("upgrade", result, summary);
    });

  program.command("rollback")
    .option("--root <path>", "repository root", ".")
    .option("--backup <backup-id>", "specific lifecycle backup; defaults to the latest available backup")
    .option("--dry-run", "show the rollback plan without writing")
    .action(async (options: RollbackOptions) => {
      executed = true;
      activeCommand = "rollback";
      const result = await rollbackProject({
        root: options.root ?? ".",
        backupId: options.backup,
        dryRun: options.dryRun ?? false,
      });
      const summary = result.dry_run
        ? `planned rollback of backup ${result.backup_id}`
        : `rolled back backup ${result.backup_id}; run node .sdlc/runtime.cjs restore`;
      emit("rollback", result, summary);
    });

  program.command("uninstall")
    .option("--root <path>", "repository root", ".")
    .option("--dry-run", "show the uninstall plan without writing")
    .action(async (options: UninstallOptions) => {
      executed = true;
      activeCommand = "uninstall";
      const result = await uninstallProject({ root: options.root ?? ".", dryRun: options.dryRun ?? false });
      const summary = result.dry_run
        ? `planned uninstall; backup ${result.backup_id}`
        : `uninstalled codex-sdlc; project data preserved; backup ${result.backup_id}`;
      emit("uninstall", result, summary);
    });

  program.command("validate-config").action(async () => {
    executed = true;
    activeCommand = "validate-config";
    const diagnostics: Diagnostic[] = [];
    const [framework, project] = await Promise.allSettled([loadFramework(root), loadProject(root)]);
    if (framework.status === "rejected") diagnostics.push(...diagnosticsFromError(framework.reason));
    if (project.status === "rejected") diagnostics.push(...diagnosticsFromError(project.reason));
    if (diagnostics.length > 0) {
      emit("validate-config", undefined, "configuration validation failed", diagnostics, exitCodes.failure);
      return;
    }
    if (framework.status !== "fulfilled" || project.status !== "fulfilled") {
      throw new Error("configuration validation did not produce a result");
    }
    emit("validate-config", { framework: framework.value, project: project.value }, "configuration is valid");
  });

  program.command("start")
    .requiredOption("--id <run-id>")
    .requiredOption("--title <title>")
    .requiredOption("--request <path>")
    .requiredOption("--applications <applications>")
    .action(async (options: StartOptions) => {
      executed = true;
      activeCommand = "start";
      const inspection = await inspectProject(root);
      if (!inspection.ready) {
        throw new SdlcValidationError(["project is not ready", ...inspection.diagnostics]);
      }
      const affectedApplications = parseApplications(options.applications);
      const project = await loadProject(root);
      for (const application of ["backend", "web", "mobile"] as const) {
        if (affectedApplications[application] && project.applications[application] === undefined) {
          throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `${application} is not configured in .sdlc/project.yaml` });
        }
      }
      const runDirectory = await startRun(root, {
        id: options.id,
        title: options.title,
        requestFile: options.request,
        affectedApplications,
        now,
      });
      const manifestPath = relative(root, `${runDirectory}/manifest.yaml`).replaceAll("\\", "/");
      emit("start", { run_id: options.id, manifest_path: manifestPath }, `created ${manifestPath}`);
    });

  program.command("ready <run-id>").action(async (runId: string) => {
    executed = true;
    activeCommand = "ready";
    const manifest = await loadRun(root, runId);
    const readyTaskIds = manifest.tasks.filter((task) => task.status === "ready").map((task) => task.id);
    emit("ready", { run_id: runId, ready_task_ids: readyTaskIds }, readyTaskIds.length === 0 ? "no tasks are ready" : `ready tasks: ${readyTaskIds.join(", ")}`);
  });

  program.command("transition <run-id> <task-id> <status>")
    .requiredOption("--actor <actor>")
    .requiredOption("--reason <reason>")
    .option("--resolve-blocker <blocker-id>", "resolve this open blocker before returning to ready")
    .option("--retry-reason <reason>", "record the reason for retrying a failed task")
    .option("--decision <decision-id>", "bind an approved decision to an approval transition")
    .action(async (runId: string, taskId: string, status: string, options: TransitionOptions) => {
      executed = true;
      activeCommand = "transition";
      const target = assertTaskStatus(status);
      const transaction = await mutateRunManifest(root, runId, async (manifest) => {
        const context = await prepareTransitionContext(root, runId, manifest, {
          taskId,
          to: target,
          actor: options.actor,
          reason: options.reason,
          at: now,
        }, { resolveBlockerId: options.resolveBlocker, retryReason: options.retryReason, decisionId: options.decision });
        const updated = transitionTask(manifest, { taskId, to: target, actor: options.actor, reason: options.reason, at: now }, context);
        Object.assign(manifest, updated);
      });
      const task = transaction.manifest.tasks.find((candidate) => candidate.id === taskId);
      emit("transition", { run_id: runId, task, blockers: transaction.manifest.blockers }, `transitioned ${taskId} to ${target}`);
    });

  program.command("validate-run <run-id>").action(async (runId: string) => {
    executed = true;
    activeCommand = "validate-run";
    const report = await validateRun(root, runId);
    const diagnostics = report.diagnostics.map((message) => ({ code: "VALIDATION", message }));
    if (!report.valid) {
      emit("validate-run", report, "run validation failed", diagnostics, exitCodes.failure);
      return;
    }
    emit("validate-run", report, "run is valid");
  });

  program.command("publish-authority <run-id>")
    .requiredOption("--actor <role>")
    .requiredOption("--expected-version <version>")
    .action(async (runId: string, options: AuthorityPublicationOptions) => {
      executed = true;
      activeCommand = "publish-authority";
      const actor = assertPublicationActor(options.actor);
      const expectedVersion = parseAuthorityVersion(options.expectedVersion);
      const publications = await loadAuthorityPublications(root, runId, actor);
      const transaction = await publishRunAuthority(root, runId, publications, { expectedVersion });
      emit("publish-authority", {
        run_id: runId,
        actor,
        authority_version: transaction.authorityVersion,
        published_paths: publications.map((publication) => publication.path),
      }, `published ${publications.length} authority file${publications.length === 1 ? "" : "s"} at version ${transaction.authorityVersion}`);
    });

  program.command("evidence <run-id> <task-id> <command-id>").action(async (runId: string, taskId: string, commandId: string) => {
    executed = true;
    activeCommand = "evidence";
    const record = await executeConfiguredCommand(root, runId, taskId, commandId);
    const diagnostics = record.exit_code === 0 ? [] : [{ code: "COMMAND_FAILED", message: `configured command exited with ${record.exit_code}` }];
    emit("evidence", record, record.exit_code === 0 ? `recorded ${record.evidence_path}` : `recorded failed evidence ${record.evidence_path}`, diagnostics, record.exit_code === 0 ? exitCodes.success : exitCodes.failure);
  });

  program.command("finalize <run-id>")
    .requiredOption("--actor <actor>")
    .action(async (runId: string, options: ActorOptions) => {
      executed = true;
      activeCommand = "finalize";
      const manifest = await finalizeRun(root, runId, options.actor, now);
      emit("finalize", { run_id: runId, status: manifest.run.status, manifest }, `prepared ${runId} for Product Owner review`);
    });

  program.command("quality-gate <run-id> <gate-id> <status>")
    .requiredOption("--actor <actor>")
    .requiredOption("--reason <reason>")
    .option("--evidence <path>", "run-relative command evidence path; repeat for multiple records", collectOption, [])
    .action(async (runId: string, gateId: string, status: string, options: GateOptions) => {
      executed = true;
      activeCommand = "quality-gate";
      const manifest = await recordQualityGate(root, runId, gateId, assertGateStatus(status), options.evidence, options.actor, options.reason, now);
      emit("quality-gate", { run_id: runId, gate_id: gateId, gate: manifest.quality_gates[gateId] }, `recorded ${gateId} gate as ${status}`);
    });

  program.command("approval-request <run-id> <task-id> <target-status>")
    .requiredOption("--id <decision-id>")
    .requiredOption("--actor <actor>")
    .requiredOption("--topic <topic>")
    .action(async (runId: string, taskId: string, targetStatus: string, options: ApprovalRequestOptions) => {
      executed = true;
      activeCommand = "approval-request";
      if (targetStatus !== "running" && targetStatus !== "completed") throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "approval target must be running or completed" });
      const manifest = await requestApproval(root, runId, taskId, targetStatus, options.id, options.topic, options.actor, now);
      emit("approval-request", { run_id: runId, decision: manifest.decisions?.find((candidate) => candidate.id === options.id) }, `requested ${options.id}`);
    });

  program.command("approval-decision <run-id> <decision-id> <status>")
    .requiredOption("--approver <actor>")
    .requiredOption("--decision <text>")
    .action(async (runId: string, decisionId: string, status: string, options: ApprovalDecisionOptions) => {
      executed = true;
      activeCommand = "approval-decision";
      if (status !== "approved" && status !== "rejected") throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "approval decision must be approved or rejected" });
      const manifest = await decideApproval(root, runId, decisionId, status, options.approver, options.decision, now);
      emit("approval-decision", { run_id: runId, decision: manifest.decisions?.find((candidate) => candidate.id === decisionId) }, `recorded ${decisionId} as ${status}`);
    });

  program.command("product-owner-decision <run-id> <decision>")
    .requiredOption("--actor <actor>")
    .requiredOption("--comments <comments>")
    .action(async (runId: string, decision: string, options: ProductOwnerDecisionOptions) => {
      executed = true;
      activeCommand = "product-owner-decision";
      const selected = assertProductOwnerDecision(decision);
      const manifest = await recordProductOwnerDecision(root, runId, selected, options.actor, options.comments, now);
      emit("product-owner-decision", { run_id: runId, status: manifest.run.status, final_result: manifest.final_result?.status, product_owner_review: manifest.product_owner_review }, `recorded Product Owner decision ${selected}`);
    });

  try {
    const informational = rawArguments.includes("--help") || rawArguments.includes("-h") || rawArguments.includes("--version") || rawArguments.includes("-V");
    if (!informational) {
      const grammarDiagnostics = validateCliArguments(rawArguments);
      if (grammarDiagnostics.length > 0) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: grammarDiagnostics.map((entry) => entry.message).join("; ") });
    }
    await program.parseAsync(["node", "sdlc", ...rawArguments]);
    if (!executed) {
      throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "a command is required" });
    }
    return typeof process.exitCode === "number" ? process.exitCode : exitCodes.success;
  } catch (error) {
    if (error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version")) {
      process.exitCode = exitCodes.success;
      return exitCodes.success;
    }
    if (!resultWritten) {
      const failure = classifyError(error);
      emit(activeCommand ?? attemptedCommand(rawArguments), undefined, failure.diagnostic.message, [failure.diagnostic], failure.exitCode);
    }
    return typeof process.exitCode === "number" ? process.exitCode : exitCodes.failure;
  }
}

function parseApplications(value: string): AffectedApplications {
  const allowed = new Set(["backend", "web", "mobile", "database", "shared-packages"]);
  const values = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (values.length === 0) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "--applications must include at least one application" });
  const seen = new Set<string>();
  for (const application of values) {
    if (!allowed.has(application)) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown application: ${application}` });
    if (seen.has(application)) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `duplicate application: ${application}` });
    seen.add(application);
  }
  return {
    backend: seen.has("backend"),
    web: seen.has("web"),
    mobile: seen.has("mobile"),
    database: seen.has("database"),
    sharedPackages: seen.has("shared-packages"),
  };
}

function parseConfiguredApplications(value: string): Array<"backend" | "web" | "mobile"> {
  const allowed = new Set(["backend", "web", "mobile"]);
  const values = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (values.length === 0) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "--applications must include at least one application" });
  if (new Set(values).size !== values.length) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "--applications contains a duplicate application" });
  for (const value of values) if (!allowed.has(value)) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown configured application: ${value}` });
  return values as Array<"backend" | "web" | "mobile">;
}

function assertPreset<T extends string>(value: string, allowed: readonly T[], target: string): T {
  if (!allowed.includes(value as T)) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown ${target} preset: ${value}` });
  return value as T;
}

function assertTaskStatus(value: string): TaskStatus {
  const statuses: readonly TaskStatus[] = ["pending", "ready", "running", "awaiting_review", "awaiting_approval", "blocked", "failed", "completed", "cancelled"];
  if (!statuses.includes(value as TaskStatus)) {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown task status: ${value}` });
  }
  return value as TaskStatus;
}

function collectOption(value: string, previous: string[]): string[] { return [...previous, value]; }

function assertPublicationActor(value: string): PublicationActor {
  const actors: readonly PublicationActor[] = ["pm", "ba", "backend", "frontend", "qc", "runtime_collector"];
  if (!actors.includes(value as PublicationActor)) {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown authority publication actor: ${value}` });
  }
  return value as PublicationActor;
}

function parseAuthorityVersion(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "--expected-version must be a non-negative safe integer" });
  }
  return Number(value);
}

async function loadAuthorityPublications(
  root: string,
  runId: string,
  actor: PublicationActor,
): Promise<RunAuthorityPublication[]> {
  if (!isPortableRepositoryPath(runId) || runId.includes("/")) {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `invalid run id: ${runId}` });
  }
  const inputSource = await readStandardInput();
  let strictValue: unknown;
  let jsonValue: unknown;
  try {
    strictValue = parseStrictYamlDocument(inputSource);
    jsonValue = JSON.parse(inputSource) as unknown;
  } catch (error) {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `authority publication standard input must be strict JSON: ${messageFrom(error)}` });
  }
  if (JSON.stringify(strictValue) !== JSON.stringify(jsonValue)
    || !isMapping(jsonValue)
    || Object.keys(jsonValue).sort().join(",") !== "publications,schema_version"
    || jsonValue.schema_version !== 1
    || !Array.isArray(jsonValue.publications)
    || jsonValue.publications.length === 0
    || !jsonValue.publications.every((entry) => isMapping(entry)
      && Object.keys(entry).sort().join(",") === "path,source"
      && typeof entry.path === "string"
      && typeof entry.source === "string")) {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "authority publication standard input has an invalid package shape" });
  }
  const writePatterns = await loadRoleWritePatterns(root, actor);
  return jsonValue.publications.map((entry) => {
    const { path, source } = entry as { path: string; source: string };
    if (!isPortableRepositoryPath(path)) throw new SdlcPathError(`authority publication path must use portable repository grammar: ${path}`);
    const pathIdentity = portableRepositoryPathKey(path);
    const livePath = `.sdlc/runs/${runId}/${pathIdentity}`;
    if (pathIdentity === "request.md" || !writePatterns.some((pattern) => matchesPathPattern(pattern, livePath))) {
      throw new SdlcPolicyError(`${actor} may not publish run authority path ${path}`);
    }
    return { path, source };
  });
}

async function readStandardInput(): Promise<string> {
  let source = "";
  for await (const chunk of process.stdin) source += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (source.trim() === "") {
    throw new CliFailure(exitCodes.usage, { code: "USAGE", message: "authority publication requires a strict JSON package on standard input" });
  }
  return source;
}

async function loadRoleWritePatterns(root: string, actor: PublicationActor): Promise<string[]> {
  const policyPath = await resolvePathInsideRoot(root, ".sdlc/policies/permissions.yaml", { mustExist: true });
  const value = parseStrictYamlDocument(await readFile(policyPath, "utf8"));
  if (!isMapping(value) || !isMapping(value.roles) || !isMapping(value.roles[actor])) {
    throw new SdlcPolicyError(`permissions policy is missing role ${actor}`);
  }
  const writePaths = value.roles[actor].write_paths;
  if (!Array.isArray(writePaths) || !writePaths.every((entry) => typeof entry === "string")) {
    throw new SdlcPolicyError(`permissions policy write paths are invalid for role ${actor}`);
  }
  return writePaths;
}

function matchesPathPattern(pattern: string, candidate: string): boolean {
  const expression = pattern.normalize("NFC").toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${expression}$`, "u").test(candidate.normalize("NFC").toLowerCase());
}

function isMapping(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertGateStatus(value: string): "pending" | "running" | "passed" | "failed" | "blocked" {
  const statuses = ["pending", "running", "passed", "failed", "blocked"] as const;
  if (!statuses.includes(value as typeof statuses[number])) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown quality gate status: ${value}` });
  return value as typeof statuses[number];
}

function assertProductOwnerDecision(value: string): "accepted" | "accepted_with_limitations" | "changes_requested" | "rejected" | "deferred" {
  const decisions = ["accepted", "accepted_with_limitations", "changes_requested", "rejected", "deferred"] as const;
  if (!decisions.includes(value as typeof decisions[number])) throw new CliFailure(exitCodes.usage, { code: "USAGE", message: `unknown Product Owner decision: ${value}` });
  return value as typeof decisions[number];
}

function diagnosticsFromError(error: unknown): Diagnostic[] {
  if (error instanceof SdlcValidationError) return error.diagnostics.map((message) => ({ code: "VALIDATION", message }));
  return [{ code: "VALIDATION", message: messageFrom(error) }];
}

function classifyError(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof SdlcPathError) return new CliFailure(exitCodes.unsafe, { code: "UNSAFE_PATH", message: error.message });
  if (error instanceof SdlcPolicyError) return new CliFailure(exitCodes.unsafe, { code: "PROHIBITED", message: error.message });
  if (error instanceof CommanderError) return new CliFailure(exitCodes.usage, { code: "USAGE", message: error.message });
  if (error instanceof SdlcTransitionUsageError) return new CliFailure(exitCodes.usage, { code: "USAGE", message: error.message });
  if (error instanceof SdlcValidationError || error instanceof SdlcTransitionError) {
    return new CliFailure(exitCodes.failure, { code: "VALIDATION", message: messageFrom(error) });
  }
  const message = messageFrom(error);
  return new CliFailure(exitCodes.failure, { code: "FAILED", message });
}

function attemptedCommand(arguments_: readonly string[]): string {
  const candidate = arguments_.find((argument) => !argument.startsWith("-"));
  return candidate ?? "sdlc";
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
