import { lstat, readFile } from "node:fs/promises";

import {
  isPortableRepositoryPath,
  portablePathContains,
  portableRepositoryPathKey,
  resolvePathInsideRoot,
} from "./paths.js";
import { validateDocument } from "./schemas.js";
import { parseStrictYamlDocument } from "./semantic-contracts.js";
import type { DeliveryAssignment } from "./semantic-contracts.js";
import type { ProjectConfig, RunManifest, Task } from "./types.js";

export interface ChangedFileOwnership {
  path: string;
  task_id: string;
}

export interface ChangedFilesAuthorityDocument {
  files: string[];
  ownership: ChangedFileOwnership[];
}

interface PermissionsPolicy {
  protectedPaths: string[];
  roleWritePaths: Map<string, string[]>;
}

export async function validateChangedFilesAuthorityDocument(
  root: string,
  value: unknown,
  manifest: RunManifest,
  project: ProjectConfig,
): Promise<ChangedFilesAuthorityDocument> {
  if (!isRecord(value)
    || !["files", "files,ownership"].includes(Object.keys(value).sort().join(","))
    || !Array.isArray(value.files)
    || !value.files.every(isPortableRepositoryPath)
    || (value.ownership !== undefined && (!Array.isArray(value.ownership) || !value.ownership.every(isChangedFileOwnership)))) {
    throw new Error("changed-files manifest must contain only portable repository paths and optional closed ownership records");
  }

  const files = value.files as string[];
  assertUniquePortableIdentities(files, "changed-files manifest paths");
  const ownership = (value.ownership ?? []) as ChangedFileOwnership[];
  assertUniquePortableIdentities(ownership.map((entry) => entry.path), "changed-files manifest ownership paths");
  const filePathKeys = new Set(files.map(portableRepositoryPathKey));
  const exactFiles = new Set(files);
  const ownershipByPath = new Map(ownership.map((entry) => [portableRepositoryPathKey(entry.path), entry.task_id]));
  const permissions = await readPermissionsPolicy(root);
  const authorityRootsByTask = new Map<string, Promise<string[]>>();

  for (const path of files) {
    const protectedPattern = permissions.protectedPaths.find((pattern) => portableGlobMatches(pattern, path));
    if (protectedPattern !== undefined) {
      throw new Error(`changed-files protected path ${path} matches permissions policy pattern ${protectedPattern}`);
    }
  }

  for (const entry of ownership) {
    if (!filePathKeys.has(portableRepositoryPathKey(entry.path)) || !exactFiles.has(entry.path)) {
      throw new Error(`changed-files ownership path is not exactly listed in files: ${entry.path}`);
    }
    const owner = manifest.tasks.find((candidate) => candidate.id === entry.task_id);
    if (owner === undefined) throw new Error(`changed-files path ${entry.path} names unknown task owner ${entry.task_id}`);
    let authorityRoots = authorityRootsByTask.get(owner.id);
    if (authorityRoots === undefined) {
      authorityRoots = resolveTaskAuthorityRoots(root, manifest.run.id, owner, project, permissions);
      authorityRootsByTask.set(owner.id, authorityRoots);
    }
    if (!(await authorityRoots).some((authorityRoot) => portablePathContains(authorityRoot, entry.path))) {
      throw new Error(`changed-files path ${entry.path} is owned by ${entry.task_id}, which has no permitted write authority`);
    }
    if (!(await repositoryFileExists(root, entry.path))) throw new Error(`task-owned repository path ${entry.path} does not exist`);
  }

  for (const path of files) {
    if (requiresTaskOwnership(path, project) && !ownershipByPath.has(portableRepositoryPathKey(path))) {
      throw new Error(`changed-files manifest requires explicit task ownership for repository path ${path}`);
    }
  }

  return { files, ownership };
}

export function changedFilesForTask(
  document: ChangedFilesAuthorityDocument,
  task: Task,
  _project: ProjectConfig,
  taskOutputPaths: readonly string[],
): string[] {
  const ownershipByPath = new Map(document.ownership.map((entry) => [portableRepositoryPathKey(entry.path), entry.task_id]));
  return document.files.filter((path) => taskOutputPaths.includes(path)
    || ownershipByPath.get(portableRepositoryPathKey(path)) === task.id);
}

function isChangedFileOwnership(value: unknown): value is ChangedFileOwnership {
  return isRecord(value)
    && Object.keys(value).sort().join(",") === "path,task_id"
    && isPortableRepositoryPath(value.path)
    && typeof value.task_id === "string";
}

function applicationRootForPath(path: string, project: ProjectConfig): string | undefined {
  return [project.applications.backend?.root, project.applications.web?.root, project.applications.mobile?.root]
    .find((root): root is string => root !== undefined && portablePathContains(root, path));
}

function requiresTaskOwnership(path: string, project: ProjectConfig): boolean {
  return applicationRootForPath(path, project) !== undefined
    || path === "packages/api-contracts/openapi.yaml"
    || portablePathContains("packages/api-contracts/generated", path);
}

async function resolveTaskAuthorityRoots(
  root: string,
  runId: string,
  task: Task,
  project: ProjectConfig,
  permissions: PermissionsPolicy,
): Promise<string[]> {
  const assignmentPath = `.sdlc/runs/${runId}/tasks/${task.id}.assignment.yaml`;
  const source = await readFile(await resolvePathInsideRoot(root, assignmentPath, { mustExist: true }), "utf8");
  const value = parseStrictYamlDocument(source);
  const validation = validateDocument("deliveryAssignment", value);
  if (!validation.valid) throw new Error(`changed-files owner ${task.id} assignment is invalid: ${validation.diagnostics.join("; ")}`);
  const assignment = value as DeliveryAssignment;
  if (assignment.run_id !== runId
    || assignment.task_id !== task.id
    || assignment.role !== task.role
    || assignment.target !== task.target
    || assignment.stage !== task.stage) {
    throw new Error(`changed-files owner ${task.id} assignment identity does not match the run task`);
  }

  const stageRoots = stageSpecificAuthorityRoots(task, project, runId);
  const policyWritePaths = permissions.roleWritePaths.get(task.role) ?? [];
  return assignment.allowed_write_roots.filter((candidate) => stageRoots.some((stageRoot) => samePortableIdentity(stageRoot, candidate))
    && policyWritePaths.some((pattern) => portableGlobMatches(pattern, candidate)));
}

function stageSpecificAuthorityRoots(task: Task, project: ProjectConfig, runId: string): string[] {
  const artifactRoot = task.target === "backend" || task.target === "web" || task.target === "mobile"
    ? `.sdlc/runs/${runId}/artifacts/${task.target}`
    : undefined;
  if (task.role === "backend" && task.target === "backend" && task.stage === "api_contract") {
    if (project.applications.backend === undefined) return [];
    return [
      project.applications.backend.root,
      "packages/api-contracts/openapi.yaml",
      "packages/api-contracts/generated",
      ...(artifactRoot === undefined ? [] : [artifactRoot]),
    ];
  }
  if (task.role === "backend" && task.target === "backend" && task.stage === "backend_implementation") {
    if (project.applications.backend === undefined) return [];
    return [project.applications.backend.root, ...(artifactRoot === undefined ? [] : [artifactRoot])];
  }
  if (task.role === "frontend" && task.target === "web" && task.stage === "web_implementation" && project.applications.web !== undefined) {
    return [project.applications.web.root, ...(artifactRoot === undefined ? [] : [artifactRoot])];
  }
  if (task.role === "frontend" && task.target === "mobile" && task.stage === "mobile_implementation" && project.applications.mobile !== undefined) {
    return [project.applications.mobile.root, ...(artifactRoot === undefined ? [] : [artifactRoot])];
  }
  return [];
}

async function readPermissionsPolicy(root: string): Promise<PermissionsPolicy> {
  const source = await readFile(await resolvePathInsideRoot(root, ".sdlc/policies/permissions.yaml", { mustExist: true }), "utf8");
  const value = parseStrictYamlDocument(source);
  if (!isRecord(value) || !Array.isArray(value.protected_paths) || !value.protected_paths.every(isPortableGlobPattern)
    || !isRecord(value.roles)) {
    throw new Error("permissions policy must declare portable protected_paths and role write_paths");
  }
  const roleWritePaths = new Map<string, string[]>();
  for (const [role, rolePolicy] of Object.entries(value.roles)) {
    if (!isRecord(rolePolicy) || !Array.isArray(rolePolicy.write_paths) || !rolePolicy.write_paths.every(isPortableGlobPattern)) {
      throw new Error(`permissions policy write paths are invalid for role ${role}`);
    }
    roleWritePaths.set(role, rolePolicy.write_paths);
  }
  return { protectedPaths: value.protected_paths, roleWritePaths };
}

function isPortableGlobPattern(value: unknown): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value !== value.normalize("NFC")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment.length > 0
    && segment !== "."
    && segment !== ".."
    && /^(?:\*\*|[A-Za-z0-9._-]*\*?[A-Za-z0-9._-]*)$/u.test(segment));
}

function portableGlobMatches(pattern: string, path: string): boolean {
  if (!isPortableGlobPattern(pattern)) throw new Error(`invalid portable permission path pattern: ${pattern}`);
  const identity = portableRepositoryPathKey(path);
  let expression = "^";
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      expression += "(?:[^/]+/)*";
      index += 3;
    } else if (pattern.startsWith("/**", index) && index + 3 === pattern.length) {
      expression += "(?:/.*)?";
      index += 3;
    } else if (pattern[index] === "*") {
      expression += "[^/]*";
      index += 1;
    } else {
      expression += escapeRegularExpression(pattern[index]!.toLowerCase());
      index += 1;
    }
  }
  return new RegExp(`${expression}$`, "u").test(identity);
}

function samePortableIdentity(left: string, right: string): boolean {
  return portableRepositoryPathKey(left) === portableRepositoryPathKey(right);
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function assertUniquePortableIdentities(paths: readonly string[], label: string): void {
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = portableRepositoryPathKey(path);
    if (identities.has(identity)) throw new Error(`${label} contains duplicate portable path identity: ${path}`);
    identities.add(identity);
  }
}

async function repositoryFileExists(root: string, path: string): Promise<boolean> {
  try {
    return (await lstat(await resolvePathInsideRoot(root, path))).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
