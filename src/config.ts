import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { parseDocument } from "yaml";

import { FRAMEWORK_NAME, FRAMEWORK_VERSION, SCHEMA_VERSION } from "./constants.js";
import { isPortableRepositoryPath, portablePathsOverlap } from "./paths.js";
import { validateDocument, type SchemaName } from "./schemas.js";
import {
  SdlcValidationError,
  type FrameworkConfig,
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
    collectPlaceholderDiagnostics(value, "$", diagnostics);
    if (schemaName !== "workflow") diagnostics.push(...canonicalIdentityDiagnostics(value));
    if (schemaName === "project") {
      diagnostics.push(...unsafeCommandDiagnostics(value));
      diagnostics.push(...applicationRootDiagnostics(value));
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
  const roots: Array<{ application: string; root: string }> = [];
  const diagnostics: string[] = [];
  for (const application of ["backend", "web", "mobile"] as const) {
    const candidate = (value.applications as Record<string, unknown>)[application];
    if (candidate === null || typeof candidate !== "object" || !("root" in candidate) || typeof candidate.root !== "string") continue;
    if (!isPortableRepositoryPath(candidate.root)) {
      diagnostics.push(`$.applications.${application}.root must be a canonical repository-relative application root`);
      continue;
    }
    roots.push({ application, root: candidate.root });
  }
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (portablePathsOverlap(roots[left]!.root, roots[right]!.root)) {
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
    if (candidate === null || typeof candidate !== "object" || !("executable" in candidate) || typeof candidate.executable !== "string") continue;
    const basename = candidate.executable.trim().replaceAll("\\", "/").split("/").at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
    if (prohibitedShells.has(basename)) diagnostics.push(`$.commands.${id}.executable uses prohibited shell wrapper ${candidate.executable}`);
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

function canonicalIdentityDiagnostics(value: unknown): string[] {
  const config = value as { schema_version?: unknown; framework?: { name?: unknown; version?: unknown } };
  const diagnostics: string[] = [];

  if (config.schema_version !== SCHEMA_VERSION) {
    diagnostics.push(`schema_version must equal ${SCHEMA_VERSION}`);
  }
  if (config.framework?.name !== FRAMEWORK_NAME) {
    diagnostics.push(`framework.name must equal ${FRAMEWORK_NAME}`);
  }
  if (config.framework?.version !== FRAMEWORK_VERSION) {
    diagnostics.push(`framework.version must equal ${FRAMEWORK_VERSION}`);
  }

  return diagnostics;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
