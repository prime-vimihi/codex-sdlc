export interface CliGrammarDiagnostic { message: string }

type CommandGrammar = {
  positionals: number;
  requiredOptions: readonly string[];
  optionalOptions?: readonly string[];
  repeatableOptions?: readonly string[];
  flagOptions?: readonly string[];
};

export const cliGrammar: Readonly<Record<string, CommandGrammar>> = {
  init: {
    positionals: 0,
    requiredOptions: ["--name"],
    optionalOptions: ["--root", "--applications", "--backend-root", "--web-root", "--mobile-root", "--workspace-mode", "--backend-repo", "--web-repo", "--mobile-repo", "--docs-repo", "--docs-root", "--contracts-repo", "--contracts-root", "--backend-preset", "--web-preset", "--mobile-preset", "--database-preset", "--runtime-spec", "--po-review"],
    repeatableOptions: ["--repo", "--agent-model", "--agent-reasoning", "--agent-fallback"],
    flagOptions: ["--redis", "--dry-run"],
  },
  configure: { positionals: 0, requiredOptions: ["--repo"], optionalOptions: ["--root"], repeatableOptions: ["--repo"], flagOptions: ["--dry-run"] },
  "configure-agents": { positionals: 0, requiredOptions: [], optionalOptions: ["--root", "--po-review"], repeatableOptions: ["--agent-model", "--agent-reasoning", "--agent-fallback", "--reset-role"], flagOptions: ["--dry-run"] },
  "agent-plan": { positionals: 2, requiredOptions: [] },
  "agent-dispatch": { positionals: 2, requiredOptions: [] },
  doctor: { positionals: 0, requiredOptions: [], optionalOptions: ["--root"] },
  upgrade: { positionals: 0, requiredOptions: [], optionalOptions: ["--root", "--runtime-spec"], flagOptions: ["--dry-run"] },
  rollback: { positionals: 0, requiredOptions: [], optionalOptions: ["--root", "--backup"], flagOptions: ["--dry-run"] },
  uninstall: { positionals: 0, requiredOptions: [], optionalOptions: ["--root"], flagOptions: ["--dry-run"] },
  "validate-config": { positionals: 0, requiredOptions: [] },
  start: { positionals: 0, requiredOptions: ["--id", "--title", "--request", "--applications"] },
  ready: { positionals: 1, requiredOptions: [] },
  transition: { positionals: 3, requiredOptions: ["--actor", "--reason"], optionalOptions: ["--resolve-blocker", "--retry-reason", "--decision"] },
  "validate-run": { positionals: 1, requiredOptions: [] },
  "publish-authority": {
    positionals: 1,
    requiredOptions: ["--actor", "--expected-version"],
  },
  evidence: { positionals: 3, requiredOptions: [] },
  finalize: { positionals: 1, requiredOptions: ["--actor"] },
  "quality-gate": { positionals: 3, requiredOptions: ["--actor", "--reason"], repeatableOptions: ["--evidence"] },
  "approval-request": { positionals: 3, requiredOptions: ["--id", "--actor", "--topic"] },
  "approval-decision": { positionals: 3, requiredOptions: ["--approver", "--decision"] },
  "product-owner-decision": { positionals: 2, requiredOptions: ["--actor", "--comments"] },
};

/** Parse-only grammar shared by the real CLI and semantic command plans. */
export function validateCliArguments(arguments_: readonly string[]): CliGrammarDiagnostic[] {
  const diagnostics: CliGrammarDiagnostic[] = [];
  const tokens = [...arguments_];
  const commandIndex = tokens.findIndex((token) => token !== "--json");
  if (commandIndex === -1) return [{ message: "a command is required" }];
  if (tokens.slice(0, commandIndex).some((token) => token !== "--json")) return [{ message: "unexpected token before command" }];
  const commandName = tokens[commandIndex];
  const grammar = cliGrammar[commandName];
  if (grammar === undefined) return [{ message: `invented subcommand ${commandName}` }];

  let index = commandIndex + 1;
  let positionalCount = 0;
  while (index < tokens.length && !tokens[index].startsWith("--")) {
    positionalCount += 1;
    index += 1;
  }
  if (positionalCount !== grammar.positionals) diagnostics.push({ message: `${commandName} expected ${grammar.positionals} positional arguments but received ${positionalCount}` });

  const required = new Set(grammar.requiredOptions);
  const flags = new Set(grammar.flagOptions ?? []);
  const allowed = new Set([...grammar.requiredOptions, ...(grammar.optionalOptions ?? []), ...(grammar.repeatableOptions ?? []), ...flags, "--json"]);
  const repeatable = new Set(grammar.repeatableOptions ?? []);
  const seen = new Set<string>();
  while (index < tokens.length) {
    const option = tokens[index];
    if (!option.startsWith("--")) {
      diagnostics.push({ message: `${commandName} received unexpected argument ${option}` });
      index += 1;
      continue;
    }
    if (!allowed.has(option)) {
      diagnostics.push({ message: `${commandName} invented option ${option}` });
      index += 1;
      continue;
    }
    if (seen.has(option) && !repeatable.has(option)) diagnostics.push({ message: `${commandName} repeats option ${option}` });
    seen.add(option);
    if (option === "--json" || flags.has(option)) {
      index += 1;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      diagnostics.push({ message: `${commandName} missing value for ${option}` });
      index += 1;
      continue;
    }
    index += 2;
  }
  for (const option of required) if (!seen.has(option)) diagnostics.push({ message: `${commandName} missing required option ${option}` });
  return diagnostics;
}
