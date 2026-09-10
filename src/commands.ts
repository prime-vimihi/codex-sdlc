import { once } from "node:events";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

import { SdlcPolicyError } from "./policy.js";
import type { CommandDefinition } from "./types.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function executeCommand(definition: CommandDefinition, cwd: string): Promise<CommandResult> {
  const invocation = await resolveInvocation(definition, cwd);
  const child = spawn(invocation.executable, invocation.args, {
    cwd,
    env: process.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

  const [event, value] = await Promise.race([
    once(child, "close").then(([code]) => ["close", code] as const),
    once(child, "error").then(([error]) => ["error", error] as const),
  ]);
  if (event === "error") {
    const message = value instanceof Error ? value.message : String(value);
    return { exitCode: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: `${Buffer.concat(stderr).toString("utf8")}${message}` };
  }
  return {
    exitCode: typeof value === "number" && value >= 0 ? value : 1,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

interface CommandInvocation extends Pick<CommandDefinition, "executable" | "args"> {
  windowsVerbatimArguments?: boolean;
}

async function resolveInvocation(definition: CommandDefinition, cwd: string): Promise<CommandInvocation> {
  if (process.platform !== "win32") return definition;
  const executable = await resolveWindowsExecutable(definition.executable, cwd);
  if (![".bat", ".cmd"].includes(extname(executable).toLowerCase())) {
    return { executable, args: definition.args };
  }
  const doubleEscapeMetaCharacters = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(executable);
  const shellCommand = [
    escapeWindowsCommand(executable),
    ...definition.args.map((argument) => escapeWindowsArgument(argument, doubleEscapeMetaCharacters)),
  ].join(" ");
  return {
    executable: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

const windowsMetaCharacters = /([()\][%!^"`<>&|;, *?])/gu;

function escapeWindowsCommand(command: string): string {
  return command.replace(windowsMetaCharacters, "^$1");
}

function escapeWindowsArgument(argument: string, doubleEscapeMetaCharacters: boolean): string {
  let escaped = argument.replace(/(?=(\\+?)?)\1"/gu, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/gu, "$1$1");
  escaped = `"${escaped}"`.replace(windowsMetaCharacters, "^$1");
  return doubleEscapeMetaCharacters ? escaped.replace(windowsMetaCharacters, "^$1") : escaped;
}

async function resolveWindowsExecutable(executable: string, cwd: string): Promise<string> {
  if (extname(executable) !== "") return executable;
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "");
  const hasPath = isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
  const directories = hasPath
    ? [""]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => directory.replace(/^"|"$/gu, ""));
  for (const directory of directories) {
    const base = hasPath ? resolve(cwd, executable) : join(directory, executable);
    for (const extension of extensions) {
      const candidate = `${base}${extension.toLowerCase()}`;
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue searching PATH and PATHEXT candidates.
      }
    }
  }
  return executable;
}

/**
 * Node cannot impose an OS-level network sandbox by itself. The surrounding
 * harness must attest the exact policy it enforced before this runner starts.
 * The attestation value is a comma-separated list of policies, for example
 * `disabled` or `restricted,required`.
 */
export function assertNetworkPolicyAttested(definition: CommandDefinition, environmentName: string): void {
  const policies = new Set((process.env[environmentName] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== ""));
  if (!policies.has(definition.network)) {
    throw new SdlcPolicyError(`network policy is not attested for ${definition.network} execution`);
  }
}
