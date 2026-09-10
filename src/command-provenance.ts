import { relative } from "node:path";

import { resolvePathInsideRoot } from "./paths.js";
import { redactText } from "./redaction.js";
import type { CommandDefinition } from "./types.js";

export interface CanonicalCommandProvenance {
  executable: string;
  args: string[];
  cwd: string;
}

export interface CanonicalCommandDeclaration {
  cwdPath: string;
  provenance: CanonicalCommandProvenance;
}

export async function canonicalizeCommandDeclaration(
  root: string,
  command: CommandDefinition,
  secretValues: readonly string[],
): Promise<CanonicalCommandDeclaration> {
  const cwdPath = await resolvePathInsideRoot(root, command.cwd, { mustExist: true });
  const relativeCwd = relative(root, cwdPath).replaceAll("\\", "/");

  return {
    cwdPath,
    provenance: {
      executable: redactText(command.executable, secretValues),
      args: command.args.map((value) => redactText(value, secretValues)),
      cwd: redactText(relativeCwd === "" ? "." : relativeCwd, secretValues),
    },
  };
}
