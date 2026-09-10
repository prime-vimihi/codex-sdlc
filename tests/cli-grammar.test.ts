import { describe, expect, test } from "vitest";

import { validateCliArguments } from "../src/cli-grammar.js";

describe("CLI grammar", () => {
  test("accepts setup operations", () => {
    expect(validateCliArguments(["init", "--name", "Example", "--root", ".", "--backend-root", "service", "--dry-run"])).toEqual([]);
    expect(validateCliArguments(["init", "--name", "Combined", "--applications", "backend,web,mobile", "--backend-preset", "go", "--web-preset", "nextjs", "--mobile-preset", "flutter", "--database-preset", "postgresql", "--redis"])).toEqual([]);
    expect(validateCliArguments(["init", "--name", "Distributed", "--workspace-mode", "multi-repository", "--repo", "backend=/src/backend", "--repo", "web=/src/web", "--backend-repo", "backend", "--web-repo", "web", "--docs-repo", "web", "--docs-root", "docs"])).toEqual([]);
    expect(validateCliArguments(["configure", "--root", ".", "--repo", "backend=/new/backend", "--dry-run"])).toEqual([]);
    expect(validateCliArguments(["doctor", "--root", "."])).toEqual([]);
    expect(validateCliArguments(["upgrade", "--root", ".", "--runtime-spec", "codex-sdlc@0.3.0", "--dry-run"])).toEqual([]);
    expect(validateCliArguments(["rollback", "--root", ".", "--backup", "20260910T000000000Z-upgrade", "--dry-run"])).toEqual([]);
    expect(validateCliArguments(["uninstall", "--root", ".", "--dry-run"])).toEqual([]);
  });

  test("rejects invented setup options", () => {
    expect(validateCliArguments(["init", "--name", "Example", "--force"]).map((entry) => entry.message))
      .toContain("init invented option --force");
  });
});
