import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class SdlcPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SdlcPathError";
  }
}

export interface SafePathOptions {
  mustExist?: boolean;
}

/** Portable lexical grammar shared by repository-relative path authorities. */
export function isPortableRepositoryPath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string"
    || candidate.length === 0
    || candidate.trim() !== candidate
    || candidate !== candidate.normalize("NFC")
    || candidate.startsWith("/")
    || /^[A-Za-z]:/u.test(candidate)
    || candidate.includes("\\")) return false;
  if (candidate === ".") return true;
  return candidate.split("/").every((segment) => segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.endsWith(".")
    && !segment.endsWith(" ")
    && !/[<>:"|?*\u0000-\u001f\u007f]/u.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment));
}

export function portableRepositoryPathKey(candidate: string): string {
  if (!isPortableRepositoryPath(candidate)) throw new SdlcPathError(`invalid portable repository path: ${candidate}`);
  return candidate.normalize("NFC").toLowerCase();
}

export function portablePathContains(root: string, candidate: string): boolean {
  if (portableRepositoryPathKey(root) === ".") return true;
  const rootSegments = portableRepositoryPathKey(root).split("/");
  const candidateSegments = portableRepositoryPathKey(candidate).split("/");
  return rootSegments.length <= candidateSegments.length
    && rootSegments.every((segment, index) => segment === candidateSegments[index]);
}

export function portablePathsOverlap(left: string, right: string): boolean {
  return portablePathContains(left, right) || portablePathContains(right, left);
}

export async function resolvePathInsideRoot(root: string, candidate: string, options: SafePathOptions = {}): Promise<string> {
  if (candidate.trim() === "") {
    throw new SdlcPathError("path must not be empty");
  }
  if (candidate.split(/[\\/]+/).includes("..")) {
    throw new SdlcPathError(`path escapes repository root: ${candidate}`);
  }

  const absoluteRoot = resolve(root);
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(absoluteRoot, candidate);
  assertInside(absoluteRoot, resolved, candidate);

  const realRoot = await realpath(absoluteRoot);
  await assertExistingAncestorsInside(realRoot, absoluteRoot, resolved, candidate);
  if (options.mustExist === true) {
    try {
      const realTarget = await realpath(resolved);
      assertInside(realRoot, realTarget, candidate);
    } catch (error) {
      if (error instanceof SdlcPathError) {
        throw error;
      }
      if (isMissing(error)) {
        throw new SdlcPathError(`path does not exist inside repository root: ${candidate}`);
      }
      throw error;
    }
  }
  return resolved;
}

function assertInside(root: string, target: string, candidate: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new SdlcPathError(`path escapes repository root: ${candidate}`);
  }
}

async function assertExistingAncestorsInside(realRoot: string, absoluteRoot: string, target: string, candidate: string): Promise<void> {
  const fromRoot = relative(absoluteRoot, target);
  if (fromRoot === "") {
    return;
  }

  let current = absoluteRoot;
  for (const segment of fromRoot.split(/[\\/]+/)) {
    current = resolve(current, segment);
    try {
      await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    const realCurrent = await realpath(current);
    assertInside(realRoot, realCurrent, candidate);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
