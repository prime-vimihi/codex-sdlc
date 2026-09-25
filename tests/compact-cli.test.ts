import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.js";
import { initializeProject } from "../src/install.js";
import { loadRun } from "../src/runs.js";

const roots: string[] = [];
const assessment = {
  bounded_scope: true, existing_patterns: true, migrations: false, breaking_api: false,
  authorization_changes: false, sensitive_data_exposure: false, cross_system_uncertainty: false,
  rationale: "A bounded display update using the existing data and authorization patterns.",
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "sdlc-compact-cli-")); roots.push(root);
  await initializeProject({ root, projectName: "Compact CLI fixture", applications: ["web"], webRoot: ".", webPreset: "nextjs", dryRun: false });
  await writeFile(resolve(root, ".sdlc/requests/change.md"), "Update the existing display using its established permissions.\n");
  await writeFile(resolve(root, ".sdlc/requests/assessment.json"), JSON.stringify(assessment));
  return root;
}

async function invoke(root: string, args: string[]) {
  const chunks: string[] = [];
  const exit = process.exitCode;
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  try { const code = await main([...args, "--json"]); return { code, body: JSON.parse(chunks.join("")) }; }
  finally { cwd.mockRestore(); stdout.mockRestore(); process.exitCode = exit; }
}
function start(id: string, extra: string[] = []) { return ["start", "--id", id, "--title", "Display change", "--request", ".sdlc/requests/change.md", "--applications", "web", ...extra]; }

test("Full stays default; Compact is explicit per run and leaves project settings and old runs unchanged", async () => {
  const root = await fixture();
  const projectBefore = await readFile(resolve(root, ".sdlc/project.yaml"), "utf8");
  expect((await invoke(root, start("FULL-001"))).code).toBe(0);
  const fullBefore = await readFile(resolve(root, ".sdlc/runs/FULL-001/manifest.yaml"), "utf8");
  const result = await invoke(root, start("SMALL-001", ["--profile", "compact", "--assessment", ".sdlc/requests/assessment.json"]));
  expect(result.code).toBe(0);
  expect(result.body.result.profile).toBe("compact");
  expect((await loadRun(root, "SMALL-001")).workflow_profile?.assessment).toEqual(assessment);
  expect((await loadRun(root, "FULL-001")).workflow_profile).toBeUndefined();
  expect(await readFile(resolve(root, ".sdlc/runs/FULL-001/manifest.yaml"), "utf8")).toBe(fullBefore);
  expect(await readFile(resolve(root, ".sdlc/project.yaml"), "utf8")).toBe(projectBefore);
});

test.each([
  ["missing assessment", ["--profile", "compact"], undefined],
  ["unknown profile", ["--profile", "quick"], undefined],
  ["assessment on Full", ["--profile", "full", "--assessment", ".sdlc/requests/assessment.json"], undefined],
  ["unsafe scope", ["--profile", "compact", "--assessment", ".sdlc/requests/assessment.json"], JSON.stringify({ ...assessment, migrations: true })],
  ["ambiguous JSON", ["--profile", "compact", "--assessment", ".sdlc/requests/assessment.json"], '{"bounded_scope":true,"bounded_scope":false}'],
  ["unknown assessment field", ["--profile", "compact", "--assessment", ".sdlc/requests/assessment.json"], JSON.stringify({ ...assessment, skip_qc: true })],
] as const)("invalid Compact selection (%s) creates no run", async (_name, args, source) => {
  const root = await fixture();
  if (source !== undefined) await writeFile(resolve(root, ".sdlc/requests/assessment.json"), source);
  const result = await invoke(root, start("INVALID-001", [...args]));
  expect(result.code).not.toBe(0);
  expect(result.body.ok).toBe(false);
  expect(await readdir(resolve(root, ".sdlc/runs"))).toEqual([]);
});
