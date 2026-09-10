import { lstat, readFile } from "node:fs/promises";

import {
  isPortableRepositoryPath,
  portablePathContains,
  portableRepositoryPathKey,
  resolvePathInsideRoot,
} from "./paths.js";
import { validateDocument } from "./schemas.js";
import { parseStrictYamlDocument, repositoryPathIdentity } from "./semantic-contracts.js";
import type { DeliveryAssignment, PortableDeliveryPath, RepositoryPath } from "./semantic-contracts.js";
import type { ProjectConfig, RunManifest, Task } from "./types.js";
import { repositoryForApplication, resolveWorkspace, resolveWorkspacePath } from "./workspace.js";

export interface ChangedFileOwnership {
  path: string;
  repository?: string;
  task_id: string;
}

export interface ChangedFilesAuthorityDocument {
  files: PortableDeliveryPath[];
  ownership: ChangedFileOwnership[];
}

interface PermissionsPolicy {
  protectedPaths: string[];
  roleWritePaths: Map<string, string[]>;
  roleWriteLocations: Map<string, Array<{ repository: string; path: string }>>;
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
    || !value.files.every(isPortableDeliveryPath)
    || (value.ownership !== undefined && (!Array.isArray(value.ownership) || !value.ownership.every(isChangedFileOwnership)))) {
    throw new Error("changed-files manifest must contain only portable repository paths and optional closed ownership records");
  }

  const files = value.files as PortableDeliveryPath[];
  assertUniquePortableIdentities(files, "changed-files manifest paths");
  const ownership = (value.ownership ?? []) as ChangedFileOwnership[];
  assertUniquePortableIdentities(ownership.map(ownershipPath), "changed-files manifest ownership paths");
  const filePathKeys = new Set(files.map(repositoryPathIdentity));
  const ownershipByPath = new Map(ownership.map((entry) => [repositoryPathIdentity(ownershipPath(entry)), entry.task_id]));
  const permissions = await readPermissionsPolicy(root);
  const authorityRootsByTask = new Map<string, Promise<PortableDeliveryPath[]>>();

  for (const entry of files) {
    const path = deliveryPath(entry).path;
    const protectedPattern = permissions.protectedPaths.find((pattern) => portableGlobMatches(pattern, path));
    if (protectedPattern !== undefined) {
      throw new Error(`changed-files protected path ${path} matches permissions policy pattern ${protectedPattern}`);
    }
  }

  for (const entry of ownership) {
    const scopedPath = ownershipPath(entry);
    if (!filePathKeys.has(repositoryPathIdentity(scopedPath))) {
      throw new Error(`changed-files ownership path is not exactly listed in files: ${formatDeliveryPath(scopedPath)}`);
    }
    const owner = manifest.tasks.find((candidate) => candidate.id === entry.task_id);
    if (owner === undefined) throw new Error(`changed-files path ${entry.path} names unknown task owner ${entry.task_id}`);
    let authorityRoots = authorityRootsByTask.get(owner.id);
    if (authorityRoots === undefined) {
      authorityRoots = resolveTaskAuthorityRoots(root, manifest.run.id, owner, project, permissions);
      authorityRootsByTask.set(owner.id, authorityRoots);
    }
    if (!(await authorityRoots).some((authorityRoot) => sameRepository(authorityRoot, scopedPath)
      && portablePathContains(deliveryPath(authorityRoot).path, entry.path))) {
      throw new Error(`changed-files path ${entry.path} is owned by ${entry.task_id}, which has no permitted write authority`);
    }
    if (!(await repositoryFileExists(root, project, scopedPath))) throw new Error(`task-owned repository path ${formatDeliveryPath(scopedPath)} does not exist`);
  }

  for (const path of files) {
    if (requiresTaskOwnership(path, project) && !ownershipByPath.has(repositoryPathIdentity(path))) {
      throw new Error(`changed-files manifest requires explicit task ownership for repository path ${formatDeliveryPath(path)}`);
    }
  }

  return { files, ownership };
}

export function changedFilesForTask(
  document: ChangedFilesAuthorityDocument,
  task: Task,
  _project: ProjectConfig,
  taskOutputPaths: readonly string[],
): PortableDeliveryPath[] {
  const ownershipByPath = new Map(document.ownership.map((entry) => [repositoryPathIdentity(ownershipPath(entry)), entry.task_id]));
  return document.files.filter((path) => (typeof path === "string" && taskOutputPaths.includes(path))
    || ownershipByPath.get(repositoryPathIdentity(path)) === task.id);
}

function isChangedFileOwnership(value: unknown): value is ChangedFileOwnership {
  return isRecord(value)
    && ["path,task_id", "path,repository,task_id"].includes(Object.keys(value).sort().join(","))
    && isPortableRepositoryPath(value.path)
    && (value.repository === undefined || (typeof value.repository === "string" && /^[a-z][a-z0-9-]*$/u.test(value.repository)))
    && typeof value.task_id === "string";
}

function applicationRootForPath(path: PortableDeliveryPath, project: ProjectConfig): string | undefined {
  const scoped = deliveryPath(path);
  return (["backend", "web", "mobile"] as const).flatMap((application) => {
    const config = project.applications[application];
    return config === undefined ? [] : [{ root: config.root, repository: repositoryForApplication(project, application) }];
  }).find((candidate) => candidate.repository === scoped.repository && portablePathContains(candidate.root, scoped.path))?.root;
}

function requiresTaskOwnership(path: PortableDeliveryPath, project: ProjectConfig): boolean {
  const scoped = deliveryPath(path);
  const contract = project.resources?.api_contracts;
  return applicationRootForPath(path, project) !== undefined
    || (contract !== undefined && scoped.repository === contract.repository && portablePathContains(contract.root, scoped.path))
    || (contract === undefined && scoped.path === "packages/api-contracts/openapi.yaml")
    || (contract === undefined && portablePathContains("packages/api-contracts/generated", scoped.path));
}

async function resolveTaskAuthorityRoots(
  root: string,
  runId: string,
  task: Task,
  project: ProjectConfig,
  permissions: PermissionsPolicy,
): Promise<PortableDeliveryPath[]> {
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
  const repository = assignment.repository ?? project.workspace?.coordinator ?? "coordinator";
  const policyWritePaths = permissions.roleWritePaths.get(task.role) ?? [];
  const policyLocations = permissions.roleWriteLocations.get(task.role) ?? [];
  return assignment.allowed_write_roots.flatMap((candidate) => {
    const scoped: PortableDeliveryPath = candidate.startsWith(".sdlc/") ? candidate : { repository, path: candidate };
    const permitted = typeof scoped === "string"
      ? policyWritePaths.some((pattern) => portableGlobMatches(pattern, candidate))
      : policyLocations.some((location) => location.repository === scoped.repository && portableGlobMatches(location.path, scoped.path));
    return stageRoots.some((stageRoot) => sameRepository(stageRoot, scoped)
      && samePortableIdentity(deliveryPath(stageRoot).path, deliveryPath(scoped).path)) && permitted ? [scoped] : [];
  });
}

function stageSpecificAuthorityRoots(task: Task, project: ProjectConfig, runId: string): PortableDeliveryPath[] {
  const artifactRoot = task.target === "backend" || task.target === "web" || task.target === "mobile"
    ? `.sdlc/runs/${runId}/artifacts/${task.target}`
    : undefined;
  if (task.role === "backend" && task.target === "backend" && task.stage === "api_contract") {
    if (project.applications.backend === undefined) return [];
    const applicationRepository = repositoryForApplication(project, "backend");
    const contract = project.resources?.api_contracts;
    return [
      { repository: applicationRepository, path: project.applications.backend.root },
      ...(contract === undefined
        ? [{ repository: applicationRepository, path: "packages/api-contracts/openapi.yaml" }, { repository: applicationRepository, path: "packages/api-contracts/generated" }]
        : [{ repository: contract.repository, path: contract.root }]),
      ...(artifactRoot === undefined ? [] : [artifactRoot]),
    ];
  }
  if (task.role === "backend" && task.target === "backend" && task.stage === "backend_implementation") {
    if (project.applications.backend === undefined) return [];
    return [{ repository: repositoryForApplication(project, "backend"), path: project.applications.backend.root }, ...(artifactRoot === undefined ? [] : [artifactRoot])];
  }
  if (task.role === "frontend" && task.target === "web" && task.stage === "web_implementation" && project.applications.web !== undefined) {
    return [{ repository: repositoryForApplication(project, "web"), path: project.applications.web.root }, ...(artifactRoot === undefined ? [] : [artifactRoot])];
  }
  if (task.role === "frontend" && task.target === "mobile" && task.stage === "mobile_implementation" && project.applications.mobile !== undefined) {
    return [{ repository: repositoryForApplication(project, "mobile"), path: project.applications.mobile.root }, ...(artifactRoot === undefined ? [] : [artifactRoot])];
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
  const roleWriteLocations = new Map<string, Array<{ repository: string; path: string }>>();
  for (const [role, rolePolicy] of Object.entries(value.roles)) {
    if (!isRecord(rolePolicy) || !Array.isArray(rolePolicy.write_paths) || !rolePolicy.write_paths.every(isPortableGlobPattern)) {
      throw new Error(`permissions policy write paths are invalid for role ${role}`);
    }
    roleWritePaths.set(role, rolePolicy.write_paths);
    const locations = rolePolicy.write_locations ?? [];
    if (!Array.isArray(locations) || !locations.every(isWriteLocation)) throw new Error(`permissions policy write locations are invalid for role ${role}`);
    roleWriteLocations.set(role, locations);
  }
  return { protectedPaths: value.protected_paths, roleWritePaths, roleWriteLocations };
}

function isWriteLocation(value: unknown): value is { repository: string; path: string } {
  return isRecord(value) && typeof value.repository === "string" && isPortableGlobPattern(value.path);
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

function assertUniquePortableIdentities(paths: readonly PortableDeliveryPath[], label: string): void {
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = repositoryPathIdentity(path);
    if (identities.has(identity)) throw new Error(`${label} contains duplicate portable path identity: ${path}`);
    identities.add(identity);
  }
}

async function repositoryFileExists(root: string, project: ProjectConfig, path: PortableDeliveryPath): Promise<boolean> {
  try {
    const workspace = await resolveWorkspace(root, project);
    const scoped = typeof path === "string" ? { repository: workspace.coordinator, path } : path;
    return (await lstat(await resolveWorkspacePath(workspace, scoped.repository, scoped.path))).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isPortableDeliveryPath(value: unknown): value is PortableDeliveryPath {
  return isPortableRepositoryPath(value)
    || (isRecord(value) && Object.keys(value).sort().join(",") === "path,repository"
      && typeof value.repository === "string" && /^[a-z][a-z0-9-]*$/u.test(value.repository)
      && isPortableRepositoryPath(value.path));
}

function ownershipPath(entry: ChangedFileOwnership): PortableDeliveryPath {
  return entry.repository === undefined ? entry.path : { repository: entry.repository, path: entry.path };
}

function deliveryPath(value: PortableDeliveryPath): RepositoryPath {
  return typeof value === "string" ? { repository: "coordinator", path: value } : value;
}

function sameRepository(left: PortableDeliveryPath, right: PortableDeliveryPath): boolean {
  return deliveryPath(left).repository === deliveryPath(right).repository;
}

function formatDeliveryPath(value: PortableDeliveryPath): string {
  return typeof value === "string" ? value : `${value.repository}:${value.path}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
