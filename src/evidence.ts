import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalizeCommandDeclaration, type CanonicalCommandProvenance } from "./command-provenance.js";
import { assertNetworkPolicyAttested, executeCommand } from "./commands.js";
import { loadProject } from "./config.js";
import { createEvidenceId, evidencePathsForId } from "./evidence-identifiers.js";
import { mutateRunManifest } from "./manifest-transaction.js";
import { SdlcPathError, resolvePathInsideRoot } from "./paths.js";
import { SdlcPolicyError } from "./policy.js";
import { configuredSecretValues, redactText } from "./redaction.js";
import { loadRun } from "./runs.js";
import { validateDocument } from "./schemas.js";
import type { EvidenceRecord } from "./types.js";

export async function executeConfiguredCommand(
  root: string,
  runId: string,
  taskId: string,
  commandId: string,
  timing: string | { clock?: () => string } = {},
): Promise<EvidenceRecord> {
  const project = await loadProject(root);
  const secrets = configuredSecretValues(project.security.secret_environment_variables);
  try {
    if (!Object.hasOwn(project.commands, commandId)) {
      throw new SdlcPolicyError(`unknown configured command ID: ${commandId}`);
    }
    const command = project.commands[commandId as keyof typeof project.commands];
    assertNetworkPolicyAttested(command, project.security.network_policy_attestation_environment);
    const canonicalCommand = await canonicalizeCommandDeclaration(root, command, secrets);

    const manifest = await loadRun(root, runId);
    if (!manifest.tasks.some((task) => task.id === taskId)) {
      throw new Error(`task does not exist in run ${runId}: ${taskId}`);
    }
    const runRoot = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}`, { mustExist: true });
    const commandsRelative = `.sdlc/runs/${runId}/evidence/commands`;
    const stagingDirectory = await mkdtemp(join(dirname(runRoot), `${runId}.evidence-staging-`));
    let publishedDirectory: string | undefined;
    try {
      const clock = typeof timing === "string"
        ? legacyClock(timing)
        : timing.clock ?? (() => new Date().toISOString());
      const startedAt = clock();
      const result = await executeCommand(command, canonicalCommand.cwdPath);
      let completedAt = clock();
      if (Date.parse(completedAt) <= Date.parse(startedAt)) completedAt = new Date(Date.parse(startedAt) + 1).toISOString();
      const transaction = await mutateRunManifest(root, runId, async (currentManifest) => {
        const task = currentManifest.tasks.find((candidate) => candidate.id === taskId);
        if (task === undefined) throw new Error(`task does not exist in run ${runId}: ${taskId}`);
        await mkdir(join(runRoot, "evidence", "commands"), { recursive: true });
        const commandsDirectory = await resolvePathInsideRoot(root, commandsRelative, { mustExist: true });
        const published = await publishEvidence({
          runId,
          taskId,
          commandId,
          startedAt,
          completedAt,
          provenance: canonicalCommand.provenance,
          exitCode: result.exitCode,
          stdout: redactText(result.stdout, secrets),
          stderr: redactText(result.stderr, secrets),
          stagingDirectory,
          commandsDirectory,
        });
        publishedDirectory = published.directory;
        task.evidence = [...new Set([...task.evidence, published.record.evidence_path])];
        return published.record;
      });
      return transaction.value;
    } catch (error) {
      if (publishedDirectory !== undefined) {
        await mutateRunManifest(root, runId, async () => rm(publishedDirectory!, { recursive: true, force: true }));
      }
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), secrets);
    if (error instanceof SdlcPathError) throw new SdlcPathError(message);
    if (error instanceof SdlcPolicyError) throw new SdlcPolicyError(message);
    throw new Error(message);
  }
}

interface PublicationInput {
  runId: string;
  taskId: string;
  commandId: string;
  startedAt: string;
  completedAt: string;
  provenance: CanonicalCommandProvenance;
  exitCode: number;
  stdout: string;
  stderr: string;
  stagingDirectory: string;
  commandsDirectory: string;
}

async function publishEvidence(input: PublicationInput): Promise<{ record: EvidenceRecord; directory: string }> {
  const digest = createHash("sha256").update(`${input.runId}\u0000${input.taskId}\u0000${input.commandId}\u0000${input.startedAt}`).digest("hex").slice(0, 16);
  for (let suffix = 1; ; suffix += 1) {
    const id = createEvidenceId(digest, suffix);
    const paths = evidencePathsForId(id);
    const record: EvidenceRecord = {
      schema_version: 1,
      id,
      run_id: input.runId,
      task_id: input.taskId,
      command_id: input.commandId,
      executable: input.provenance.executable,
      args: input.provenance.args,
      cwd: input.provenance.cwd,
      started_at: input.startedAt,
      completed_at: input.completedAt,
      exit_code: input.exitCode,
      result_status: input.exitCode === 0 ? "passed" : "failed",
      evidence_path: paths.evidence,
      stdout_path: paths.stdout,
      stderr_path: paths.stderr,
    };
    await writeStagedEvidence(input);
    const validation = validateDocument("evidence", record);
    if (!validation.valid) throw new Error(`generated evidence is invalid: ${validation.diagnostics.join("; ")}`);
    await writeFile(join(input.stagingDirectory, "evidence.json"), JSON.stringify(record, null, 2), "utf8");
    const destination = join(input.commandsDirectory, id);
    try {
      await mkdir(destination);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      continue;
    }
    try {
      await writeFile(join(destination, ".sdlc-evidence-reservation"), id, { encoding: "utf8", flag: "wx" });
      await rename(join(input.stagingDirectory, "stdout.txt"), join(destination, "stdout.txt"));
      await rename(join(input.stagingDirectory, "stderr.txt"), join(destination, "stderr.txt"));
      await rename(join(input.stagingDirectory, "evidence.json"), join(destination, "evidence.json"));
      await rm(join(destination, ".sdlc-evidence-reservation"), { force: true });
      await rm(input.stagingDirectory, { recursive: true, force: true });
      return { record, directory: destination };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}

function legacyClock(start: string): () => string {
  let calls = 0;
  return () => calls++ === 0 ? start : new Date(Date.parse(start) + 1).toISOString();
}

async function writeStagedEvidence(input: PublicationInput): Promise<void> {
  await writeFile(join(input.stagingDirectory, "stdout.txt"), input.stdout, "utf8");
  await writeFile(join(input.stagingDirectory, "stderr.txt"), input.stderr, "utf8");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
