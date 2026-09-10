import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { loadLocal } from "./config.js";
import { isPortableRepositoryPath, resolvePathInsideRoot } from "./paths.js";
import { SdlcValidationError, type LocalConfig, type ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const repositoryIdPattern = /^[a-z][a-z0-9-]*$/u;

export interface ResolvedRepository {
  id: string;
  root: string;
  remote: string;
  default_branch: string;
}

export interface ResolvedWorkspace {
  mode: "single-repository" | "multi-repository";
  coordinator: string;
  repositories: Record<string, ResolvedRepository>;
}

export interface DiscoveredRepository {
  root: string;
  remote: string;
  default_branch: string;
}

export function assertRepositoryId(value: string): string {
  if (!repositoryIdPattern.test(value)) throw new Error(`invalid repository ID: ${value}`);
  return value;
}

export function normalizeRemoteIdentity(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "").replace(/\.git$/u, "");
  let host = "";
  let path = "";
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(trimmed);
  if (!trimmed.includes("://") && scp !== null && !/^[A-Za-z]:[\\/]/u.test(trimmed)) {
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else {
    try {
      const url = new URL(trimmed);
      host = url.hostname.toLowerCase();
      path = url.pathname.replace(/^\/+|\/+$/gu, "");
    } catch {
      throw new Error(`repository remote is not a supported SSH or HTTPS URL: ${value}`);
    }
  }
  if (host.startsWith("github.com-")) host = "github.com";
  path = path.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (host === "" || path === "") throw new Error(`repository remote is incomplete: ${value}`);
  const normalizedPath = path.normalize("NFC");
  return `${host}/${host === "github.com" ? normalizedPath.toLowerCase() : normalizedPath}`;
}

export async function discoverRepository(path: string): Promise<DiscoveredRepository> {
  const requested = resolve(path);
  const information = await lstat(requested);
  if (!information.isDirectory()) throw new Error(`repository path is not a directory: ${requested}`);
  const root = await gitOutput(requested, ["rev-parse", "--show-toplevel"], "Git checkout root");
  const [realRequested, realRoot] = await Promise.all([realpath(requested), realpath(root)]);
  if (realRequested !== realRoot) throw new Error(`repository mapping must point at the Git checkout root: ${requested}`);
  const remote = await gitOutput(realRoot, ["config", "--get", "remote.origin.url"], "origin remote");
  normalizeRemoteIdentity(remote);
  let defaultBranch: string;
  try {
    defaultBranch = await gitOutput(realRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], "current branch");
  } catch {
    defaultBranch = "main";
  }
  return { root: realRoot, remote, default_branch: defaultBranch };
}

export async function resolveWorkspace(rootInput: string, project: ProjectConfig, localOverride?: LocalConfig): Promise<ResolvedWorkspace> {
  const root = await realpath(resolve(rootInput));
  if (project.workspace?.mode !== "multi-repository") {
    const coordinator = project.workspace?.coordinator ?? "coordinator";
    return {
      mode: "single-repository",
      coordinator,
      repositories: {
        [coordinator]: {
          id: coordinator,
          root,
          remote: project.repositories?.[coordinator]?.remote ?? "local",
          default_branch: project.repositories?.[coordinator]?.default_branch ?? project.project.default_branch,
        },
      },
    };
  }

  const diagnostics: string[] = [];
  const repositories = project.repositories ?? {};
  const coordinator = project.workspace.coordinator;
  if (!Object.hasOwn(repositories, coordinator)) diagnostics.push(`workspace coordinator repository is not declared: ${coordinator}`);
  let local;
  try {
    local = localOverride ?? await loadLocal(root);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  if (local === undefined) throw new SdlcValidationError(diagnostics);

  for (const id of Object.keys(local.repositories)) {
    if (!Object.hasOwn(repositories, id)) diagnostics.push(`.sdlc/local.yaml maps undeclared repository: ${id}`);
  }

  const resolvedRepositories: Record<string, ResolvedRepository> = {};
  for (const [id, repository] of Object.entries(repositories)) {
    if (!repositoryIdPattern.test(id)) diagnostics.push(`invalid repository ID in project configuration: ${id}`);
    const mapping = local.repositories[id];
    if (mapping === undefined) {
      diagnostics.push(`.sdlc/local.yaml is missing repository mapping: ${id}`);
      continue;
    }
    if (!isAbsolute(mapping)) {
      diagnostics.push(`.sdlc/local.yaml repository ${id} must use an absolute path`);
      continue;
    }
    try {
      const discovered = await discoverRepository(mapping);
      if (normalizeRemoteIdentity(discovered.remote) !== normalizeRemoteIdentity(repository.remote)) {
        diagnostics.push(`repository ${id} remote does not match project.yaml: expected ${repository.remote}, found ${discovered.remote}`);
      }
      resolvedRepositories[id] = { id, root: discovered.root, remote: repository.remote, default_branch: repository.default_branch };
    } catch (error) {
      diagnostics.push(`repository ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const resolvedEntries = Object.values(resolvedRepositories);
  for (let left = 0; left < resolvedEntries.length; left += 1) {
    for (let right = left + 1; right < resolvedEntries.length; right += 1) {
      const a = resolvedEntries[left]!;
      const b = resolvedEntries[right]!;
      if (a.root === b.root) diagnostics.push(`repositories ${a.id} and ${b.id} map to the same checkout`);
      else if (isInside(a.root, b.root) || isInside(b.root, a.root)) diagnostics.push(`nested repository mappings are not supported: ${a.id}, ${b.id}`);
    }
  }
  if (resolvedRepositories[coordinator]?.root !== root) {
    diagnostics.push(`coordinator mapping ${coordinator} must resolve to ${root}`);
  }
  if (diagnostics.length > 0) throw new SdlcValidationError(diagnostics);
  return { mode: "multi-repository", coordinator, repositories: resolvedRepositories };
}

export async function resolveWorkspacePath(
  workspace: ResolvedWorkspace,
  repositoryId: string | undefined,
  path: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const id = repositoryId ?? workspace.coordinator;
  const repository = workspace.repositories[id];
  if (repository === undefined) throw new SdlcValidationError([`unknown repository ID: ${id}`]);
  if (!isPortableRepositoryPath(path)) throw new SdlcValidationError([`invalid repository-relative path for ${id}: ${path}`]);
  return resolvePathInsideRoot(repository.root, path, options);
}

export function repositoryForApplication(project: ProjectConfig, application: "backend" | "web" | "mobile"): string {
  return project.applications[application]?.repository ?? project.workspace?.coordinator ?? "coordinator";
}

async function gitOutput(cwd: string, args: string[], label: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    const output = result.stdout.trim();
    if (output === "") throw new Error(`${label} is empty`);
    return output;
  } catch (error) {
    throw new Error(`unable to read ${label} for ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
