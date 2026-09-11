import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";
import { describe, expect, test, vi } from "vitest";

import { configureAgents, updateAgentPolicy } from "../src/agents.js";
import { canonicalizeCommandDeclaration } from "../src/command-provenance.js";
import { loadProject } from "../src/config.js";
import { executeConfiguredCommand } from "../src/evidence.js";
import { configureRepositories, initializeProject, inspectProject } from "../src/install.js";
import { startRun } from "../src/runs.js";
import { normalizeRemoteIdentity, resolveWorkspace } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

async function gitRepository(parent: string, name: string, remote = `https://github.com/example/${name}.git`): Promise<string> {
  const root = resolve(parent, name);
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", root]);
  await execFileAsync("git", ["-C", root, "remote", "add", "origin", remote]);
  return root;
}

async function multiFixture(): Promise<{ coordinator: string; backend: string; web: string; docs: string }> {
  const parent = await mkdtemp(resolve(tmpdir(), "codex-sdlc-multi-"));
  const coordinator = await gitRepository(parent, "coordinator");
  const backend = await gitRepository(parent, "backend");
  const web = await gitRepository(parent, "web");
  const docs = await gitRepository(parent, "docs");
  await mkdir(resolve(backend, "contracts"));
  return { coordinator, backend, web, docs };
}

describe("multi-repository workspaces", () => {
  test("initializes, validates, and resolves application commands in their checkouts", async () => {
    const fixture = await multiFixture();
    await initializeProject({
      root: fixture.coordinator,
      projectName: "Distributed Example",
      agents: updateAgentPolicy(undefined, { models: ["backend=gpt-5.6-luna", "frontend=gpt-6-astra"] }),
      applications: ["backend", "web"],
      workspaceMode: "multi-repository",
      repositories: { backend: fixture.backend, web: fixture.web, docs: fixture.docs },
      backendRepository: "backend",
      backendRoot: ".",
      backendPreset: "go",
      webRepository: "web",
      webRoot: ".",
      webPreset: "nextjs",
      docsRepository: "docs",
      docsRoot: ".",
      contractsRepository: "backend",
      contractsRoot: "contracts",
      databasePreset: "postgresql",
      redis: true,
      dryRun: false,
    });

    const inspection = await inspectProject(fixture.coordinator);
    expect(inspection).toMatchObject({ valid: true, ready: true });
    const projectSource = await readFile(resolve(fixture.coordinator, ".sdlc/project.yaml"), "utf8");
    const projectDocument = parse(projectSource) as Record<string, any>;
    expect(projectDocument.schema_version).toBe(2);
    expect(projectDocument.agents.roles.frontend.model).toBe("gpt-6-astra");
    const localBefore = await readFile(resolve(fixture.coordinator, ".sdlc/local.yaml"), "utf8");
    await configureAgents({ root: fixture.coordinator, models: ["pm=gpt-5.6-sol"] });
    expect((await loadProject(fixture.coordinator)).agents?.roles.pm?.model).toBe("gpt-5.6-sol");
    expect(await readFile(resolve(fixture.coordinator, ".sdlc/local.yaml"), "utf8")).toBe(localBefore);
    expect(projectDocument.workspace).toEqual({ mode: "multi-repository", coordinator: "coordinator" });
    expect(projectDocument.applications.backend.repository).toBe("backend");
    expect(projectDocument.applications.web.repository).toBe("web");
    expect(projectDocument.resources.documentation).toEqual({ repository: "docs", root: "." });
    expect(projectDocument.commands.sdlc_test.steps.map((step: any) => step.repository)).toEqual(["backend", "web"]);

    const localSource = await readFile(resolve(fixture.coordinator, ".sdlc/local.yaml"), "utf8");
    expect(localSource).toContain(fixture.backend);
    expect(await readFile(resolve(fixture.coordinator, ".sdlc/local.example.yaml"), "utf8")).toContain("/absolute/path/to/backend");
    expect(await readFile(resolve(fixture.coordinator, ".gitignore"), "utf8")).toContain(".sdlc/local.yaml");

    const project = await loadProject(fixture.coordinator);
    const command = await canonicalizeCommandDeclaration(fixture.coordinator, project.commands.backend_test!, [], project);
    expect(command.invocations[0]).toMatchObject({ repository: "backend", cwdPath: await realpath(fixture.backend) });

    project.commands.sdlc_validate = {
      repository: "backend",
      executable: "node",
      args: ["-e", "console.log(process.cwd())"],
      cwd: ".",
      network: "disabled",
      mutates: false,
    };
    await writeFile(resolve(fixture.coordinator, ".sdlc/project.yaml"), stringify(project), "utf8");
    await writeFile(resolve(fixture.coordinator, ".sdlc/requests/distributed.md"), "Verify repository routing.\n", "utf8");
    await startRun(fixture.coordinator, {
      id: "MULTI-001",
      title: "Multi repository command evidence",
      requestFile: ".sdlc/requests/distributed.md",
      affectedApplications: { backend: true, web: false, mobile: false, database: false, sharedPackages: false },
      now: "2026-09-11T00:00:00.000Z",
    });
    vi.stubEnv("CODEX_SDLC_NETWORK_POLICY", "disabled");
    const evidence = await executeConfiguredCommand(fixture.coordinator, "MULTI-001", "PM-001", "sdlc_validate", {
      clock: (() => {
        const values = ["2026-09-11T00:00:01.000Z", "2026-09-11T00:00:02.000Z"];
        return () => values.shift()!;
      })(),
    });
    vi.unstubAllEnvs();
    expect(evidence.repository).toBe("backend");
    expect(await readFile(resolve(fixture.coordinator, `.sdlc/runs/MULTI-001/${evidence.stdout_path}`), "utf8"))
      .toContain(await realpath(fixture.backend));
  });

  test("rebinds a checkout only when its declared remote identity matches", async () => {
    const fixture = await multiFixture();
    await initializeProject({
      root: fixture.coordinator,
      projectName: "Rebind",
      applications: ["backend"],
      workspaceMode: "multi-repository",
      repositories: { backend: fixture.backend },
      backendRepository: "backend",
      backendRoot: ".",
      dryRun: false,
    });
    const parent = await mkdtemp(resolve(tmpdir(), "codex-sdlc-rebind-"));
    const replacement = await gitRepository(parent, "replacement", "git@github.com:example/backend.git");
    await configureRepositories({ root: fixture.coordinator, repositories: { backend: replacement }, dryRun: false });
    const workspace = await resolveWorkspace(fixture.coordinator, await loadProject(fixture.coordinator));
    expect(workspace.repositories.backend?.root).toBe(await realpath(replacement));

    const wrong = await gitRepository(parent, "wrong", "https://github.com/example/wrong.git");
    await expect(configureRepositories({ root: fixture.coordinator, repositories: { backend: wrong }, dryRun: false }))
      .rejects.toThrow("remote does not match");
    expect((await resolveWorkspace(fixture.coordinator, await loadProject(fixture.coordinator))).repositories.backend?.root).toBe(await realpath(replacement));
  });

  test("normalizes common GitHub SSH aliases and rejects duplicate checkout mappings", async () => {
    expect(normalizeRemoteIdentity("git@github.com-personal:prime-vimihi/codex-sdlc.git"))
      .toBe(normalizeRemoteIdentity("https://github.com/prime-vimihi/codex-sdlc"));
    const fixture = await multiFixture();
    await expect(initializeProject({
      root: fixture.coordinator,
      projectName: "Duplicate",
      applications: ["backend", "web"],
      workspaceMode: "multi-repository",
      repositories: { backend: fixture.backend, web: fixture.backend },
      backendRepository: "backend",
      webRepository: "web",
      backendRoot: ".",
      webRoot: ".",
      dryRun: true,
    })).rejects.toThrow("map to the same checkout");
  });
});
