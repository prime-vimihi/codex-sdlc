import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { FRAMEWORK_NAME, FRAMEWORK_VERSION } from "./constants.js";
import { loadFramework, loadProject, loadWorkflow } from "./config.js";
import { isPortableRepositoryPath, portablePathsOverlap } from "./paths.js";

export const assetsRoot = fileURLToPath(new URL("../assets/", import.meta.url));
export const agentsStart = "<!-- codex-sdlc:start -->";
export const agentsEnd = "<!-- codex-sdlc:end -->";
export const managedAssetDirectories = ["schemas", "templates", "workflows", "policies", "presets"] as const;
export const managedIgnoreEntries = [".sdlc/tooling/node_modules/", ".sdlc/*.lock", ".sdlc/*.tmp"] as const;

export interface RepositoryEditRecord {
  agents_file_created: boolean;
  gitignore_file_created: boolean;
  gitignore_added_entries: string[];
}

export interface InitializeProjectOptions {
  root: string;
  projectName: string;
  applications?: Array<"backend" | "web" | "mobile">;
  backendRoot?: string;
  webRoot?: string;
  mobileRoot?: string;
  backendPreset?: "generic" | "go";
  webPreset?: "generic" | "nextjs";
  mobilePreset?: "generic" | "flutter";
  databasePreset?: "none" | "postgresql";
  redis?: boolean;
  dryRun: boolean;
  runtimeSpec?: string;
}

export interface InitializeProjectResult {
  root: string;
  dry_run: boolean;
  files: string[];
}

export interface ProjectInspection {
  root: string;
  valid: boolean;
  ready: boolean;
  framework_version: string | null;
  diagnostics: string[];
}

export async function initializeProject(options: InitializeProjectOptions): Promise<InitializeProjectResult> {
  const root = resolve(options.root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`repository root is not a directory: ${root}`);
  if (options.projectName.trim() === "") throw new Error("project name must not be empty");
  const applications = normalizeApplications(options.applications ?? ["backend"]);
  const roots = applicationRoots(applications, options);
  assertApplicationRootsDoNotOverlap(roots);
  const presets = normalizePresets(applications, options);
  const runtimeSpec = normalizeRuntimeSpec(options.runtimeSpec ?? FRAMEWORK_VERSION);
  const agentsPath = resolve(root, "AGENTS.md");
  const ignorePath = resolve(root, ".gitignore");
  const [existingAgents, existingIgnore, existingLock] = await Promise.all([
    readOptional(agentsPath),
    readOptional(ignorePath),
    readOptional(resolve(root, ".sdlc/framework.lock.yaml")),
  ]);
  const previousRepositoryEdits = parseRepositoryEdits(existingLock);
  const repositoryEdits: RepositoryEditRecord = {
    agents_file_created: previousRepositoryEdits?.agents_file_created ?? existingAgents === undefined,
    gitignore_file_created: previousRepositoryEdits?.gitignore_file_created ?? existingIgnore === undefined,
    gitignore_added_entries: previousRepositoryEdits?.gitignore_added_entries
      ?? managedIgnoreEntries.filter((entry) => !textLines(existingIgnore).includes(entry)),
  };
  for (const [application, applicationRoot] of Object.entries(roots)) {
    const applicationPath = resolve(root, applicationRoot);
    const fromRoot = relative(root, applicationPath);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\")) {
      throw new Error(`${application} root escapes repository: ${applicationRoot}`);
    }
    const applicationStat = await lstat(applicationPath);
    if (!applicationStat.isDirectory()) throw new Error(`${application} root is not a directory: ${applicationRoot}`);
  }

  const files = [
    ".sdlc/framework.yaml",
    ".sdlc/project.yaml",
    ".sdlc/framework.lock.yaml",
    ".sdlc/runtime.cjs",
    ".sdlc/tooling/package.json",
    ".sdlc/policies/permissions.yaml",
    "AGENTS.md",
    ".gitignore",
  ];
  const content = new Map<string, string>([
    [".sdlc/framework.yaml", frameworkSource()],
    [".sdlc/project.yaml", projectSource(options.projectName.trim(), roots, presets, options.databasePreset ?? "none", options.redis ?? false)],
    [".sdlc/framework.lock.yaml", lockSource(runtimeSpec, presets, options.databasePreset ?? "none", options.redis ?? false, repositoryEdits)],
    [".sdlc/runtime.cjs", launcherSource()],
    [".sdlc/tooling/package.json", toolingPackageSource(runtimeSpec)],
    [".sdlc/policies/permissions.yaml", permissionsSource(roots)],
  ]);

  content.set("AGENTS.md", mergeManagedBlock(existingAgents, agentsBlock()));
  content.set(".gitignore", mergeIgnore(existingIgnore));
  await assertNoConflicts(root, content);

  if (!options.dryRun) {
    for (const directory of managedAssetDirectories) {
      const destination = resolve(root, ".sdlc", directory);
      if (!(await pathExists(destination))) {
        await cp(resolve(assetsRoot, directory), destination, { recursive: true, errorOnExist: true, force: false });
      }
    }
    for (const [path, source] of content) {
      const destination = resolve(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source, "utf8");
    }
    await mkdir(resolve(root, ".sdlc/runs"), { recursive: true });
    await mkdir(resolve(root, ".sdlc/requests"), { recursive: true });
    const inspection = await inspectProject(root);
    if (!inspection.valid) throw new Error(`installed configuration is invalid: ${inspection.diagnostics.join("; ")}`);
  }
  return { root, dry_run: options.dryRun, files: [...files, ".sdlc/schemas/**", ".sdlc/templates/**", ".sdlc/workflows/**", ".sdlc/policies/**", ".sdlc/presets/**"] };
}

export async function inspectProject(rootInput: string): Promise<ProjectInspection> {
  const root = resolve(rootInput);
  const settled = await Promise.allSettled([loadFramework(root), loadProject(root), loadWorkflow(root)]);
  const diagnostics = settled.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
    : []);
  const framework = settled[0];
  const project = settled[1];
  const warnings = project.status === "fulfilled" ? unconfiguredCommandDiagnostics(project.value) : [];
  return {
    root,
    valid: diagnostics.length === 0,
    ready: diagnostics.length === 0 && warnings.length === 0,
    framework_version: framework.status === "fulfilled" ? framework.value.framework.version : null,
    diagnostics: [...diagnostics, ...warnings],
  };
}

function unconfiguredCommandDiagnostics(project: Awaited<ReturnType<typeof loadProject>>): string[] {
  const diagnostics: string[] = [];
  for (const id of ["sdlc_test", "sdlc_typecheck"] as const) {
    if (project.commands[id].args.some((argument) => argument.includes(`Configure commands.${id}`))) {
      diagnostics.push(`commands.${id} is unconfigured in .sdlc/project.yaml`);
    }
  }
  return diagnostics;
}

export type ApplicationKind = "backend" | "web" | "mobile";
export type ApplicationRoots = Partial<Record<ApplicationKind, string>>;
type ApplicationPresets = Partial<Record<ApplicationKind, "generic" | "go" | "nextjs" | "flutter">>;

function normalizeApplications(values: ApplicationKind[]): ApplicationKind[] {
  const unique = [...new Set(values)];
  if (unique.length === 0) throw new Error("at least one application is required");
  return unique;
}

function applicationRoots(applications: ApplicationKind[], options: InitializeProjectOptions): ApplicationRoots {
  const configured = { backend: options.backendRoot, web: options.webRoot, mobile: options.mobileRoot };
  const roots: ApplicationRoots = {};
  for (const application of applications) {
    roots[application] = normalizeRoot(configured[application] ?? (applications.length === 1 ? "." : application));
  }
  return roots;
}

function assertApplicationRootsDoNotOverlap(roots: ApplicationRoots): void {
  const entries = Object.entries(roots) as Array<[ApplicationKind, string]>;
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftApplication, leftRoot] = entries[leftIndex]!;
      const [rightApplication, rightRoot] = entries[rightIndex]!;
      if (portablePathsOverlap(leftRoot, rightRoot)) {
        throw new Error(`${leftApplication} root ${leftRoot} overlaps ${rightApplication} root ${rightRoot}`);
      }
    }
  }
}

function normalizePresets(applications: ApplicationKind[], options: InitializeProjectOptions): ApplicationPresets {
  const requested = {
    backend: options.backendPreset ?? "generic",
    web: options.webPreset ?? "generic",
    mobile: options.mobilePreset ?? "generic",
  } as const;
  if (requested.backend !== "generic" && !applications.includes("backend")) throw new Error("backend preset requires the backend application");
  if (requested.web !== "generic" && !applications.includes("web")) throw new Error("web preset requires the web application");
  if (requested.mobile !== "generic" && !applications.includes("mobile")) throw new Error("mobile preset requires the mobile application");
  return Object.fromEntries(applications.map((application) => [application, requested[application]])) as ApplicationPresets;
}

function normalizeRoot(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
  if (normalized !== "." && !isPortableRepositoryPath(normalized)) throw new Error(`application root is not a portable repository path: ${value}`);
  return normalized;
}

export function frameworkSource(): string {
  return stringify({
    schema_version: 1,
    framework: { name: FRAMEWORK_NAME, version: FRAMEWORK_VERSION, run_schema_version: 1, project_schema_version: 1 },
    installation: {
      mode: "repository",
      managed_paths: [".sdlc/schemas", ".sdlc/templates", ".sdlc/workflows", ".sdlc/policies", ".sdlc/presets", ".sdlc/runtime.cjs", ".sdlc/tooling"],
      repository_specific_paths: ["AGENTS.md", ".sdlc/project.yaml", ".sdlc/framework.lock.yaml", ".sdlc/runs", ".sdlc/requests", ".sdlc/backups"],
    },
  });
}

function projectSource(name: string, roots: ApplicationRoots, presets: ApplicationPresets, databasePreset: "none" | "postgresql", redis: boolean): string {
  const validation = { executable: "node", args: [".sdlc/runtime.cjs", "validate-config"], cwd: ".", network: "disabled", mutates: false };
  const unconfigured = (command: string) => ({
    executable: "node",
    args: ["-e", `console.error(${JSON.stringify(`Configure commands.${command} in .sdlc/project.yaml before collecting evidence`)});process.exit(2)`],
    cwd: ".",
    network: "disabled",
    mutates: false,
  });
  const applications = Object.fromEntries((Object.keys(roots) as ApplicationKind[]).map((application) => {
    const preset = presets[application] ?? "generic";
    const identity = presetIdentity(application, preset);
    return [application, { lifecycle: "active", root: roots[application], ...identity }];
  }));
  const presetCommands = commandsForPresets(roots, presets);
  const testCommands = aggregateChecks(roots, presets, "test");
  const typecheckCommands = aggregateChecks(roots, presets, "typecheck");
  const projectType = Object.keys(applications).length > 1 ? "multi-application"
    : roots.web !== undefined ? "web-application"
      : roots.mobile !== undefined ? "mobile-application" : "backend-service";
  return stringify({
    schema_version: 1,
    framework: { name: FRAMEWORK_NAME, version: FRAMEWORK_VERSION },
    project: { name, type: projectType, default_branch: "main", repository_structure: "repository" },
    applications,
    data: {
      primary_database: databasePreset,
      redis: { enabled: redis, roles: redis ? ["cache"] : [] },
      media: { object_storage: "none", cdn: false },
      future_capabilities: {},
    },
    security: { secret_environment_variables: [], network_policy_attestation_environment: "CODEX_SDLC_NETWORK_POLICY" },
    commands: {
      sdlc_test: testCommands === undefined ? unconfigured("sdlc_test") : aggregateCommand(testCommands),
      sdlc_typecheck: typecheckCommands === undefined ? unconfigured("sdlc_typecheck") : aggregateCommand(typecheckCommands),
      sdlc_validate: validation,
      ...presetCommands,
    },
  });
}

interface NativeCheck {
  executable: string;
  args: string[];
  cwd: string;
}

function presetIdentity(application: ApplicationKind, preset: NonNullable<ApplicationPresets[ApplicationKind]>): { framework: string; language: string } {
  if (application === "backend" && preset === "go") return { framework: "go", language: "go" };
  if (application === "web" && preset === "nextjs") return { framework: "nextjs", language: "typescript" };
  if (application === "mobile" && preset === "flutter") return { framework: "flutter", language: "dart" };
  return { framework: "generic", language: "generic" };
}

function checksForPreset(application: ApplicationKind, preset: NonNullable<ApplicationPresets[ApplicationKind]>, root: string): { test: NativeCheck; typecheck: NativeCheck; commands: Record<string, ReturnType<typeof commandDefinition>> } | undefined {
  if (application === "backend" && preset === "go") {
    const test = { executable: "go", args: ["test", "./..."], cwd: root };
    const typecheck = { executable: "go", args: ["vet", "./..."], cwd: root };
    return { test, typecheck, commands: {
      backend_format: commandDefinition("gofmt", ["-w", "."], root, true),
      backend_lint: commandDefinition("go", ["vet", "./..."], root),
      backend_test: commandDefinition("go", ["test", "./..."], root),
      backend_build: commandDefinition("go", ["build", "./..."], root),
    } };
  }
  if (application === "web" && preset === "nextjs") {
    const test = { executable: "npm", args: ["test"], cwd: root };
    const typecheck = { executable: "npm", args: ["run", "typecheck"], cwd: root };
    return { test, typecheck, commands: {
      web_lint: commandDefinition("npm", ["run", "lint"], root),
      web_typecheck: commandDefinition("npm", ["run", "typecheck"], root),
      web_test: commandDefinition("npm", ["test"], root),
      web_build: commandDefinition("npm", ["run", "build"], root),
    } };
  }
  if (application === "mobile" && preset === "flutter") {
    const test = { executable: "flutter", args: ["test"], cwd: root };
    const typecheck = { executable: "flutter", args: ["analyze"], cwd: root };
    return { test, typecheck, commands: {
      mobile_format: commandDefinition("dart", ["format", "--output=none", "--set-exit-if-changed", "."], root),
      mobile_analyze: commandDefinition("flutter", ["analyze"], root),
      mobile_test: commandDefinition("flutter", ["test"], root),
      mobile_build_android: commandDefinition("flutter", ["build", "apk", "--debug"], root),
    } };
  }
  return undefined;
}

function commandDefinition(executable: string, args: string[], cwd: string, mutates = false) {
  return { executable, args, cwd, network: "disabled" as const, mutates };
}

function commandsForPresets(roots: ApplicationRoots, presets: ApplicationPresets): Record<string, ReturnType<typeof commandDefinition>> {
  const commands: Record<string, ReturnType<typeof commandDefinition>> = {};
  for (const application of Object.keys(roots) as ApplicationKind[]) {
    Object.assign(commands, checksForPreset(application, presets[application] ?? "generic", roots[application]!)?.commands ?? {});
  }
  return commands;
}

function aggregateChecks(roots: ApplicationRoots, presets: ApplicationPresets, kind: "test" | "typecheck"): NativeCheck[] | undefined {
  const checks: NativeCheck[] = [];
  for (const application of Object.keys(roots) as ApplicationKind[]) {
    const presetChecks = checksForPreset(application, presets[application] ?? "generic", roots[application]!);
    if (presetChecks === undefined) return undefined;
    checks.push(presetChecks[kind]);
  }
  return checks;
}

function aggregateCommand(checks: NativeCheck[]) {
  if (checks.length === 1) return commandDefinition(checks[0]!.executable, checks[0]!.args, checks[0]!.cwd);
  const script = `const {spawnSync}=require("node:child_process");const checks=${JSON.stringify(checks)};for(const check of checks){const result=spawnSync(check.executable,check.args,{cwd:check.cwd,stdio:"inherit",shell:false});if((result.status??1)!==0)process.exit(result.status??1)}`;
  return commandDefinition("node", ["-e", script], ".");
}

function lockSource(runtimeSpec: string, presets: ApplicationPresets, databasePreset: "none" | "postgresql", redis: boolean, repositoryEdits: RepositoryEditRecord): string {
  return stringify({
    schema_version: 1,
    product: FRAMEWORK_NAME,
    version: FRAMEWORK_VERSION,
    runtime_spec: runtimeSpec,
    schema_family: 1,
    skill_contract_version: 1,
    presets: { ...presets, database: databasePreset, redis: redis ? "redis" : "none" },
    repository_edits: repositoryEdits,
  });
}

export function permissionsSource(roots: ApplicationRoots): string {
  const patterns = Object.fromEntries(Object.entries(roots).map(([application, root]) => [application, root === "." ? "**" : `${root}/**`])) as Partial<Record<ApplicationKind, string>>;
  const backendWrites = patterns.backend === undefined ? [] : [patterns.backend];
  const frontendWrites = [patterns.web, patterns.mobile].filter((value): value is string => value !== undefined);
  const backendProhibited = frontendWrites;
  const frontendProhibited = backendWrites;
  return stringify({
    schema_version: 1,
    policy: "permissions",
    roles: {
      pm: {
        read_paths: ["**"],
        write_paths: [
          ".sdlc/runs/*/manifest.yaml", ".sdlc/runs/*/request.md", ".sdlc/runs/*/scope.md",
          ".sdlc/runs/*/assumptions.md", ".sdlc/runs/*/facts.yaml", ".sdlc/runs/*/tasks/*.assignment.yaml",
          ".sdlc/runs/*/artifacts/pm/**", ".sdlc/runs/*/artifacts/integration/**", ".sdlc/runs/*/final-report.md",
        ],
        terminal: "limited",
        deployment: "prohibited",
      },
      ba: { read_paths: ["**"], write_paths: [".sdlc/runs/*/artifacts/ba/**"], product_code_changes: "prohibited" },
      backend: { read_paths: ["**"], write_paths: [...backendWrites, ".sdlc/runs/*/artifacts/backend/**"], prohibited_product_paths: backendProhibited },
      frontend: { read_paths: ["**"], write_paths: [...frontendWrites, ".sdlc/runs/*/artifacts/web/**", ".sdlc/runs/*/artifacts/mobile/**"], prohibited_product_paths: frontendProhibited },
      qc: { read_paths: ["**"], write_paths: [...backendWrites, ...frontendWrites, ".sdlc/runs/*/artifacts/qc/**"], initial_product_repair: "prohibited" },
      runtime_collector: { read_paths: ["**"], write_paths: [".sdlc/runs/*/evidence/diffs/changed-files.json"] },
    },
    evidence_capture: { writer: "deterministic_runtime", command: "sdlc evidence", path_pattern: ".sdlc/runs/*/evidence/commands/*/evidence.json", direct_role_writes: "prohibited" },
    authority_publication: { writer: "deterministic_runtime", command: "sdlc publish-authority", input: "stdin_json", per_run_lock: "shared", version_check: "required", direct_role_writes: "prohibited" },
    protected_paths: [
      ".sdlc/project.yaml", ".sdlc/framework.yaml", ".sdlc/framework.lock.yaml", ".sdlc/runtime.cjs", ".sdlc/tooling/**",
      ".sdlc/policies/**", ".sdlc/schemas/**", ".sdlc/workflows/**", ".sdlc/templates/**", ".env", ".env.*",
      "**/.env", "**/.env.*", "**/secrets/**", ".git/**", ".github/workflows/**", "AGENTS.md", "**/AGENTS.md",
    ],
    all_roles: {
      production_credentials: "prohibited", production_deployment: "prohibited", destructive_git_actions: "prohibited",
      destructive_database_actions: "prohibited", writes_outside_permitted_repository_paths: "prohibited",
      network_access: "declared_policy_and_approval_only",
    },
    structured_delivery: {
      assignment_writer: "pm", backend_report_writer: "backend", frontend_report_writer: "frontend",
      assignment_path_pattern: ".sdlc/runs/*/tasks/*.assignment.yaml",
      report_path_patterns: [
        ".sdlc/runs/*/artifacts/backend/*-delivery-report.yaml", ".sdlc/runs/*/artifacts/web/*-delivery-report.yaml",
        ".sdlc/runs/*/artifacts/mobile/*-delivery-report.yaml",
      ],
      authority_reconciliation: "required",
    },
  });
}

export function toolingPackageSource(runtimeSpec: string): string {
  return `${JSON.stringify({ private: true, dependencies: { "codex-sdlc": runtimeSpec } }, null, 2)}\n`;
}

export function normalizeRuntimeSpec(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\n") || normalized.includes("\r")) throw new Error("runtime spec must be one non-empty line");
  return normalized;
}

export function launcherSource(): string {
  return `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst { join } = require("node:path");\nconst { pathToFileURL } = require("node:url");\nconst entry = join(__dirname, "tooling", "node_modules", "codex-sdlc", "dist", "bin.js");\nif (process.argv[2] === "restore") {\n  const result = spawnSync("npm", ["install", "--ignore-scripts"], { cwd: join(__dirname, "tooling"), stdio: "inherit", shell: false });\n  process.exitCode = result.status ?? 1;\n} else {\n  process.chdir(join(__dirname, ".."));\n  import(pathToFileURL(entry).href).catch((error) => {\n    console.error("codex-sdlc runtime is unavailable. Run: node .sdlc/runtime.cjs restore");\n    console.error(error instanceof Error ? error.message : String(error));\n    process.exitCode = 1;\n  });\n}\n`;
}

export function agentsBlock(): string {
  return `${agentsStart}\n# codex-sdlc\n\nUse the installed codex-sdlc plugin for complete feature delivery. Treat .sdlc/runs/<run-id>/manifest.yaml as run authority. Use node .sdlc/runtime.cjs for lifecycle operations, preserve native command failures, and do not hand-write runtime evidence.\n${agentsEnd}`;
}

export function mergeManagedBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(agentsStart);
  const end = existing.indexOf(agentsEnd);
  if (start === -1 && end === -1) return `${existing.replace(/\s*$/u, "")}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start) throw new Error("AGENTS.md contains a malformed codex-sdlc managed block");
  const current = existing.slice(start, end + agentsEnd.length);
  if (current !== block) throw new Error("AGENTS.md codex-sdlc managed block has local changes");
  return existing.endsWith("\n") ? existing : `${existing}\n`;
}

export function mergeIgnore(existing: string | undefined): string {
  const lines = textLines(existing);
  for (const line of managedIgnoreEntries) {
    if (!lines.includes(line)) lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

async function assertNoConflicts(root: string, content: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, expected] of content) {
    const actual = await readOptional(resolve(root, path));
    if (actual !== undefined && actual !== expected && path !== "AGENTS.md" && path !== ".gitignore") {
      throw new Error(`refusing to overwrite existing file: ${path}`);
    }
  }
  for (const directory of managedAssetDirectories) {
    const source = resolve(assetsRoot, directory);
    const destination = resolve(root, ".sdlc", directory);
    const overrides = directory === "policies" ? new Set(["permissions.yaml"]) : new Set<string>();
    if (await pathExists(destination) && !(await directoriesMatch(source, destination, overrides))) {
      throw new Error(`refusing to overwrite modified managed directory: .sdlc/${directory}`);
    }
  }
}

async function directoriesMatch(left: string, right: string, overrides = new Set<string>()): Promise<boolean> {
  const [leftEntries, rightEntries] = await Promise.all([
    readdir(left, { withFileTypes: true }),
    readdir(right, { withFileTypes: true }),
  ]);
  const leftNames = leftEntries.map((entry) => entry.name).sort();
  const rightNames = rightEntries.map((entry) => entry.name).sort();
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return false;
  for (const entry of leftEntries) {
    const leftPath = resolve(left, entry.name);
    const rightPath = resolve(right, entry.name);
    const rightEntry = rightEntries.find((candidate) => candidate.name === entry.name);
    if (rightEntry === undefined || entry.isDirectory() !== rightEntry.isDirectory() || entry.isFile() !== rightEntry.isFile()) return false;
    if (overrides.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (!(await directoriesMatch(leftPath, rightPath))) return false;
    } else if (entry.isFile()) {
      const [leftContent, rightContent] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
      if (!leftContent.equals(rightContent)) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function textLines(source: string | undefined): string[] {
  return (source ?? "").split(/\r?\n/u).filter((line) => line !== "");
}

function parseRepositoryEdits(lockSource: string | undefined): RepositoryEditRecord | undefined {
  if (lockSource === undefined) return undefined;
  let value: unknown;
  try {
    value = parse(lockSource) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || !("repository_edits" in value)) return undefined;
  const edits = value.repository_edits;
  if (edits === null || typeof edits !== "object") return undefined;
  const candidate = edits as Record<string, unknown>;
  return {
    agents_file_created: candidate.agents_file_created === true,
    gitignore_file_created: candidate.gitignore_file_created === true,
    gitignore_added_entries: Array.isArray(candidate.gitignore_added_entries)
      ? candidate.gitignore_added_entries.filter((entry): entry is string => typeof entry === "string" && managedIgnoreEntries.includes(entry as typeof managedIgnoreEntries[number]))
      : [],
  };
}
