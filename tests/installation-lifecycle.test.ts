import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parse, stringify } from "yaml";
import { describe, expect, test } from "vitest";

import { updateAgentPolicy } from "../src/agents.js";
import { FRAMEWORK_VERSION } from "../src/constants.js";
import { initializeProject, inspectProject } from "../src/install.js";
import { rollbackProject, uninstallProject, upgradeProject } from "../src/installation-lifecycle.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-lifecycle-"));
  await mkdir(resolve(root, "web"));
  await writeFile(resolve(root, "AGENTS.md"), "# Existing instructions\n", "utf8");
  await writeFile(resolve(root, ".gitignore"), "build/\n", "utf8");
  await initializeProject({ root, projectName: "Lifecycle", applications: ["web"], webRoot: "web", webPreset: "nextjs", dryRun: false });
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

describe("installation lifecycle", () => {
  test("upgrades through a backup and rolls back the exact previous state", async () => {
    const root = await fixture();
    const frameworkPath = resolve(root, ".sdlc/framework.yaml");
    const projectPath = resolve(root, ".sdlc/project.yaml");
    const lockPath = resolve(root, ".sdlc/framework.lock.yaml");
    const blockerPath = resolve(root, ".sdlc/templates/blocker.md");
    const framework = parse(await readFile(frameworkPath, "utf8")) as Record<string, any>;
    const project = parse(await readFile(projectPath, "utf8")) as Record<string, any>;
    const lock = parse(await readFile(lockPath, "utf8")) as Record<string, any>;
    framework.framework.version = "0.1.0";
    project.framework.version = "0.1.0";
    project.commands.web_test.args = ["run", "test:ci"];
    project.agents = updateAgentPolicy(undefined, { models: ["pm=gpt-5.6-sol"], reasoning: ["pm=high"], productOwnerReview: "advisory" });
    lock.version = "0.1.0";
    await writeFile(frameworkPath, stringify(framework), "utf8");
    await writeFile(projectPath, stringify(project), "utf8");
    await writeFile(lockPath, stringify(lock), "utf8");
    await writeFile(blockerPath, "old local blocker template\n", "utf8");
    const before = {
      framework: await readFile(frameworkPath, "utf8"),
      project: await readFile(projectPath, "utf8"),
      lock: await readFile(lockPath, "utf8"),
      blocker: await readFile(blockerPath, "utf8"),
    };

    const dryRun = await upgradeProject({ root, runtimeSpec: "file:/tmp/codex-sdlc-next.tgz", dryRun: true, now: "2026-09-10T01:02:03.004Z" });
    expect(dryRun.backup_id).toBe("20260910T010203004Z-upgrade");
    expect(await exists(resolve(root, ".sdlc/backups"))).toBe(false);
    expect(await readFile(projectPath, "utf8")).toBe(before.project);

    const upgraded = await upgradeProject({ root, runtimeSpec: "file:/tmp/codex-sdlc-next.tgz", dryRun: false, now: "2026-09-10T01:02:03.004Z" });
    expect(upgraded.from_version).toBe("0.1.0");
    expect(upgraded.to_version).toBe(FRAMEWORK_VERSION);
    expect(await exists(resolve(root, ".sdlc/backups", upgraded.backup_id, "manifest.json"))).toBe(true);
    const upgradedProject = parse(await readFile(projectPath, "utf8")) as Record<string, any>;
    expect(upgradedProject.framework.version).toBe(FRAMEWORK_VERSION);
    expect(upgradedProject.commands.web_test.args).toEqual(["run", "test:ci"]);
    expect(upgradedProject.agents).toEqual(project.agents);
    const upgradedPermissions = parse(await readFile(resolve(root, ".sdlc/policies/permissions.yaml"), "utf8"));
    expect(upgradedPermissions.roles.po.write_paths).toEqual([".sdlc/runs/*/artifacts/po/**"]);
    expect(await readFile(blockerPath, "utf8")).not.toBe(before.blocker);
    expect((await inspectProject(root)).valid).toBe(true);

    const rollbackDryRun = await rollbackProject({ root, backupId: upgraded.backup_id, dryRun: true, now: "2026-09-10T02:00:00.000Z" });
    expect(rollbackDryRun.to_version).toBe("0.1.0");
    expect((parse(await readFile(projectPath, "utf8")) as Record<string, any>).framework.version).toBe(FRAMEWORK_VERSION);

    await rollbackProject({ root, backupId: upgraded.backup_id, dryRun: false, now: "2026-09-10T02:00:00.000Z" });
    expect(await readFile(frameworkPath, "utf8")).toBe(before.framework);
    expect(await readFile(projectPath, "utf8")).toBe(before.project);
    expect(await readFile(lockPath, "utf8")).toBe(before.lock);
    expect(await readFile(blockerPath, "utf8")).toBe(before.blocker);
  });

  test("uninstalls managed files while preserving project data and can roll back", async () => {
    const root = await fixture();
    await mkdir(resolve(root, ".sdlc/runs/KEEP-001"), { recursive: true });
    await writeFile(resolve(root, ".sdlc/runs/KEEP-001/marker.txt"), "keep\n", "utf8");
    await writeFile(resolve(root, ".sdlc/requests/keep.md"), "keep\n", "utf8");

    const dryRun = await uninstallProject({ root, dryRun: true, now: "2026-09-10T03:00:00.000Z" });
    expect(dryRun.backup_id).toBe("20260910T030000000Z-uninstall");
    expect(await exists(resolve(root, ".sdlc/framework.yaml"))).toBe(true);

    const uninstalled = await uninstallProject({ root, dryRun: false, now: "2026-09-10T03:00:00.000Z" });
    expect(await exists(resolve(root, ".sdlc/framework.yaml"))).toBe(false);
    expect(await exists(resolve(root, ".sdlc/runtime.cjs"))).toBe(false);
    expect(await exists(resolve(root, ".sdlc/project.yaml"))).toBe(true);
    expect(await readFile(resolve(root, ".sdlc/runs/KEEP-001/marker.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(resolve(root, ".sdlc/requests/keep.md"), "utf8")).toBe("keep\n");
    expect(await readFile(resolve(root, "AGENTS.md"), "utf8")).toBe("# Existing instructions\n");
    expect(await readFile(resolve(root, ".gitignore"), "utf8")).toBe("build/\n");

    await rollbackProject({ root, backupId: uninstalled.backup_id, dryRun: false, now: "2026-09-10T04:00:00.000Z" });
    expect(await exists(resolve(root, ".sdlc/framework.yaml"))).toBe(true);
    expect(await exists(resolve(root, ".sdlc/runtime.cjs"))).toBe(true);
    expect((await inspectProject(root)).valid).toBe(true);
  });

  test("rollback refuses to overwrite post-operation changes", async () => {
    const root = await fixture();
    const upgraded = await upgradeProject({ root, dryRun: false, now: "2026-09-10T05:00:00.000Z" });
    await writeFile(resolve(root, ".sdlc/runtime.cjs"), "changed after upgrade\n", "utf8");

    await expect(rollbackProject({ root, backupId: upgraded.backup_id, dryRun: false }))
      .rejects.toThrow("rollback would overwrite changes made after upgrade: .sdlc/runtime.cjs");
  });

  test("rollback rejects a backup manifest with an unexpected path", async () => {
    const root = await fixture();
    const upgraded = await upgradeProject({ root, dryRun: false, now: "2026-09-10T06:00:00.000Z" });
    const manifestPath = resolve(root, ".sdlc/backups", upgraded.backup_id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ path: string }> };
    manifest.entries[0]!.path = "../../outside";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(rollbackProject({ root, backupId: upgraded.backup_id, dryRun: false }))
      .rejects.toThrow(`invalid codex-sdlc backup manifest: ${upgraded.backup_id}`);
  });
});
