import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { parseDocument } from "yaml";

import { FRAMEWORK_NAME, FRAMEWORK_VERSION, PROJECT_SCHEMA_VERSION, SCHEMA_VERSION } from "./constants.js";
import { isPortableRepositoryPath, portablePathsOverlap } from "./paths.js";
import { validateDocument, type SchemaName } from "./schemas.js";
import {
  SdlcValidationError,
  type FrameworkConfig,
  type LocalConfig,
  type ProjectConfig,
  type WorkflowConfig,
} from "./types.js";

const placeholderPattern = /replace-with|\bTBD\b|\bTODO\b/i;

export async function loadFramework(root: string): Promise<FrameworkConfig> {
  return loadConfiguration<FrameworkConfig>(root, ".sdlc/framework.yaml", "framework");
}

export async function loadProject(root: string): Promise<ProjectConfig> {
  return loadConfiguration<ProjectConfig>(root, ".sdlc/project.yaml", "project");
}

export async function loadLocal(root: string): Promise<LocalConfig> {
  return loadConfiguration<LocalConfig>(root, ".sdlc/local.yaml", "local");
}

export async function loadWorkflow(root: string): Promise<WorkflowConfig> {
  return loadConfiguration<WorkflowConfig>(root, ".sdlc/workflows/feature-development.yaml", "workflow");
}

async function loadConfiguration<T>(root: string, relativePath: string, schemaName: SchemaName): Promise<T> {
  const filePath = resolveInsideRoot(root, relativePath);
  const diagnostics: string[] = [];
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new SdlcValidationError([`unable to read configuration ${relativePath}: ${errorMessage(error)}`]);
  }

  let value: unknown;
  try {
    const document = parseDocument(source);
    diagnostics.push(...document.errors.map((error) => error.message));
    value = document.toJS() as unknown;
  } catch (error) {
    throw new SdlcValidationError([`unable to parse configuration ${relativePath}: ${errorMessage(error)}`]);
  }

  if (value === null || value === undefined) {
    diagnostics.push("/ configuration must not be empty");
  } else {
    const schemaValidation = validateDocument(schemaName, value);
    diagnostics.push(...schemaValidation.diagnostics);
    if (schemaName !== "local") collectPlaceholderDiagnostics(value, "$", diagnostics);
    if (schemaName !== "workflow" && schemaName !== "local") diagnostics.push(...canonicalIdentityDiagnostics(value, schemaName));
    if (schemaName === "project") {
      diagnostics.push(...unsafeCommandDiagnostics(value));
      diagnostics.push(...applicationRootDiagnostics(value));
      diagnostics.push(...workspaceDiagnostics(value));
    }
  }

  if (diagnostics.length > 0) {
    throw new SdlcValidationError(diagnostics);
  }

  return value as T;
}

const prohibitedShells = new Set(["powershell", "pwsh", "cmd", "sh", "bash", "zsh", "ksh", "csh", "fish", "wsl"]);

function applicationRootDiagnostics(value: unknown): string[] {
  if (value === null || typeof value !== "object" || !("applications" in value)
    || value.applications === null || typeof value.applications !== "object") return [];
  const roots: Array<{ application: string; repository: string; root: string }> = [];
  const diagnostics: string[] = [];
  for (const application of ["backend", "web", "mobile"] as const) {
    const candidate = (value.applications as Record<string, unknown>)[application];
    if (candidate === null || typeof candidate !== "object" || !("root" in candidate) || typeof candidate.root !== "string") continue;
    if (!isPortableRepositoryPath(candidate.root)) {
      diagnostics.push(`$.applications.${application}.root must be a canonical repository-relative application root`);
      continue;
    }
    const repository = "repository" in candidate && typeof candidate.repository === "string" ? candidate.repository : "coordinator";
    roots.push({ application, repository, root: candidate.root });
  }
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (roots[left]!.repository === roots[right]!.repository && portablePathsOverlap(roots[left]!.root, roots[right]!.root)) {
        diagnostics.push(`application roots overlap: ${roots[left]!.application}=${roots[left]!.root} and ${roots[right]!.application}=${roots[right]!.root}`);
      }
    }
  }
  return diagnostics;
}

function unsafeCommandDiagnostics(value: unknown): string[] {
  if (value === null || typeof value !== "object" || !("commands" in value) || value.commands === null || typeof value.commands !== "object") return [];
  const diagnostics: string[] = [];
  for (const [id, candidate] of Object.entries(value.commands)) {
    if (candidate === null || typeof candidate !== "object") continue;
    const declarations = [candidate, ...("steps" in candidate && Array.isArray(candidate.steps) ? candidate.steps : [])];
    for (const [index, declaration] of declarations.entries()) {
      if (declaration === null || typeof declaration !== "object" || !("executable" in declaration) || typeof declaration.executable !== "string") continue;
      const basename = declaration.executable.trim().replaceAll("\\", "/").split("/").at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
      if (prohibitedShells.has(basename)) diagnostics.push(`$.commands.${id}${index === 0 ? "" : `.steps[${index - 1}]`}.executable uses prohibited shell wrapper ${declaration.executable}`);
    }
  }
  return diagnostics;
}

function resolveInsideRoot(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const resolvedPath = resolve(absoluteRoot, relativePath);
  const pathFromRoot = relative(absoluteRoot, resolvedPath);

  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith("..\\") || pathFromRoot.startsWith("../")) {
    throw new SdlcValidationError([`path escapes repository root: ${relativePath}`]);
  }

  return resolvedPath;
}

function collectPlaceholderDiagnostics(value: unknown, path: string, diagnostics: string[]): void {
  if (typeof value === "string") {
    if (placeholderPattern.test(value)) {
      diagnostics.push(`${path} contains unresolved placeholder`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectPlaceholderDiagnostics(entry, `${path}[${index}]`, diagnostics));
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectPlaceholderDiagnostics(entry, `${path}.${key}`, diagnostics);
    }
  }
}

function canonicalIdentityDiagnostics(value: unknown, schemaName: SchemaName): string[] {
  const config = value as { schema_version?: unknown; framework?: { name?: unknown; version?: unknown } };
  const diagnostics: string[] = [];

  const supportedSchemaVersions = schemaName === "project" ? [SCHEMA_VERSION, PROJECT_SCHEMA_VERSION] : [SCHEMA_VERSION];
  if (!supportedSchemaVersions.includes(config.schema_version as 1 | 2)) {
    diagnostics.push(`schema_version must equal ${supportedSchemaVersions.join(" or ")}`);
  }
  if (config.framework?.name !== FRAMEWORK_NAME) {
    diagnostics.push(`framework.name must equal ${FRAMEWORK_NAME}`);
  }
  if (config.framework?.version !== FRAMEWORK_VERSION) {
    diagnostics.push(`framework.version must equal ${FRAMEWORK_VERSION}`);
  }

  return diagnostics;
}

function workspaceDiagnostics(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const project = value as ProjectConfig;
  if (project.workspace?.mode !== "multi-repository") return [];
  const diagnostics: string[] = [];
  if (project.schema_version !== PROJECT_SCHEMA_VERSION) diagnostics.push(`multi-repository projects require schema_version ${PROJECT_SCHEMA_VERSION}`);
  const repositories = project.repositories ?? {};
  if (!Object.hasOwn(repositories, project.workspace.coordinator)) diagnostics.push("workspace.coordinator must name a declared repository");
  for (const application of ["backend", "web", "mobile"] as const) {
    const candidate = project.applications[application];
    if (candidate === undefined) continue;
    if (candidate.repository === undefined) diagnostics.push(`$.applications.${application}.repository is required for multi-repository projects`);
    else if (!Object.hasOwn(repositories, candidate.repository)) diagnostics.push(`$.applications.${application}.repository is not declared: ${candidate.repository}`);
  }
  for (const [id, command] of Object.entries(project.commands)) {
    const declarations = command.steps ?? [command];
    for (const [index, declaration] of declarations.entries()) {
      const repository = declaration.repository ?? command.repository;
      if (repository === undefined) diagnostics.push(`$.commands.${id}${command.steps === undefined ? "" : `.steps[${index}]`}.repository is required for multi-repository projects`);
      else if (!Object.hasOwn(repositories, repository)) diagnostics.push(`$.commands.${id} references undeclared repository ${repository}`);
    }
  }
  for (const [name, location] of Object.entries(project.resources ?? {})) {
    if (location === undefined) continue;
    if (!Object.hasOwn(repositories, location.repository)) diagnostics.push(`$.resources.${name}.repository is not declared: ${location.repository}`);
    if (!isPortableRepositoryPath(location.root)) diagnostics.push(`$.resources.${name}.root must be a canonical repository-relative root`);
  }
  return diagnostics;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
