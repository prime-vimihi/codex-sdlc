import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, delimiter, extname, isAbsolute, resolve } from "node:path";

import { loadFramework, loadProject } from "./config.js";
import { isPortableRepositoryPath, portablePathsOverlap, resolvePathInsideRoot } from "./paths.js";
import { configuredSecretValues, redactText } from "./redaction.js";
import { repositoryForApplication, resolveWorkspace, resolveWorkspacePath } from "./workspace.js";
import type { ApplicationKind } from "./install.js";
import type { CommandStep, ProjectConfig } from "./types.js";

export interface PreflightOptions {
  applications?: string[];
  expectedRoots?: Record<string, string>;
  /** Coordinator-relative paths, or repository:path in a mapped workspace. */
  requiredFiles?: string[];
  /** Inspect only these declarations when supplied; never execute them. */
  commands?: string[];
}
export interface PreflightCheck {
  id: string;
  status: "passed" | "blocked" | "not_checked";
  message: string;
  next_step?: string;
}
export interface PreflightReport {
  root: string;
  ready: boolean;
  status: "ready" | "blocked";
  checks: PreflightCheck[];
  diagnostics: string[];
}

/** Targeted local inspection only. No application commands, startup, or service probes. */
export async function preflightProject(rootInput: string, options: PreflightOptions = {}): Promise<PreflightReport> {
  const root = resolve(rootInput);
  const checks: PreflightCheck[] = [];
  let secrets: string[] = [];
  const add = (id: string, status: PreflightCheck["status"], message: string, next_step?: string) => {
    checks.push({ id, status, message: redactText(message, secrets), ...(next_step ? { next_step } : {}) });
  };
  const finish = (): PreflightReport => {
    add("services", "not_checked", "Live services, database connectivity, and populated test data have not been checked.", "Record separate service and test-data evidence before checks that depend on them.");
    add("execution", "not_checked", "No builds, tests, application startup, installs, or seed commands were executed.");
    add("model-capabilities", "not_checked", "Configured model policy is validated locally; current host model availability is checked at dispatch.");
    const diagnostics = checks.filter((check) => check.status === "blocked").map((check) => check.message);
    return { root, ready: diagnostics.length === 0, status: diagnostics.length === 0 ? "ready" : "blocked", checks, diagnostics };
  };
  let project: ProjectConfig;
  try {
    project = await loadProject(root);
    secrets = configuredSecretValues(project.security.secret_environment_variables);
    await loadFramework(root);
    const runtime = await resolvePathInsideRoot(root, ".sdlc/runtime.cjs", { mustExist: true });
    if (!(await stat(runtime)).isFile()) throw new Error(".sdlc/runtime.cjs is not a file");
    add("configuration", "passed", "Project and framework schemas/versions match this runtime; local runtime launcher exists.");
  } catch (error) {
    add("configuration", "blocked", message(error), "Repair or upgrade the project configuration and runtime installation.");
    return finish();
  }
  let workspace;
  try {
    workspace = await resolveWorkspace(root, project);
    add("workspace", "passed", "Declared repository mappings resolve to the expected local checkouts.");
  } catch (error) {
    add("workspace", "blocked", message(error), "Correct the repository declarations and local mappings.");
    return finish();
  }
  const applications = [...new Set(options.applications ?? Object.keys(project.applications))];
  if (!applications.length) add("applications", "blocked", "No affected applications selected.", "Select at least one declared application.");
  for (const role of Object.keys(options.expectedRoots ?? {})) {
    if (!applications.includes(role)) add(`expected-root:${role}`, "blocked", `Expected root for ${role} is outside the selected applications.`, "Include that application in the preflight selection.");
  }
  for (const name of applications) {
    const application = Object.hasOwn(project.applications, name) ? project.applications[name] : undefined;
    if (!["backend", "web", "mobile"].includes(name) || !application) {
      add(`application:${name}`, "blocked", `Requested application ${name} is not declared.`, "Declare the requested application and its repository/root before delivery.");
      continue;
    }
    const expected = options.expectedRoots?.[name];
    if (expected !== undefined && (!isPortableRepositoryPath(expected) || expected !== application.root)) {
      add(`expected-root:${name}`, "blocked", `${name} root mismatch: expected ${expected}; configured ${application.root}.`, "Correct the selected application root; do not substitute an admin or customer application.");
    }
    try {
      const path = await resolveWorkspacePath(workspace, repositoryForApplication(project, name as ApplicationKind), application.root, { mustExist: true });
      if (!(await stat(path)).isDirectory()) throw new Error(`${name} root is not a directory`);
      add(`application:${name}`, "passed", `${name} directory exists at ${application.root}; lifecycle is ${application.lifecycle}.`);
    } catch (error) {
      add(`application:${name}`, "blocked", message(error), "Provide the declared application directory or correct its root.");
    }
  }
  for (const file of options.requiredFiles ?? []) {
    try {
      const separator = file.indexOf(":");
      const repository = separator < 0 ? workspace.coordinator : file.slice(0, separator);
      const path = separator < 0 ? file : file.slice(separator + 1);
      const absolute = await resolveWorkspacePath(workspace, repository, path, { mustExist: true });
      if (!(await stat(absolute)).isFile()) throw new Error(`Required fixture is not a file: ${file}`);
      add(`file:${file}`, "passed", `Required local file exists: ${file}. Its data content and live use are not verified.`);
    } catch (error) {
      add(`file:${file}`, "blocked", message(error), "Supply the required fixture file in the declared repository.");
    }
  }
  const commandIds = options.commands ?? applications.flatMap((application) => [
    Object.hasOwn(project.commands, `${application}_test`) ? `${application}_test` : "sdlc_test",
    Object.hasOwn(project.commands, `${application}_typecheck`) ? `${application}_typecheck` : "sdlc_typecheck",
  ]);
  for (const id of new Set(commandIds)) {
    const command = Object.hasOwn(project.commands, id) ? project.commands[id] : undefined;
    if (!command) {
      add(`command:${id}`, "blocked", `Required command ${id} is not declared.`, "Configure the required command in project.yaml.");
      continue;
    }
    let declarations = command.steps ?? [command];
    if (options.commands === undefined && command.steps) {
      declarations = declarations.filter((step) => applications.some((name) => {
        const application = Object.hasOwn(project.applications, name) ? project.applications[name] : undefined;
        return application && (step.repository ?? command.repository ?? workspace.coordinator) === (application.repository ?? workspace.coordinator)
          && portablePathsOverlap(step.cwd, application.root);
      }));
    }
    if (!declarations.length) add(`command:${id}`, "blocked", `Command ${id} has no steps covering selected applications.`, "Declare checks for the selected application roots.");
    for (const [index, step] of declarations.entries()) {
      try {
        if (step.args.some((arg) => arg.includes(`Configure commands.${id}`))) throw new Error(`Command ${id} is unconfigured`);
        const cwd = await resolveWorkspacePath(workspace, step.repository ?? command.repository, step.cwd, { mustExist: true });
        if (!(await stat(cwd)).isDirectory()) throw new Error(`Command ${id} working directory is not a directory`);
        if (!await executableAvailable(step.executable, cwd)) throw new Error(`Command ${id} executable is unavailable: ${step.executable}`);
        await inspectScript(step, cwd, workspace.repositories[step.repository ?? command.repository ?? workspace.coordinator]!.root);
        add(`command:${id}:${index}`, "passed", `Command ${id} declaration, working directory, and executable are locally available; command was not executed.`);
      } catch (error) {
        add(`command:${id}:${index}`, "blocked", message(error), "Correct the command declaration or provide the missing local tool/script.");
      }
    }
  }
  return finish();
}

async function executableAvailable(executable: string, cwd: string): Promise<boolean> {
  const hasPath = isAbsolute(executable) || /[/\\]/.test(executable);
  const directories = hasPath ? [cwd] : (process.env.PATH ?? "").split(delimiter).map((path) => resolve(cwd, path));
  const suffixes = process.platform === "win32" && !extname(executable) ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = resolve(directory, `${executable}${suffix}`);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch { /* Inspect other PATH candidates without executing anything. */ }
  }
  return false;
}

async function inspectScript(step: CommandStep, cwd: string, repositoryRoot: string): Promise<void> {
  const executable = basename(step.executable).replace(/\.(exe|cmd|bat)$/i, "");
  if (executable === "npm") {
    const script = step.args[0] === "run" || step.args[0] === "run-script" ? step.args[1] : step.args[0] === "test" ? "test" : undefined;
    if (script) {
      const path = await resolvePathInsideRoot(cwd, "package.json", { mustExist: true });
      let packageJson: { scripts?: Record<string, unknown> };
      try { packageJson = JSON.parse(await readFile(path, "utf8")); }
      catch { throw new Error("The configured working directory has invalid package.json metadata"); }
      if (typeof packageJson.scripts?.[script] !== "string" || !packageJson.scripts[script].trim()) throw new Error(`npm script ${script} is missing from the configured working directory`);
    }
  }
  if (executable === "node" && step.args[0] && !step.args[0].startsWith("-")) {
    const path = await resolvePathInsideRoot(repositoryRoot, resolve(cwd, step.args[0]), { mustExist: true });
    if (!(await stat(path)).isFile()) throw new Error("Configured Node script is not a file");
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
