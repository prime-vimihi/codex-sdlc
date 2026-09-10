import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { parseDocument, stringify } from "yaml";

import { FRAMEWORK_NAME, FRAMEWORK_VERSION } from "./constants.js";
import {
  agentsBlock,
  agentsEnd,
  agentsStart,
  assetsRoot,
  frameworkSource,
  launcherSource,
  managedAssetDirectories,
  managedIgnoreEntries,
  mergeIgnore,
  normalizeRuntimeSpec,
  inspectProject,
  permissionsSource,
  toolingPackageSource,
  type ApplicationKind,
  type ApplicationRoots,
  type RepositoryEditRecord,
} from "./install.js";
import { isPortableRepositoryPath, portablePathsOverlap, resolvePathInsideRoot } from "./paths.js";

const managedFilePaths = [
  ".sdlc/framework.yaml",
  ".sdlc/project.yaml",
  ".sdlc/framework.lock.yaml",
  ".sdlc/runtime.cjs",
  ".sdlc/tooling/package.json",
  ...managedAssetDirectories.map((directory) => `.sdlc/${directory}`),
  "AGENTS.md",
  ".gitignore",
] as const;

type LifecycleOperation = "upgrade" | "uninstall";
type SnapshotKind = "absent" | "file" | "directory";

interface SnapshotState {
  kind: SnapshotKind;
  sha256: string | null;
}

interface BackupEntry {
  path: string;
  before: SnapshotState;
  after: SnapshotState | null;
}

interface BackupManifest {
  schema_version: 1;
  product: typeof FRAMEWORK_NAME;
  backup_id: string;
  operation: LifecycleOperation;
  status: "prepared" | "ready" | "rolled_back";
  created_at: string;
  rolled_back_at?: string;
  from_version: string;
  to_version: string | null;
  entries: BackupEntry[];
}

export interface UpgradeProjectOptions {
  root: string;
  runtimeSpec?: string;
  dryRun: boolean;
  now?: string;
}

export interface UninstallProjectOptions {
  root: string;
  dryRun: boolean;
  now?: string;
}

export interface RollbackProjectOptions {
  root: string;
  backupId?: string;
  dryRun: boolean;
  now?: string;
}

export interface LifecycleResult {
  root: string;
  dry_run: boolean;
  operation: "upgrade" | "uninstall" | "rollback";
  backup_id: string;
  from_version: string;
  to_version: string | null;
  files: string[];
  requires_restore: boolean;
}

export async function upgradeProject(options: UpgradeProjectOptions): Promise<LifecycleResult> {
  const root = resolve(options.root);
  await assertDirectory(root);
  const [framework, project, lock, existingAgents, existingIgnore] = await Promise.all([
    readYamlRecord(resolve(root, ".sdlc/framework.yaml")),
    readYamlRecord(resolve(root, ".sdlc/project.yaml")),
    readYamlRecord(resolve(root, ".sdlc/framework.lock.yaml")),
    readOptional(resolve(root, "AGENTS.md")),
    readOptional(resolve(root, ".gitignore")),
  ]);
  const fromVersion = installedVersion(framework);
  const roots = applicationRootsFromProject(project);
  const runtimeSpec = normalizeRuntimeSpec(options.runtimeSpec ?? FRAMEWORK_VERSION);
  const repositoryEdits = upgradedRepositoryEdits(lock, existingAgents, existingIgnore);
  const nextProject = withProjectVersion(project);
  const nextLock = withLockVersion(lock, runtimeSpec, repositoryEdits);
  const nextAgents = replaceManagedBlock(existingAgents, agentsBlock());
  const nextIgnore = mergeIgnore(existingIgnore);
  const timestamp = normalizedTimestamp(options.now);
  const backupId = backupIdentifier(timestamp, "upgrade");
  const files = [...managedFilePaths];

  if (options.dryRun) return lifecycleResult(root, true, "upgrade", backupId, fromVersion, FRAMEWORK_VERSION, files, true);

  const backup = await prepareBackup(root, backupId, "upgrade", fromVersion, FRAMEWORK_VERSION, timestamp);
  try {
    for (const directory of managedAssetDirectories) {
      const destination = resolve(root, ".sdlc", directory);
      await rm(destination, { recursive: true, force: true });
      await cp(resolve(assetsRoot, directory), destination, { recursive: true, errorOnExist: true, force: false });
    }
    await writeAtomic(resolve(root, ".sdlc/framework.yaml"), frameworkSource());
    await writeAtomic(resolve(root, ".sdlc/project.yaml"), stringify(nextProject));
    await writeAtomic(resolve(root, ".sdlc/framework.lock.yaml"), stringify(nextLock));
    await writeAtomic(resolve(root, ".sdlc/runtime.cjs"), launcherSource());
    await writeAtomic(resolve(root, ".sdlc/tooling/package.json"), toolingPackageSource(runtimeSpec));
    await writeAtomic(resolve(root, ".sdlc/policies/permissions.yaml"), permissionsSource(roots));
    await writeAtomic(resolve(root, "AGENTS.md"), nextAgents);
    await writeAtomic(resolve(root, ".gitignore"), nextIgnore);
    await removeRestoredDependencies(root);
    const inspection = await inspectProject(root);
    if (!inspection.valid) throw new Error(`upgraded configuration is invalid: ${inspection.diagnostics.join("; ")}`);
    await finishBackup(root, backup);
  } catch (error) {
    await restoreBeforeState(root, backup);
    await rm(resolve(root, ".sdlc/backups", backupId), { recursive: true, force: true });
    throw error;
  }

  return lifecycleResult(root, false, "upgrade", backupId, fromVersion, FRAMEWORK_VERSION, files, true);
}

export async function uninstallProject(options: UninstallProjectOptions): Promise<LifecycleResult> {
  const root = resolve(options.root);
  await assertDirectory(root);
  const [framework, lock, existingAgents, existingIgnore] = await Promise.all([
    readYamlRecord(resolve(root, ".sdlc/framework.yaml")),
    readYamlRecord(resolve(root, ".sdlc/framework.lock.yaml")),
    readOptional(resolve(root, "AGENTS.md")),
    readOptional(resolve(root, ".gitignore")),
  ]);
  const fromVersion = installedVersion(framework);
  const repositoryEdits = repositoryEditsFromLock(lock);
  const nextAgents = removeManagedBlock(existingAgents);
  const nextIgnore = removeOwnedIgnoreEntries(existingIgnore, repositoryEdits.gitignore_added_entries);
  const timestamp = normalizedTimestamp(options.now);
  const backupId = backupIdentifier(timestamp, "uninstall");
  const files = [...managedFilePaths];

  if (options.dryRun) return lifecycleResult(root, true, "uninstall", backupId, fromVersion, null, files, false);

  const backup = await prepareBackup(root, backupId, "uninstall", fromVersion, null, timestamp);
  try {
    for (const directory of managedAssetDirectories) {
      await rm(resolve(root, ".sdlc", directory), { recursive: true, force: true });
    }
    for (const path of [".sdlc/framework.yaml", ".sdlc/framework.lock.yaml", ".sdlc/runtime.cjs", ".sdlc/tooling"]) {
      await rm(resolve(root, path), { recursive: true, force: true });
    }
    await writeOrRemove(resolve(root, "AGENTS.md"), nextAgents, repositoryEdits.agents_file_created);
    await writeOrRemove(resolve(root, ".gitignore"), nextIgnore, repositoryEdits.gitignore_file_created);
    await finishBackup(root, backup);
  } catch (error) {
    await restoreBeforeState(root, backup);
    await rm(resolve(root, ".sdlc/backups", backupId), { recursive: true, force: true });
    throw error;
  }

  return lifecycleResult(root, false, "uninstall", backupId, fromVersion, null, files, false);
}

export async function rollbackProject(options: RollbackProjectOptions): Promise<LifecycleResult> {
  const root = resolve(options.root);
  await assertDirectory(root);
  const backupId = options.backupId ?? await latestReadyBackup(root);
  assertBackupIdentifier(backupId);
  const manifest = await readBackupManifest(root, backupId);
  if (manifest.status !== "ready") throw new Error(`backup is not available for rollback: ${backupId}`);
  const drift = await afterStateDrift(root, manifest);
  if (drift.length > 0) throw new Error(`rollback would overwrite changes made after ${manifest.operation}: ${drift.join(", ")}`);
  const files = manifest.entries.map((entry) => entry.path);
  if (options.dryRun) {
    return lifecycleResult(root, true, "rollback", backupId, manifest.to_version ?? "uninstalled", manifest.from_version, files, true);
  }

  await restoreBeforeState(root, manifest);
  await removeRestoredDependencies(root);
  manifest.status = "rolled_back";
  manifest.rolled_back_at = normalizedTimestamp(options.now);
  await writeBackupManifest(root, manifest);
  return lifecycleResult(root, false, "rollback", backupId, manifest.to_version ?? "uninstalled", manifest.from_version, files, true);
}

function lifecycleResult(root: string, dryRun: boolean, operation: LifecycleResult["operation"], backupId: string, fromVersion: string, toVersion: string | null, files: string[], requiresRestore: boolean): LifecycleResult {
  return { root, dry_run: dryRun, operation, backup_id: backupId, from_version: fromVersion, to_version: toVersion, files, requires_restore: requiresRestore };
}

async function prepareBackup(root: string, backupId: string, operation: LifecycleOperation, fromVersion: string, toVersion: string | null, createdAt: string): Promise<BackupManifest> {
  const backupRoot = await resolvePathInsideRoot(root, `.sdlc/backups/${backupId}`);
  if (await pathExists(backupRoot)) throw new Error(`backup already exists: ${backupId}`);
  await mkdir(resolve(backupRoot, "before"), { recursive: true });
  const entries: BackupEntry[] = [];
  for (const path of managedFilePaths) {
    const absolute = resolve(root, path);
    const before = await snapshotState(absolute);
    if (before.kind !== "absent") {
      const destination = resolve(backupRoot, "before", path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(absolute, destination, { recursive: before.kind === "directory", errorOnExist: true, force: false });
    }
    entries.push({ path, before, after: null });
  }
  const manifest: BackupManifest = {
    schema_version: 1,
    product: FRAMEWORK_NAME,
    backup_id: backupId,
    operation,
    status: "prepared",
    created_at: createdAt,
    from_version: fromVersion,
    to_version: toVersion,
    entries,
  };
  await writeBackupManifest(root, manifest);
  return manifest;
}

async function finishBackup(root: string, manifest: BackupManifest): Promise<void> {
  for (const entry of manifest.entries) entry.after = await snapshotState(resolve(root, entry.path));
  manifest.status = "ready";
  await writeBackupManifest(root, manifest);
}

async function restoreBeforeState(root: string, manifest: BackupManifest): Promise<void> {
  for (const entry of manifest.entries) {
    const destination = resolve(root, entry.path);
    await rm(destination, { recursive: true, force: true });
    if (entry.before.kind === "absent") continue;
    const source = await resolvePathInsideRoot(root, `.sdlc/backups/${manifest.backup_id}/before/${entry.path}`, { mustExist: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: entry.before.kind === "directory", errorOnExist: true, force: false });
  }
}

async function afterStateDrift(root: string, manifest: BackupManifest): Promise<string[]> {
  const drift: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.after === null || !sameState(entry.after, await snapshotState(resolve(root, entry.path)))) drift.push(entry.path);
  }
  return drift;
}

function sameState(left: SnapshotState, right: SnapshotState): boolean {
  return left.kind === right.kind && left.sha256 === right.sha256;
}

function isSnapshotState(value: unknown): value is SnapshotState {
  if (!isRecord(value) || (value.kind !== "absent" && value.kind !== "file" && value.kind !== "directory")) return false;
  return value.kind === "absent"
    ? value.sha256 === null
    : typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256);
}

async function snapshotState(path: string): Promise<SnapshotState> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return { kind: "absent", sha256: null };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`managed lifecycle path must not be a symbolic link: ${path}`);
  if (stat.isFile()) return { kind: "file", sha256: digest(await readFile(path)) };
  if (!stat.isDirectory()) throw new Error(`managed lifecycle path has an unsupported type: ${path}`);
  return { kind: "directory", sha256: await directoryDigest(path) };
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`managed lifecycle directory must not contain symbolic links: ${absolute}`);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await readFile(absolute));
        hash.update("\0");
      } else {
        throw new Error(`managed lifecycle directory contains an unsupported entry: ${absolute}`);
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeBackupManifest(root: string, manifest: BackupManifest): Promise<void> {
  const path = await resolvePathInsideRoot(root, `.sdlc/backups/${manifest.backup_id}/manifest.json`);
  await writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readBackupManifest(root: string, backupId: string): Promise<BackupManifest> {
  const path = await resolvePathInsideRoot(root, `.sdlc/backups/${backupId}/manifest.json`, { mustExist: true });
  const source = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`invalid codex-sdlc backup manifest: ${backupId}`);
  }
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.product !== FRAMEWORK_NAME
    || value.backup_id !== backupId
    || (value.operation !== "upgrade" && value.operation !== "uninstall")
    || (value.status !== "prepared" && value.status !== "ready" && value.status !== "rolled_back")
    || typeof value.created_at !== "string"
    || typeof value.from_version !== "string"
    || (value.to_version !== null && typeof value.to_version !== "string")
    || !Array.isArray(value.entries)) {
    throw new Error(`invalid codex-sdlc backup manifest: ${backupId}`);
  }
  const expectedPaths = new Set<string>(managedFilePaths);
  const actualPaths = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry)
      || typeof entry.path !== "string"
      || !expectedPaths.has(entry.path)
      || actualPaths.has(entry.path)
      || !isSnapshotState(entry.before)
      || (entry.after !== null && !isSnapshotState(entry.after))) {
      throw new Error(`invalid codex-sdlc backup manifest: ${backupId}`);
    }
    actualPaths.add(entry.path);
  }
  if (actualPaths.size !== expectedPaths.size) throw new Error(`invalid codex-sdlc backup manifest: ${backupId}`);
  return value as unknown as BackupManifest;
}

async function latestReadyBackup(root: string): Promise<string> {
  if (!(await pathExists(resolve(root, ".sdlc/backups")))) throw new Error("no codex-sdlc backups are available");
  const directory = await resolvePathInsideRoot(root, ".sdlc/backups", { mustExist: true });
  let names: string[];
  try {
    names = (await readdir(directory)).sort().reverse();
  } catch (error) {
    if (isMissing(error)) throw new Error("no codex-sdlc backups are available");
    throw error;
  }
  for (const name of names) {
    try {
      const manifest = await readBackupManifest(root, name);
      if (manifest.status === "ready") return name;
    } catch {
      continue;
    }
  }
  throw new Error("no codex-sdlc backups are available");
}

function backupIdentifier(timestamp: string, operation: LifecycleOperation): string {
  return `${timestamp.replace(/[-:.]/gu, "")}-${operation}`;
}

function assertBackupIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value === "." || value === "..") throw new Error(`invalid backup ID: ${value}`);
}

function normalizedTimestamp(value: string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`invalid lifecycle timestamp: ${value}`);
  return date.toISOString();
}

function installedVersion(framework: Record<string, unknown>): string {
  const identity = framework.framework;
  if (!isRecord(identity) || identity.name !== FRAMEWORK_NAME || typeof identity.version !== "string") {
    throw new Error("repository is not an installed codex-sdlc project");
  }
  return identity.version;
}

function applicationRootsFromProject(project: Record<string, unknown>): ApplicationRoots {
  if (!isRecord(project.framework) || project.framework.name !== FRAMEWORK_NAME || !isRecord(project.applications)) {
    throw new Error("invalid codex-sdlc project configuration");
  }
  const roots: ApplicationRoots = {};
  for (const application of ["backend", "web", "mobile"] as const) {
    const config = project.applications[application];
    if (config === undefined) continue;
    if (!isRecord(config) || typeof config.root !== "string" || !isPortableRepositoryPath(config.root)) {
      throw new Error(`invalid ${application} application root in .sdlc/project.yaml`);
    }
    roots[application] = config.root;
  }
  const entries = Object.entries(roots) as Array<[ApplicationKind, string]>;
  if (entries.length === 0) throw new Error("project must configure at least one application");
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (portablePathsOverlap(entries[left]![1], entries[right]![1])) throw new Error("project application roots overlap");
    }
  }
  return roots;
}

function withProjectVersion(project: Record<string, unknown>): Record<string, unknown> {
  return { ...project, framework: { ...(project.framework as Record<string, unknown>), name: FRAMEWORK_NAME, version: FRAMEWORK_VERSION } };
}

function withLockVersion(lock: Record<string, unknown>, runtimeSpec: string, repositoryEdits: RepositoryEditRecord): Record<string, unknown> {
  return {
    ...lock,
    schema_version: 1,
    product: FRAMEWORK_NAME,
    version: FRAMEWORK_VERSION,
    runtime_spec: runtimeSpec,
    schema_family: 1,
    skill_contract_version: 1,
    repository_edits: repositoryEdits,
  };
}

function repositoryEditsFromLock(lock: Record<string, unknown>): RepositoryEditRecord {
  const candidate = lock.repository_edits;
  if (!isRecord(candidate)) return { agents_file_created: false, gitignore_file_created: false, gitignore_added_entries: [] };
  return {
    agents_file_created: candidate.agents_file_created === true,
    gitignore_file_created: candidate.gitignore_file_created === true,
    gitignore_added_entries: Array.isArray(candidate.gitignore_added_entries)
      ? candidate.gitignore_added_entries.filter((entry): entry is string => typeof entry === "string" && managedIgnoreEntries.includes(entry as typeof managedIgnoreEntries[number]))
      : [],
  };
}

function upgradedRepositoryEdits(lock: Record<string, unknown>, agents: string | undefined, ignore: string | undefined): RepositoryEditRecord {
  const previous = repositoryEditsFromLock(lock);
  const ignoreLines = textLines(ignore);
  return {
    agents_file_created: previous.agents_file_created || agents === undefined,
    gitignore_file_created: previous.gitignore_file_created || ignore === undefined,
    gitignore_added_entries: [...new Set([
      ...previous.gitignore_added_entries,
      ...managedIgnoreEntries.filter((entry) => !ignoreLines.includes(entry)),
    ])],
  };
}

function replaceManagedBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(agentsStart);
  const end = existing.indexOf(agentsEnd);
  if (start === -1 && end === -1) return `${existing.replace(/\s*$/u, "")}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start) throw new Error("AGENTS.md contains a malformed codex-sdlc managed block");
  const suffixStart = end + agentsEnd.length;
  return `${existing.slice(0, start)}${block}${existing.slice(suffixStart)}`.replace(/\s*$/u, "\n");
}

function removeManagedBlock(existing: string | undefined): string | undefined {
  if (existing === undefined) return undefined;
  const start = existing.indexOf(agentsStart);
  const end = existing.indexOf(agentsEnd);
  if (start === -1 && end === -1) return existing;
  if (start === -1 || end === -1 || end < start) throw new Error("AGENTS.md contains a malformed codex-sdlc managed block");
  const before = existing.slice(0, start).replace(/\s+$/u, "");
  const after = existing.slice(end + agentsEnd.length).replace(/^\s+/u, "").replace(/\s+$/u, "");
  if (before === "" && after === "") return "";
  if (before === "") return `${after}\n`;
  if (after === "") return `${before}\n`;
  return `${before}\n\n${after}\n`;
}

function removeOwnedIgnoreEntries(existing: string | undefined, ownedEntries: readonly string[]): string | undefined {
  if (existing === undefined) return undefined;
  const owned = new Set(ownedEntries);
  const lines = existing.split(/\r?\n/u).filter((line) => line !== "" && !owned.has(line));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

async function writeOrRemove(path: string, content: string | undefined, removeWhenEmpty: boolean): Promise<void> {
  if (content === undefined || (removeWhenEmpty && content.trim() === "")) {
    await rm(path, { force: true });
    return;
  }
  await writeAtomic(path, content);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.codex-sdlc.tmp`);
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function removeRestoredDependencies(root: string): Promise<void> {
  await Promise.all([
    rm(resolve(root, ".sdlc/tooling/node_modules"), { recursive: true, force: true }),
    rm(resolve(root, ".sdlc/tooling/package-lock.json"), { force: true }),
  ]);
}

async function readYamlRecord(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`required installed file is missing: ${path}`);
    throw error;
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error(`unable to parse installed file ${path}: ${document.errors[0]!.message}`);
  const value = document.toJS() as unknown;
  if (!isRecord(value)) throw new Error(`installed file must contain an object: ${path}`);
  return value;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory()) throw new Error(`repository root is not a directory: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textLines(source: string | undefined): string[] {
  return (source ?? "").split(/\r?\n/u).filter((line) => line !== "");
}
