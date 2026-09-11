import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build/marketplace");
const plugin = resolve(output, "plugins/codex-sdlc");
const marketplaceManifest = resolve(output, ".agents/plugins/marketplace.json");

await rm(output, { recursive: true, force: true });
await mkdir(plugin, { recursive: true });
await cp(resolve(root, "plugin.json"), resolve(plugin, "plugin.json"));
await cp(resolve(root, ".codex-plugin"), resolve(plugin, ".codex-plugin"), { recursive: true });
await cp(resolve(root, "skills"), resolve(plugin, "skills"), { recursive: true });
await cp(resolve(root, "assets/brand"), resolve(plugin, "assets/brand"), { recursive: true });
await writeFile(resolve(plugin, "README.md"), await readFile(resolve(root, "README.md"), "utf8"), "utf8");
await mkdir(resolve(plugin, "docs"), { recursive: true });
await writeFile(resolve(plugin, "docs/getting-started.md"), await readFile(resolve(root, "docs/getting-started.md"), "utf8"), "utf8");
await mkdir(dirname(marketplaceManifest), { recursive: true });
await writeFile(marketplaceManifest, `${JSON.stringify({
  name: "codex-sdlc-local",
  interface: { displayName: "codex-sdlc local development" },
  plugins: [{
    name: "codex-sdlc",
    source: { source: "local", path: "./plugins/codex-sdlc" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  }],
}, null, 2)}\n`, "utf8");

process.stdout.write(`${output}\n`);
