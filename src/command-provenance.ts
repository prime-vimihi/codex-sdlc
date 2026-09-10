import { loadProject } from "./config.js";
import { redactText } from "./redaction.js";
import type { CommandDefinition, CommandStep, ProjectConfig } from "./types.js";
import { resolveWorkspace, resolveWorkspacePath } from "./workspace.js";

export interface CanonicalCommandProvenance {
  executable: string;
  args: string[];
  cwd: string;
  repository?: string;
  steps?: CanonicalCommandStepProvenance[];
}

export interface CanonicalCommandStepProvenance {
  repository: string;
  executable: string;
  args: string[];
  cwd: string;
}

export interface CanonicalCommandDeclaration {
  cwdPath: string;
  invocations: Array<{ definition: CommandStep; cwdPath: string; repository: string }>;
  provenance: CanonicalCommandProvenance;
}

export async function canonicalizeCommandDeclaration(
  root: string,
  command: CommandDefinition,
  secretValues: readonly string[],
  projectInput?: ProjectConfig,
): Promise<CanonicalCommandDeclaration> {
  const project = projectInput ?? await loadProject(root);
  const workspace = await resolveWorkspace(root, project);
  const declarations = command.steps ?? [command];
  const invocations = await Promise.all(declarations.map(async (declaration) => {
    const repository = declaration.repository ?? command.repository ?? workspace.coordinator;
    const cwdPath = await resolveWorkspacePath(workspace, repository, declaration.cwd, { mustExist: true });
    return { definition: declaration, cwdPath, repository };
  }));
  const stepProvenance = invocations.map(({ definition, repository }) => ({
    repository,
    executable: redactText(definition.executable, secretValues),
    args: definition.args.map((value) => redactText(value, secretValues)),
    cwd: redactText(definition.cwd, secretValues),
  }));
  const primaryRepository = command.repository ?? workspace.coordinator;

  return {
    cwdPath: invocations[0]!.cwdPath,
    invocations,
    provenance: {
      executable: redactText(command.executable, secretValues),
      args: command.args.map((value) => redactText(value, secretValues)),
      cwd: redactText(command.cwd, secretValues),
      ...(project.workspace?.mode === "multi-repository" ? { repository: primaryRepository } : {}),
      ...(command.steps === undefined ? {} : { steps: stepProvenance }),
    },
  };
}
