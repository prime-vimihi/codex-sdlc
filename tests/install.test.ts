import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { initializeProject, inspectProject } from "../src/install.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-test-"));
  await mkdir(resolve(root, "service"));
  await mkdir(resolve(root, "web"));
  await mkdir(resolve(root, "mobile"));
  await writeFile(resolve(root, "AGENTS.md"), "# Existing repository instructions\n", "utf8");
  await writeFile(resolve(root, ".gitignore"), "build/\n", "utf8");
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const relative = absolute.slice(root.length + 1);
      if (entry.isDirectory()) await visit(absolute);
      else result[relative] = await readFile(absolute, "utf8");
    }
  }
  await visit(root);
  return result;
}

describe("project initialization", () => {
  test("dry-run reports its bounded plan without writing", async () => {
    const root = await fixture();
    const before = await snapshot(root);

    const result = await initializeProject({ root, projectName: "Example", backendRoot: "service", dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.files).toContain(".sdlc/project.yaml");
    expect(await snapshot(root)).toEqual(before);
  });

  test("installs a valid project and is byte-idempotent", async () => {
    const root = await fixture();

    await initializeProject({ root, projectName: "Example", backendRoot: "service", dryRun: false });
    const first = await snapshot(root);
    await initializeProject({ root, projectName: "Example", backendRoot: "service", dryRun: false });

    expect(await snapshot(root)).toEqual(first);
    const inspection = await inspectProject(root);
    expect(inspection.valid).toBe(true);
    expect(inspection.ready).toBe(false);
    expect(inspection.diagnostics).toContain("commands.sdlc_test is unconfigured in .sdlc/project.yaml");
    expect(await snapshot(root)).toEqual(first);
    expect(first["AGENTS.md"]).toContain("# Existing repository instructions");
    expect(first[".gitignore"]).toContain("build/");
    expect(first[".sdlc/project.yaml"]).toContain("Configure commands.sdlc_test");
    expect(first[".sdlc/runtime.cjs"]).toContain("process.chdir(join(__dirname, \"..\"))");
  });

  test("refuses to replace a modified managed asset", async () => {
    const root = await fixture();
    await initializeProject({ root, projectName: "Example", backendRoot: "service", dryRun: false });
    await writeFile(resolve(root, ".sdlc/schemas/run.schema.json"), "{}\n", "utf8");

    await expect(initializeProject({ root, projectName: "Example", backendRoot: "service", dryRun: false }))
      .rejects.toThrow("refusing to overwrite modified managed directory");
  });

  test("rejects application roots outside the repository", async () => {
    const root = await fixture();
    await expect(initializeProject({ root, projectName: "Example", backendRoot: "../outside", dryRun: true }))
      .rejects.toThrow("not a portable repository path");
  });

  test("rejects overlapping application roots", async () => {
    const root = await fixture();
    await expect(initializeProject({
      root,
      projectName: "Overlap",
      applications: ["backend", "web"],
      backendRoot: ".",
      webRoot: "web",
      dryRun: true,
    })).rejects.toThrow("backend root . overlaps web root web");
  });

  test("rejects a technology preset without its application", async () => {
    const root = await fixture();
    await expect(initializeProject({
      root,
      projectName: "Mismatch",
      applications: ["web"],
      webRoot: "web",
      backendPreset: "go",
      dryRun: true,
    })).rejects.toThrow("backend preset requires the backend application");
  });

  test("creates a ready web-only Next.js project", async () => {
    const root = await fixture();
    await initializeProject({
      root, projectName: "Web", applications: ["web"], webRoot: "web", webPreset: "nextjs", dryRun: false,
    });

    const project = await readFile(resolve(root, ".sdlc/project.yaml"), "utf8");
    expect(project).toContain("type: web-application");
    expect(project).toContain("framework: nextjs");
    expect(project).toContain("web_build:");
    expect(project).not.toContain("backend:");
    expect(await readFile(resolve(root, ".sdlc/presets/nextjs.yaml"), "utf8")).toContain("id: nextjs");
    expect((await inspectProject(root)).ready).toBe(true);
  });

  test("creates a ready mobile-only Flutter project", async () => {
    const root = await fixture();
    await initializeProject({
      root, projectName: "Mobile", applications: ["mobile"], mobileRoot: "mobile", mobilePreset: "flutter", dryRun: false,
    });

    const project = await readFile(resolve(root, ".sdlc/project.yaml"), "utf8");
    expect(project).toContain("type: mobile-application");
    expect(project).toContain("framework: flutter");
    expect(project).toContain("mobile_build_android:");
    expect((await inspectProject(root)).ready).toBe(true);
  });

  test("combines Go, Next.js, Flutter, PostgreSQL, and Redis presets", async () => {
    const root = await fixture();
    await initializeProject({
      root,
      projectName: "Combined",
      applications: ["backend", "web", "mobile"],
      backendRoot: "service",
      webRoot: "web",
      mobileRoot: "mobile",
      backendPreset: "go",
      webPreset: "nextjs",
      mobilePreset: "flutter",
      databasePreset: "postgresql",
      redis: true,
      dryRun: false,
    });

    const project = await readFile(resolve(root, ".sdlc/project.yaml"), "utf8");
    const lock = await readFile(resolve(root, ".sdlc/framework.lock.yaml"), "utf8");
    const permissions = await readFile(resolve(root, ".sdlc/policies/permissions.yaml"), "utf8");
    expect(project).toContain("type: multi-application");
    expect(project).toContain("primary_database: postgresql");
    expect(project).toContain("enabled: true");
    expect(project).toContain("backend_test:");
    expect(project).toContain("web_test:");
    expect(project).toContain("mobile_test:");
    expect(project).toContain("checks=");
    expect(lock).toContain("database: postgresql");
    expect(lock).toContain("redis: redis");
    expect(permissions).toContain("service/**");
    expect(permissions).toContain("web/**");
    expect(permissions).toContain("mobile/**");
    expect((await inspectProject(root)).ready).toBe(true);
  });
});
