import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function sources(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(await readFile(path, "utf8"));
    }
  }
  await visit(resolve(root, directory));
  return result;
}

describe("distribution content", () => {
  test("new runtime, assets, and skills contain only the codex-sdlc identity", async () => {
    const content = (await Promise.all([sources("src"), sources("assets"), sources("skills")])).flat().join("\n");
    expect(content).not.toContain("kai-agent-sdlc");
    expect(content).not.toContain("KAI_SDLC_NETWORK_POLICY");
    expect(content.toLowerCase()).not.toContain("fanmily");
    expect(content).not.toContain("npm run sdlc --");
  });

  test("portable plugin manifest identifies the public skills package", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("codex-sdlc");
    expect(manifest.version).toBe("0.4.0");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.extensions["com.openai"].interface.capabilities).toEqual(["Read", "Write"]);
    expect(manifest.extensions["com.openai"].interface.logo).toBe("./assets/brand/codex-sdlc.svg");
  });
});
