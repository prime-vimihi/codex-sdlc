import { assertAgentPolicy, type AgentPolicy } from "./agents.js";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { FRAMEWORK_NAME, FRAMEWORK_VERSION, PROJECT_SCHEMA_VERSION } from "./constants.js";
import { loadFramework, loadLocal, loadProject, loadWorkflow } from "./config.js";
import { isPortableRepositoryPath, portablePathsOverlap } from "./paths.js";
import { assertRepositoryId, discoverRepository, normalizeRemoteIdentity, resolveWorkspace, type DiscoveredRepository } from "./workspace.js";

export const assetsRoot = fileURLToPath(new URL("../assets/", import.meta.url));
export const agentsStart = "<!-- codex-sdlc:start -->";
export const agentsEnd = "<!-- codex-sdlc:end -->";
export const managedAssetDirectories = ["schemas", "templates", "workflows", "policies", "presets"] as const;
export const managedIgnoreEntries = [".sdlc/tooling/node_modules/", ".sdlc/*.lock", ".sdlc/*.tmp", ".sdlc/local.yaml"] as const;

export interface RepositoryEditRecord {
  agents_file_created: boolean;
  gitignore_file_created: boolean;
  gitignore_added_entries: string[];
}

export interface InitializeProjectOptions {
  root: string;
  projectName: string;
  agents?: AgentPolicy;
  applications?: Array<"backend" | "web" | "mobile">;
  backendRoot?: string;
  webRoot?: string;
  mobileRoot?: string;
  workspaceMode?: "single-repository" | "multi-repository";
  repositories?: Record<string, string>;
  backendRepository?: string;
  webRepository?: string;
  mobileRepository?: string;
  docsRepository?: string;
  docsRoot?: string;
  contractsRepository?: string;
  contractsRoot?: string;
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

export interface ConfigureRepositoriesOptions {
  root: string;
  repositories: Record<string, string>;
  dryRun: boolean;
}

export interface ConfigureRepositoriesResult {
  root: string;
  dry_run: boolean;
  repositories: string[];
  file: ".sdlc/local.yaml";
}

export interface ProjectInspection {
  root: string;
  valid: boolean;
  ready: boolean;
  framework_version: string | null;
  diagnostics: string[];
}

export async function initializeProject(options: InitializeProjectOptions): Promise<InitializeProjectResult> {
  if (options.agents !== undefined) assertAgentPolicy(options.agents);
  const root = resolve(options.root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`repository root is not a directory: ${root}`);
  if (options.projectName.trim() === "") throw new Error("project name must not be empty");
  const applications = normalizeApplications(options.applications ?? ["backend"]);
  const workspaceMode = options.workspaceMode ?? "single-repository";
  const workspace = await initializeWorkspace(root, workspaceMode, options.repositories ?? {});
  const applicationRepositories = resolveApplicationRepositories(applications, workspace, options);
  const roots = applicationRoots(applications, options);
  assertApplicationRootsDoNotOverlap(roots, applicationRepositories);
  const resources = resolveResources(workspace, options);
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
    const repositoryId = applicationRepositories[application as ApplicationKind]!;
    const repositoryRoot = workspace.local[repositoryId]!;
    const applicationPath = resolve(repositoryRoot, applicationRoot);
    const fromRoot = relative(repositoryRoot, applicationPath);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\")) {
      throw new Error(`${application} root escapes repository ${repositoryId}: ${applicationRoot}`);
    }
    const applicationStat = await lstat(applicationPath);
    if (!applicationStat.isDirectory()) throw new Error(`${application} root is not a directory: ${applicationRoot}`);
  }
  for (const [resource, location] of Object.entries(resources)) {
    const resourcePath = resolve(workspace.local[location.repository]!, location.root);
    const fromRoot = relative(workspace.local[location.repository]!, resourcePath);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\")) {
      throw new Error(`${resource} root escapes repository ${location.repository}: ${location.root}`);
    }
    const resourceStat = await lstat(resourcePath);
    if (!resourceStat.isDirectory()) throw new Error(`${resource} root is not a directory: ${location.root}`);
  }

  const files = [
    ".sdlc/framework.yaml",
    ".sdlc/project.yaml",
    ".sdlc/framework.lock.yaml",
    ".sdlc/runtime.cjs",
    ".sdlc/tooling/package.json",
    ...(workspaceMode === "multi-repository" ? [".sdlc/local.yaml", ".sdlc/local.example.yaml"] : []),
    ".sdlc/policies/permissions.yaml",
    "AGENTS.md",
    ".gitignore",
  ];
  const content = new Map<string, string>([
    [".sdlc/framework.yaml", frameworkSource()],
    [".sdlc/project.yaml", projectSource(options.projectName.trim(), roots, presets, options.databasePreset ?? "none", options.redis ?? false, workspace, applicationRepositories, resources)],
    [".sdlc/framework.lock.yaml", lockSource(runtimeSpec, presets, options.databasePreset ?? "none", options.redis ?? false, repositoryEdits, workspaceMode)],
    [".sdlc/runtime.cjs", launcherSource()],
    [".sdlc/tooling/package.json", toolingPackageSource(runtimeSpec)],
    [".sdlc/policies/permissions.yaml", permissionsSource(roots, applicationRepositories, workspace.coordinator, resources)],
  ]);
  if (options.agents !== undefined) {
    const project = parse(content.get(".sdlc/project.yaml")!);
    project.agents = options.agents;
    content.set(".sdlc/project.yaml", stringify(project));
  }
  if (workspaceMode === "multi-repository") {
    content.set(".sdlc/local.yaml", localSource(workspace.local));
    content.set(".sdlc/local.example.yaml", localExampleSource(Object.keys(workspace.repositories)));
  }

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

export async function configureRepositories(options: ConfigureRepositoriesOptions): Promise<ConfigureRepositoriesResult> {
  const root = resolve(options.root);
  if (Object.keys(options.repositories).length === 0) throw new Error("at least one repository mapping is required");
  const project = await loadProject(root);
  if (project.workspace?.mode !== "multi-repository") throw new Error("repository mappings can be configured only for a multi-repository project");
  const current = await loadLocal(root);
  const next = { ...current.repositories };
  for (const [id, path] of Object.entries(options.repositories)) {
    assertRepositoryId(id);
    if (!Object.hasOwn(project.repositories ?? {}, id)) throw new Error(`repository is not declared in .sdlc/project.yaml: ${id}`);
    const discovered = await discoverRepository(path);
    const expected = project.repositories![id]!;
    if (normalizeRemoteIdentity(discovered.remote) !== normalizeRemoteIdentity(expected.remote)) {
      throw new Error(`repository ${id} remote does not match project.yaml: expected ${expected.remote}, found ${discovered.remote}`);
    }
    next[id] = discovered.root;
  }
  const candidate = localSource(next);
  await resolveWorkspace(root, project, { schema_version: 1, repositories: next });
  if (!options.dryRun) {
    await writeFile(resolve(root, ".sdlc/local.yaml"), candidate, "utf8");
  }
  return { root, dry_run: options.dryRun, repositories: Object.keys(options.repositories).sort(), file: ".sdlc/local.yaml" };
}

export async function inspectProject(rootInput: string): Promise<ProjectInspection> {
  const root = resolve(rootInput);
  const settled = await Promise.allSettled([loadFramework(root), loadProject(root), loadWorkflow(root)]);
  const diagnostics = settled.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
    : []);
  const framework = settled[0];
  const project = settled[1];
  if (project.status === "fulfilled") {
    try { await resolveWorkspace(root, project.value); } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
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
export type ApplicationRepositories = Partial<Record<ApplicationKind, string>>;
type ApplicationPresets = Partial<Record<ApplicationKind, "generic" | "go" | "nextjs" | "flutter">>;

interface InitialWorkspace {
  mode: "single-repository" | "multi-repository";
  coordinator: string;
  repositories: Record<string, { remote: string; default_branch: string }>;
  local: Record<string, string>;
}

type ProjectResources = Partial<Record<"documentation" | "api_contracts", { repository: string; root: string }>>;

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

function assertApplicationRootsDoNotOverlap(roots: ApplicationRoots, repositories: ApplicationRepositories): void {
  const entries = Object.entries(roots) as Array<[ApplicationKind, string]>;
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftApplication, leftRoot] = entries[leftIndex]!;
      const [rightApplication, rightRoot] = entries[rightIndex]!;
      if (repositories[leftApplication] === repositories[rightApplication] && portablePathsOverlap(leftRoot, rightRoot)) {
        throw new Error(`${leftApplication} root ${leftRoot} overlaps ${rightApplication} root ${rightRoot}`);
      }
    }
  }
}

async function initializeWorkspace(
  root: string,
  mode: "single-repository" | "multi-repository",
  configured: Record<string, string>,
): Promise<InitialWorkspace> {
  if (mode === "single-repository") {
    if (Object.keys(configured).length > 0) throw new Error("--repo requires --workspace-mode multi-repository");
    return { mode, coordinator: "coordinator", repositories: {}, local: { coordinator: root } };
  }
  const local: Record<string, string> = { coordinator: root };
  for (const [id, path] of Object.entries(configured)) {
    assertRepositoryId(id);
    if (id === "coordinator") throw new Error("repository ID coordinator is reserved for --root");
    local[id] = resolve(path);
  }
  const repositories: InitialWorkspace["repositories"] = {};
  for (const [id, path] of Object.entries(local)) {
    const discovered: DiscoveredRepository = await discoverRepository(path);
    repositories[id] = { remote: discovered.remote, default_branch: discovered.default_branch };
    local[id] = discovered.root;
  }
  const roots = Object.entries(local);
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (roots[left]![1] === roots[right]![1]) throw new Error(`repositories ${roots[left]![0]} and ${roots[right]![0]} map to the same checkout`);
      const leftToRight = relative(roots[left]![1], roots[right]![1]);
      const rightToLeft = relative(roots[right]![1], roots[left]![1]);
      if ((leftToRight !== "" && leftToRight !== ".." && !leftToRight.startsWith("../") && !leftToRight.startsWith("..\\") && !isAbsolute(leftToRight))
        || (rightToLeft !== "" && rightToLeft !== ".." && !rightToLeft.startsWith("../") && !rightToLeft.startsWith("..\\") && !isAbsolute(rightToLeft))) {
        throw new Error(`nested repository mappings are not supported: ${roots[left]![0]}, ${roots[right]![0]}`);
      }
    }
  }
  return { mode, coordinator: "coordinator", repositories, local };
}

function resolveApplicationRepositories(
  applications: ApplicationKind[],
  workspace: InitialWorkspace,
  options: InitializeProjectOptions,
): ApplicationRepositories {
  const requested = {
    backend: options.backendRepository,
    web: options.webRepository,
    mobile: options.mobileRepository,
  };
  const result: ApplicationRepositories = {};
  for (const application of applications) {
    const id = requested[application] ?? (Object.hasOwn(workspace.local, application) ? application : workspace.coordinator);
    assertRepositoryId(id);
    if (!Object.hasOwn(workspace.local, id)) throw new Error(`${application} repository is not mapped by --repo: ${id}`);
    result[application] = id;
  }
  return result;
}

function resolveResources(workspace: InitialWorkspace, options: InitializeProjectOptions): ProjectResources {
  const resources: ProjectResources = {};
  if (options.docsRepository !== undefined || options.docsRoot !== undefined) {
    const repository = options.docsRepository ?? workspace.coordinator;
    if (!Object.hasOwn(workspace.local, repository)) throw new Error(`documentation repository is not mapped by --repo: ${repository}`);
    resources.documentation = { repository, root: normalizeRoot(options.docsRoot ?? ".") };
  }
  if (options.contractsRepository !== undefined || options.contractsRoot !== undefined) {
    const repository = options.contractsRepository ?? workspace.coordinator;
    if (!Object.hasOwn(workspace.local, repository)) throw new Error(`API contracts repository is not mapped by --repo: ${repository}`);
    resources.api_contracts = { repository, root: normalizeRoot(options.contractsRoot ?? ".") };
  }
  return resources;
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
    framework: { name: FRAMEWORK_NAME, version: FRAMEWORK_VERSION, run_schema_version: 1, project_schema_version: PROJECT_SCHEMA_VERSION },
    installation: {
      mode: "repository",
      managed_paths: [".sdlc/schemas", ".sdlc/templates", ".sdlc/workflows", ".sdlc/policies", ".sdlc/presets", ".sdlc/runtime.cjs", ".sdlc/tooling"],
      repository_specific_paths: ["AGENTS.md", ".sdlc/project.yaml", ".sdlc/framework.lock.yaml", ".sdlc/runs", ".sdlc/requests", ".sdlc/backups"],
    },
  });
}

function projectSource(
  name: string,
  roots: ApplicationRoots,
  presets: ApplicationPresets,
  databasePreset: "none" | "postgresql",
  redis: boolean,
  workspace: InitialWorkspace,
  applicationRepositories: ApplicationRepositories,
  resources: ProjectResources,
): string {
  const multi = workspace.mode === "multi-repository";
  const validation = commandDefinition("node", [".sdlc/runtime.cjs", "validate-config"], ".", false, multi ? workspace.coordinator : undefined);
  const unconfigured = (command: string) => ({
    executable: "node",
    args: ["-e", `console.error(${JSON.stringify(`Configure commands.${command} in .sdlc/project.yaml before collecting evidence`)});process.exit(2)`],
    cwd: ".",
    ...(multi ? { repository: workspace.coordinator } : {}),
    network: "disabled",
    mutates: false,
  });
  const applications = Object.fromEntries((Object.keys(roots) as ApplicationKind[]).map((application) => {
    const preset = presets[application] ?? "generic";
    const identity = presetIdentity(application, preset);
    return [application, { lifecycle: "active", ...(multi ? { repository: applicationRepositories[application] } : {}), root: roots[application], ...identity }];
  }));
  const presetCommands = commandsForPresets(roots, presets, applicationRepositories, multi);
  const testCommands = aggregateChecks(roots, presets, applicationRepositories, "test");
  const typecheckCommands = aggregateChecks(roots, presets, applicationRepositories, "typecheck");
  const projectType = Object.keys(applications).length > 1 ? "multi-application"
    : roots.web !== undefined ? "web-application"
      : roots.mobile !== undefined ? "mobile-application" : "backend-service";
  return stringify({
    schema_version: multi ? PROJECT_SCHEMA_VERSION : 1,
    framework: { name: FRAMEWORK_NAME, version: FRAMEWORK_VERSION },
    project: { name, type: projectType, default_branch: "main", repository_structure: multi ? "multi-repository" : "repository" },
    ...(multi ? { workspace: { mode: workspace.mode, coordinator: workspace.coordinator }, repositories: workspace.repositories } : {}),
    applications,
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    data: {
      primary_database: databasePreset,
      redis: { enabled: redis, roles: redis ? ["cache"] : [] },
      media: { object_storage: "none", cdn: false },
      future_capabilities: {},
    },
    security: { secret_environment_variables: [], network_policy_attestation_environment: "CODEX_SDLC_NETWORK_POLICY" },
    commands: {
      sdlc_test: testCommands === undefined ? unconfigured("sdlc_test") : aggregateCommand(testCommands, multi, workspace.coordinator),
      sdlc_typecheck: typecheckCommands === undefined ? unconfigured("sdlc_typecheck") : aggregateCommand(typecheckCommands, multi, workspace.coordinator),
      sdlc_validate: validation,
      ...presetCommands,
    },
  });
}

interface NativeCheck {
  executable: string;
  args: string[];
  cwd: string;
  repository: string;
}

function presetIdentity(application: ApplicationKind, preset: NonNullable<ApplicationPresets[ApplicationKind]>): { framework: string; language: string } {
  if (application === "backend" && preset === "go") return { framework: "go", language: "go" };
  if (application === "web" && preset === "nextjs") return { framework: "nextjs", language: "typescript" };
  if (application === "mobile" && preset === "flutter") return { framework: "flutter", language: "dart" };
  return { framework: "generic", language: "generic" };
}

function checksForPreset(application: ApplicationKind, preset: NonNullable<ApplicationPresets[ApplicationKind]>, root: string, repository: string, multi: boolean): { test: NativeCheck; typecheck: NativeCheck; commands: Record<string, ReturnType<typeof commandDefinition>> } | undefined {
  if (application === "backend" && preset === "go") {
    const test = { executable: "go", args: ["test", "./..."], cwd: root, repository };
    const typecheck = { executable: "go", args: ["vet", "./..."], cwd: root, repository };
    return { test, typecheck, commands: {
      backend_format: commandDefinition("gofmt", ["-w", "."], root, true, multi ? repository : undefined),
      backend_lint: commandDefinition("go", ["vet", "./..."], root, false, multi ? repository : undefined),
      backend_test: commandDefinition("go", ["test", "./..."], root, false, multi ? repository : undefined),
      backend_build: commandDefinition("go", ["build", "./..."], root, false, multi ? repository : undefined),
    } };
  }
  if (application === "web" && preset === "nextjs") {
    const test = { executable: "npm", args: ["test"], cwd: root, repository };
    const typecheck = { executable: "npm", args: ["run", "typecheck"], cwd: root, repository };
    return { test, typecheck, commands: {
      web_lint: commandDefinition("npm", ["run", "lint"], root, false, multi ? repository : undefined),
      web_typecheck: commandDefinition("npm", ["run", "typecheck"], root, false, multi ? repository : undefined),
      web_test: commandDefinition("npm", ["test"], root, false, multi ? repository : undefined),
      web_build: commandDefinition("npm", ["run", "build"], root, false, multi ? repository : undefined),
    } };
  }
  if (application === "mobile" && preset === "flutter") {
    const test = { executable: "flutter", args: ["test"], cwd: root, repository };
    const typecheck = { executable: "flutter", args: ["analyze"], cwd: root, repository };
    return { test, typecheck, commands: {
      mobile_format: commandDefinition("dart", ["format", "--output=none", "--set-exit-if-changed", "."], root, false, multi ? repository : undefined),
      mobile_analyze: commandDefinition("flutter", ["analyze"], root, false, multi ? repository : undefined),
      mobile_test: commandDefinition("flutter", ["test"], root, false, multi ? repository : undefined),
      mobile_build_android: commandDefinition("flutter", ["build", "apk", "--debug"], root, false, multi ? repository : undefined),
    } };
  }
  return undefined;
}

function commandDefinition(executable: string, args: string[], cwd: string, mutates = false, repository?: string) {
  return { ...(repository === undefined ? {} : { repository }), executable, args, cwd, network: "disabled" as const, mutates };
}

function commandsForPresets(roots: ApplicationRoots, presets: ApplicationPresets, repositories: ApplicationRepositories, multi: boolean): Record<string, ReturnType<typeof commandDefinition>> {
  const commands: Record<string, ReturnType<typeof commandDefinition>> = {};
  for (const application of Object.keys(roots) as ApplicationKind[]) {
    Object.assign(commands, checksForPreset(application, presets[application] ?? "generic", roots[application]!, repositories[application]!, multi)?.commands ?? {});
  }
  return commands;
}

function aggregateChecks(roots: ApplicationRoots, presets: ApplicationPresets, repositories: ApplicationRepositories, kind: "test" | "typecheck"): NativeCheck[] | undefined {
  const checks: NativeCheck[] = [];
  for (const application of Object.keys(roots) as ApplicationKind[]) {
    const presetChecks = checksForPreset(application, presets[application] ?? "generic", roots[application]!, repositories[application]!, true);
    if (presetChecks === undefined) return undefined;
    checks.push(presetChecks[kind]);
  }
  return checks;
}

function aggregateCommand(checks: NativeCheck[], multi: boolean, coordinator: string) {
  if (checks.length === 1) return commandDefinition(checks[0]!.executable, checks[0]!.args, checks[0]!.cwd, false, multi ? checks[0]!.repository : undefined);
  if (multi) return { ...commandDefinition("codex-sdlc-composite", [], ".", false, coordinator), steps: checks };
  const script = `const {spawnSync}=require("node:child_process");const checks=${JSON.stringify(checks)};for(const check of checks){const result=spawnSync(check.executable,check.args,{cwd:check.cwd,stdio:"inherit",shell:false});if((result.status??1)!==0)process.exit(result.status??1)}`;
  return commandDefinition("node", ["-e", script], ".");
}

function lockSource(runtimeSpec: string, presets: ApplicationPresets, databasePreset: "none" | "postgresql", redis: boolean, repositoryEdits: RepositoryEditRecord, workspaceMode: "single-repository" | "multi-repository"): string {
  return stringify({
    schema_version: 1,
    product: FRAMEWORK_NAME,
    version: FRAMEWORK_VERSION,
    runtime_spec: runtimeSpec,
    schema_family: workspaceMode === "multi-repository" ? 2 : 1,
    skill_contract_version: 1,
    presets: { ...presets, database: databasePreset, redis: redis ? "redis" : "none" },
    repository_edits: repositoryEdits,
  });
}

export function permissionsSource(roots: ApplicationRoots, repositories: ApplicationRepositories = {}, coordinator = "coordinator", resources: ProjectResources = {}): string {
  const patterns = Object.fromEntries(Object.entries(roots).map(([application, root]) => [application, root === "." ? "**" : `${root}/**`])) as Partial<Record<ApplicationKind, string>>;
  const locations = Object.fromEntries(Object.entries(roots).map(([application, root]) => [application, {
    repository: repositories[application as ApplicationKind] ?? coordinator,
    path: root === "." ? "**" : `${root}/**`,
  }])) as Partial<Record<ApplicationKind, { repository: string; path: string }>>;
  const backendWrites = patterns.backend === undefined ? [] : [patterns.backend];
  const frontendWrites = [patterns.web, patterns.mobile].filter((value): value is string => value !== undefined);
  const backendProhibited = frontendWrites;
  const frontendProhibited = backendWrites;
  const contractLocation = resources.api_contracts === undefined ? undefined : {
    repository: resources.api_contracts.repository,
    path: resources.api_contracts.root === "." ? "**" : `${resources.api_contracts.root}/**`,
  };
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
      backend: { read_paths: ["**"], write_paths: [...backendWrites, ".sdlc/runs/*/artifacts/backend/**"], write_locations: [locations.backend, contractLocation].filter((value) => value !== undefined), prohibited_product_paths: backendProhibited },
      frontend: { read_paths: ["**"], write_paths: [...frontendWrites, ".sdlc/runs/*/artifacts/web/**", ".sdlc/runs/*/artifacts/mobile/**"], write_locations: [locations.web, locations.mobile].filter((value) => value !== undefined), prohibited_product_paths: frontendProhibited },
      qc: { read_paths: ["**"], write_paths: [...backendWrites, ...frontendWrites, ".sdlc/runs/*/artifacts/qc/**"], write_locations: [locations.backend, locations.web, locations.mobile].filter((value) => value !== undefined), initial_product_repair: "prohibited" },
      po: { read_paths: ["**"], write_paths: [".sdlc/runs/*/artifacts/po/**"], product_code_changes: "prohibited", human_decisions: "prohibited" },
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
  }, { aliasDuplicateObjects: false });
}

function localSource(repositories: Record<string, string>): string {
  return stringify({ schema_version: 1, repositories });
}

function localExampleSource(repositoryIds: string[]): string {
  return stringify({
    schema_version: 1,
    repositories: Object.fromEntries(repositoryIds.map((id) => [id, `/absolute/path/to/${id}`])),
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
