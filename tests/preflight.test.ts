import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { initializeProject } from "../src/install.js";
import { preflightProject } from "../src/preflight.js";
import type { ProjectConfig } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(configured = true) {
  const root = await mkdtemp(join(tmpdir(), "sdlc-preflight-")); roots.push(root);
  await mkdir(join(root, "customer"));
  await initializeProject({ root, projectName: "Readiness", applications: ["web"], webRoot: "customer", dryRun: false });
  if (configured) await change(root, (project) => {
    for (const id of ["sdlc_test", "sdlc_typecheck"]) project.commands[id] = { executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('must-not-exist', 'executed')"], cwd: "customer", network: "disabled", mutates: true };
  });
  return root;
}
async function change(root: string, edit: (project: ProjectConfig) => void) {
  const path = join(root, ".sdlc/project.yaml");
  const project = parse(await readFile(path, "utf8")) as ProjectConfig; edit(project); await writeFile(path, stringify(project));
}

describe("targeted readiness preflight", () => {
  test("inspects local requirements without running even mutating commands or claiming live readiness", async () => {
    const root = await fixture();
    await writeFile(join(root, "fixture.json"), '{"secret":"not-read-or-emitted"}');
    const before = await readFile(join(root, ".sdlc/project.yaml"), "utf8");
    const result = await preflightProject(root, { applications: ["web"], expectedRoots: { web: "customer" }, requiredFiles: ["fixture.json"] });
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.id === "services")?.status).toBe("not_checked");
    expect(JSON.stringify(result)).not.toContain("not-read-or-emitted");
    expect(await readFile(join(root, ".sdlc/project.yaml"), "utf8")).toBe(before);
    await expect(readFile(join(root, "customer/must-not-exist"))).rejects.toThrow();
  });
  test("blocks admin/customer mismatch and undeclared affected applications", async () => {
    const root = await fixture(); await mkdir(join(root, "admin"));
    const result = await preflightProject(root, { applications: ["web", "mobile"], expectedRoots: { web: "admin" } });
    expect(result.ready).toBe(false);
    expect(result.diagnostics.join(" ")).toContain("root mismatch");
    expect(result.diagnostics.join(" ")).toContain("mobile is not declared");
  });
  test("blocks missing, directory, escaped, or outside-symlink fixture paths", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "sdlc-outside-")); roots.push(outside);
    await writeFile(join(outside, "fixture"), "private"); await symlink(join(outside, "fixture"), join(root, "linked"));
    for (const file of ["missing.json", "customer", "../fixture", "linked"]) {
      expect((await preflightProject(root, { requiredFiles: [file] })).ready).toBe(false);
    }
  });
  test("blocks generic unconfigured commands and explicitly missing declarations", async () => {
    const root = await fixture(false);
    expect((await preflightProject(root)).diagnostics.join(" ")).toContain("unconfigured");
    expect((await preflightProject(root, { commands: ["acceptance_test"] })).diagnostics.join(" ")).toContain("not declared");
  });
  test("blocks missing executable, root, and npm script without invoking npm", async () => {
    const root = await fixture();
    await change(root, (project) => { project.commands.sdlc_test.executable = "sdlc-impossible-executable-for-test"; });
    expect((await preflightProject(root)).diagnostics.join(" ")).toContain("executable is unavailable");
    await change(root, (project) => { project.commands.sdlc_test.executable = "npm"; project.commands.sdlc_test.args = ["run", "acceptance"]; });
    await writeFile(join(root, "customer/package.json"), '{"scripts":{"test":"echo hi"}}');
    expect((await preflightProject(root)).diagnostics.join(" ")).toContain("npm script acceptance is missing");
    await rm(join(root, "customer"), { recursive: true });
    expect((await preflightProject(root)).ready).toBe(false);
  });
  test("rejects missing/mismatched framework configuration and unknown expected-root selections", async () => {
    const root = await fixture();
    expect((await preflightProject(root, { expectedRoots: { mobile: "mobile" } })).ready).toBe(false);
    const frameworkPath = join(root, ".sdlc/framework.yaml");
    const framework = parse(await readFile(frameworkPath, "utf8")); framework.framework.version = "0.0.0";
    await writeFile(frameworkPath, stringify(framework));
    expect((await preflightProject(root)).diagnostics.join(" ")).toContain("framework.version");
  });
  test("target selection skips unrelated aggregate command steps", async () => {
    const root = await fixture();
    await change(root, (project) => {
      project.commands.sdlc_test.steps = [
        { repository: "coordinator", executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: "customer" },
        { repository: "coordinator", executable: "nonexistent-tool", args: [], cwd: "unrelated" },
      ];
    });
    expect((await preflightProject(root, { applications: ["web"] })).ready).toBe(true);
    expect((await preflightProject(root, { applications: ["web"], commands: ["sdlc_test"] })).ready).toBe(false);
  });
});
