import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "vitest";

import { initializeProject } from "../src/install.js";
import { loadRun, startRun } from "../src/runs.js";

test("a web-only run omits backend contract tasks", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-web-run-"));
  await mkdir(resolve(root, "web"));
  await initializeProject({ root, projectName: "Web", applications: ["web"], webRoot: "web", webPreset: "nextjs", dryRun: false });
  await writeFile(resolve(root, ".sdlc/requests/web.md"), "Add a web page.\n", "utf8");
  await startRun(root, {
    id: "WEBONLY-001",
    title: "Web only",
    requestFile: ".sdlc/requests/web.md",
    affectedApplications: { backend: false, web: true, mobile: false, database: false, sharedPackages: false },
    now: "2026-09-10T00:00:00.000Z",
  });

  const tasks = (await loadRun(root, "WEBONLY-001")).tasks;
  expect(tasks.some((task) => task.id === "WEB-001")).toBe(true);
  expect(tasks.some((task) => task.id === "BE-001" || task.id === "PM-003")).toBe(false);
  expect(tasks.find((task) => task.id === "WEB-001")?.dependencies).toEqual(["PM-002"]);
  expect((await loadRun(root, "WEBONLY-001")).quality_gates.api_contract?.status).toBe("not_applicable");
});

test("a mobile-only run omits backend contract tasks", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-mobile-run-"));
  await mkdir(resolve(root, "mobile"));
  await initializeProject({ root, projectName: "Mobile", applications: ["mobile"], mobileRoot: "mobile", mobilePreset: "flutter", dryRun: false });
  await writeFile(resolve(root, ".sdlc/requests/mobile.md"), "Add a mobile screen.\n", "utf8");
  await startRun(root, {
    id: "MOBILEONLY-001",
    title: "Mobile only",
    requestFile: ".sdlc/requests/mobile.md",
    affectedApplications: { backend: false, web: false, mobile: true, database: false, sharedPackages: false },
    now: "2026-09-10T00:00:00.000Z",
  });

  const tasks = (await loadRun(root, "MOBILEONLY-001")).tasks;
  expect(tasks.some((task) => task.id === "MOB-001")).toBe(true);
  expect(tasks.some((task) => task.id === "BE-001" || task.id === "PM-003")).toBe(false);
  expect(tasks.find((task) => task.id === "MOB-001")?.dependencies).toEqual(["PM-002"]);
  expect((await loadRun(root, "MOBILEONLY-001")).quality_gates.api_contract?.status).toBe("not_applicable");
});

test("a combined run coordinates all application implementations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "codex-sdlc-combined-run-"));
  await Promise.all([
    mkdir(resolve(root, "service")),
    mkdir(resolve(root, "web")),
    mkdir(resolve(root, "mobile")),
  ]);
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
  await writeFile(resolve(root, ".sdlc/requests/combined.md"), "Add a combined feature.\n", "utf8");
  await startRun(root, {
    id: "COMBINED-001",
    title: "Combined",
    requestFile: ".sdlc/requests/combined.md",
    affectedApplications: { backend: true, web: true, mobile: true, database: true, sharedPackages: false },
    now: "2026-09-10T00:00:00.000Z",
  });

  const tasks = (await loadRun(root, "COMBINED-001")).tasks;
  expect((await loadRun(root, "COMBINED-001")).quality_gates.api_contract?.status).toBe("pending");
  for (const taskId of ["BE-001", "PM-003", "BE-002", "WEB-001", "MOB-001"]) {
    expect(tasks.some((task) => task.id === taskId)).toBe(true);
  }
  for (const taskId of ["BE-002", "WEB-001", "MOB-001"]) {
    expect(tasks.find((task) => task.id === taskId)?.dependencies).toEqual(["PM-002", "PM-003"]);
  }
  expect(tasks.find((task) => task.id === "INT-001")?.dependencies).toEqual(["BE-002", "WEB-001", "MOB-001"]);
});
