import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { stringify } from "yaml";

import { validateChangedFilesAuthorityDocument } from "./changed-files-authority.js";
import { loadProject } from "./config.js";
import { isPortableRepositoryPath, portableRepositoryPathKey, resolvePathInsideRoot } from "./paths.js";
import {
  acquireRunAuthorityLock,
  releaseRunAuthorityLock,
  type RunAuthorityLockOptions,
} from "./run-authority-lock.js";
import { loadRunSnapshotUnderLock, validateRunSnapshotUnderLock } from "./runs.js";
import { parseStrictYamlDocument, structuredDocumentRevision } from "./semantic-contracts.js";
import { validateDocument } from "./schemas.js";
import type { RunManifest } from "./types.js";

export interface ManifestTransactionOptions extends RunAuthorityLockOptions {
  /** Test-only hook for deterministic cleanup coverage after the temp write. */
  beforeReplace?: (manifestPath: string, temporaryPath: string) => Promise<void> | void;
  /** Test-only hook after publication and before the final repository validation. */
  beforeRelease?: () => Promise<void> | void;
  lockTimeoutMs?: number;
  staleLockThresholdMs?: number;
  lockToken?: string;
  now?: () => string;
  /** Test-only signal emitted after observing another live lock owner. */
  onLockWait?: () => void;
}

export interface ManifestTransactionResult<T> {
  manifest: RunManifest;
  value: T;
  authorityVersion: number;
}

export interface RunAuthorityPublication {
  /** Canonical path relative to .sdlc/runs/<run-id>. */
  path: string;
  source: string;
}

export interface RunAuthorityPublicationOptions extends Pick<ManifestTransactionOptions,
  "lockTimeoutMs" | "staleLockThresholdMs" | "lockToken" | "now" | "onLockWait"> {
  expectedVersion: number;
  /** Test-only hook after replacements and before repository validation. */
  beforeRelease?: () => Promise<void> | void;
  /** Test-only hook immediately before removing external staging bytes. */
  beforeStagingCleanup?: () => Promise<void> | void;
}

export interface RunAuthorityPublicationResult {
  authorityVersion: number;
}

/**
 * Serializes all run-manifest mutations. The manifest is loaded only after the
 * per-run lock is held, then written via a same-directory temporary file and
 * atomic replacement. This is intentionally reusable by later workflow tasks.
 */
export async function mutateRunManifest<T>(
  root: string,
  runId: string,
  mutate: (manifest: RunManifest) => Promise<T> | T,
  options: ManifestTransactionOptions = {},
): Promise<ManifestTransactionResult<T>> {
  return mutateRunManifestInternal(root, runId, mutate, options);
}

async function mutateRunManifestInternal<T>(
  root: string,
  runId: string,
  mutate: (manifest: RunManifest) => Promise<T> | T,
  options: ManifestTransactionOptions = {},
): Promise<ManifestTransactionResult<T>> {
  await resolvePathInsideRoot(root, `.sdlc/runs/${runId}`, { mustExist: true });
  const lock = await acquireRunAuthorityLock(root, runId, options);
  try {
    const authorityVersion = await readAuthorityVersion(root, runId);
    const snapshot = await loadRunSnapshotUnderLock(root, runId, true, lock);
    const manifest = structuredClone(snapshot.manifest);
    const value = await mutate(manifest);
    const validation = validateDocument("run", manifest);
    if (!validation.valid) {
      throw new Error(`updated manifest is invalid: ${validation.diagnostics.join("; ")}`);
    }
    const manifestSource = stringify(manifest, { aliasDuplicateObjects: false });
    const authorityIdentity = await captureAuthorityIdentity(root, runId);
    const structuredValidation = await validateRunSnapshotUnderLock(root, runId, { manifest, manifestSource }, true, lock);
    if (!structuredValidation.valid) {
      throw new Error(`updated run authority is invalid: ${structuredValidation.diagnostics.join("; ")}`);
    }
    await assertAuthorityIdentityUnchanged(root, runId, authorityIdentity);
    const manifestPath = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/manifest.yaml`, { mustExist: true });
    await persistAtomically(manifestPath, snapshot.manifestSource, manifestSource, options, async () => {
      await assertAuthorityIdentityUnchanged(root, runId, authorityIdentity);
    }, async () => {
      const publishedSnapshot = await loadRunSnapshotUnderLock(root, runId, true, lock);
      if (publishedSnapshot.manifestSource !== manifestSource) {
        throw new Error("published manifest identity changed after publication");
      }
      const publishedValidation = await validateRunSnapshotUnderLock(root, runId, publishedSnapshot, true, lock);
      if (!publishedValidation.valid) {
        throw new Error(`published run authority is invalid: ${publishedValidation.diagnostics.join("; ")}`);
      }
      await assertAuthorityIdentityUnchanged(root, runId, authorityIdentity);
      await assertAuthorityVersion(root, runId, authorityVersion);
      await writeAuthorityVersion(root, runId, authorityVersion + 1);
    }, async () => {
      const rollbackSnapshot = await loadRunSnapshotUnderLock(root, runId, true, lock);
      if (rollbackSnapshot.manifestSource !== snapshot.manifestSource) {
        throw new Error("rollback manifest identity does not match the prior manifest");
      }
      const rollbackValidation = await validateRunSnapshotUnderLock(root, runId, rollbackSnapshot, true, lock);
      if (!rollbackValidation.valid) {
        throw new Error(`rolled-back run authority is invalid: ${rollbackValidation.diagnostics.join("; ")}`);
      }
    });
    return { manifest, value, authorityVersion: authorityVersion + 1 };
  } finally {
    await releaseRunAuthorityLock(lock);
  }
}

/**
 * Publishes one complete authority package under the same per-run lock and
 * monotonic version used by manifest mutations.
 */
export async function publishRunAuthority(
  root: string,
  runId: string,
  publications: readonly RunAuthorityPublication[],
  options: RunAuthorityPublicationOptions,
): Promise<RunAuthorityPublicationResult> {
  if (publications.length === 0) throw new Error("authority publication requires at least one file");
  if (!Number.isSafeInteger(options?.expectedVersion) || options.expectedVersion < 0) {
    throw new Error("authority publication requires an expected authority version");
  }
  const runDirectory = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}`, { mustExist: true });
  const lock = await acquireRunAuthorityLock(root, runId, options);
  let stagingDirectory: string | undefined;
  try {
    const authorityVersion = await readAuthorityVersion(root, runId);
    if (options.expectedVersion !== authorityVersion) {
      throw new Error(`stale authority version: expected ${options.expectedVersion} but actual ${authorityVersion}`);
    }
    assertPublicationPaths(publications);
    await assertNoExistingPortableAliases(runDirectory, publications);
    // A newer runtime may make an existing authority document semantically
    // stale. Publication must still be able to replace that document, so the
    // preflight validates the manifest and run graph without reconciling the
    // structured delivery documents that are about to be repaired. The final
    // published snapshot below is still subject to full structured validation.
    const snapshot = await loadRunSnapshotUnderLock(root, runId, false, lock);
    const project = publications.some((publication) => portableRepositoryPathKey(publication.path) === "evidence/diffs/changed-files.json")
      ? await loadProject(root)
      : undefined;
    for (const publication of publications) {
      await validatePublicationSource(root, runId, snapshot.manifest, project, publication);
    }

    stagingDirectory = await mkdtemp(join(dirname(runDirectory), `${runId}.authority-staging-`));
    const states: PublicationState[] = [];
    for (const publication of publications) {
      const stagedPath = join(stagingDirectory, ...publication.path.split("/"));
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, publication.source, { encoding: "utf8", flag: "wx" });
      const destination = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${publication.path}`);
      states.push({ publication, stagedPath, destination, previousSource: await readOptionalRegularFile(destination), replaced: false, createdDirectories: [] });
    }

    try {
      for (const state of states) {
        state.createdDirectories = await ensureParentDirectories(runDirectory, dirname(state.destination));
        await rename(state.stagedPath, state.destination);
        state.replaced = true;
      }
      await options.beforeRelease?.();
      const snapshot = await loadRunSnapshotUnderLock(root, runId, true, lock);
      const validation = await validateRunSnapshotUnderLock(root, runId, snapshot, true, lock);
      if (!validation.valid) throw new Error(`published run authority is invalid: ${validation.diagnostics.join("; ")}`);
      await assertAuthorityVersion(root, runId, authorityVersion);
      await options.beforeStagingCleanup?.();
      await rm(stagingDirectory, { recursive: true, force: true });
      stagingDirectory = undefined;
      await writeAuthorityVersion(root, runId, authorityVersion + 1);
      return { authorityVersion: authorityVersion + 1 };
    } catch (error) {
      try {
        await rollbackPublications(states);
        // The prior snapshot may be the semantically stale state this
        // publication was repairing. Verify that rollback restored a valid
        // base run; byte restoration is enforced by rollbackPublications.
        const rollbackSnapshot = await loadRunSnapshotUnderLock(root, runId, false, lock);
        const rollbackValidation = await validateRunSnapshotUnderLock(root, runId, rollbackSnapshot, false, lock);
        if (!rollbackValidation.valid) throw new Error(`rolled-back run authority is invalid: ${rollbackValidation.diagnostics.join("; ")}`);
        await assertAuthorityVersion(root, runId, authorityVersion);
      } catch (rollbackError) {
        throw new Error(`authority publication failed (${errorMessage(error)}) and rollback failed: ${errorMessage(rollbackError)}`);
      }
      throw error;
    }
  } finally {
    try {
      if (stagingDirectory !== undefined) {
        await options.beforeStagingCleanup?.();
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    } finally {
      await releaseRunAuthorityLock(lock);
    }
  }
}

interface PublicationState {
  publication: RunAuthorityPublication;
  stagedPath: string;
  destination: string;
  previousSource: string | undefined;
  replaced: boolean;
  createdDirectories: string[];
}

function assertPublicationPaths(publications: readonly RunAuthorityPublication[]): void {
  const identities = new Set<string>();
  for (const publication of publications) {
    if (!isPortableRepositoryPath(publication.path)
      || publication.path === "manifest.yaml"
      || publication.path.startsWith(".sdlc-")) {
      throw new Error(`invalid authority publication path: ${publication.path}`);
    }
    assertCanonicalPublicationCase(publication.path);
    const identity = portableRepositoryPathKey(publication.path);
    if (identities.has(identity)) throw new Error(`authority publication contains duplicate portable path identity: ${publication.path}`);
    identities.add(identity);
  }
}

function assertCanonicalPublicationCase(path: string): void {
  const identity = portableRepositoryPathKey(path);
  const canonicalDocuments = new Set([
    "facts.yaml",
    "scope.md",
    "assumptions.md",
    "final-report.md",
    "request.md",
    "artifacts/ba/semantic-claims.yaml",
    "artifacts/backend/openapi.yaml",
    "evidence/diffs/changed-files.json",
  ]);
  if (canonicalDocuments.has(identity) && path !== identity) {
    throw new Error(`authority publication path is not canonical case: ${path}`);
  }
  const extension = /\.(?:ya?ml|json|md)$/u.exec(identity)?.[0];
  if (extension !== undefined && !path.endsWith(extension)) {
    throw new Error(`authority publication path is not canonical case: ${path}`);
  }
  const segments = path.split("/");
  const fixedDirectories = new Set(["tasks", "artifacts", "pm", "ba", "backend", "web", "mobile", "integration", "qc", "evidence", "diffs", "commands"]);
  for (const segment of segments.slice(0, -1)) {
    const canonical = segment.toLowerCase();
    if (fixedDirectories.has(canonical) && segment !== canonical) {
      throw new Error(`authority publication path is not canonical case: ${path}`);
    }
  }
  if (identity.endsWith("/evidence.json") && !path.endsWith("/evidence.json")) {
    throw new Error(`authority publication path is not canonical case: ${path}`);
  }
  if (/^tasks\/[a-z][a-z0-9]*-[0-9]+\.assignment\.yaml$/u.test(identity)
    && !/^tasks\/[A-Z][A-Z0-9]*-[0-9]+\.assignment\.yaml$/u.test(path)) {
    throw new Error(`authority publication path is not canonical case: ${path}`);
  }
  if (/^artifacts\/(?:backend|web|mobile)\/[a-z][a-z0-9]*-[0-9]+-delivery-report\.yaml$/u.test(identity)
    && !/^artifacts\/(?:backend|web|mobile)\/[A-Z][A-Z0-9]*-[0-9]+-delivery-report\.yaml$/u.test(path)) {
    throw new Error(`authority publication path is not canonical case: ${path}`);
  }
}

async function assertNoExistingPortableAliases(
  runDirectory: string,
  publications: readonly RunAuthorityPublication[],
): Promise<void> {
  const existing = new Map<string, string>();
  await collectPortableEntries(runDirectory, runDirectory, existing);
  for (const publication of publications) {
    const pathSegments = publication.path.split("/");
    for (let index = 1; index <= pathSegments.length; index += 1) {
      const prefix = pathSegments.slice(0, index).join("/");
      const prior = existing.get(portableRepositoryPathKey(prefix));
      if (prior !== undefined && prior !== prefix) {
        throw new Error(`authority publication path is a portable case alias of ${prior}: ${publication.path}`);
      }
    }
  }
}

async function collectPortableEntries(directory: string, runDirectory: string, entries: Map<string, string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(runDirectory, absolute).replaceAll("\\", "/");
    if (!isPortableRepositoryPath(path)) continue;
    const identity = portableRepositoryPathKey(path);
    const prior = entries.get(identity);
    if (prior !== undefined && prior !== path) throw new Error(`active run contains portable path aliases: ${prior}, ${path}`);
    entries.set(identity, path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await collectPortableEntries(absolute, runDirectory, entries);
  }
}

async function validatePublicationSource(
  root: string,
  runId: string,
  manifest: RunManifest,
  project: Awaited<ReturnType<typeof loadProject>> | undefined,
  publication: RunAuthorityPublication,
): Promise<void> {
  const { path, source } = publication;
  const identity = portableRepositoryPathKey(path);
  if (identity.endsWith(".yaml") || identity.endsWith(".yml")) {
    const value = parseStrictYamlDocument(source);
    if (!isRecord(value)) throw new Error(`${path} must contain a YAML mapping`);
    if (identity === "facts.yaml") {
      assertSchema("facts", value, "facts publication");
      if (value.run_id !== runId || value.producer !== "pm") throw new Error(`facts publication identity does not match run ${runId}`);
      return;
    }
    if (identity === "artifacts/ba/semantic-claims.yaml") {
      assertSchema("semanticClaims", value, "semantic-claims publication");
      if (value.run_id !== runId || value.task_id !== "BA-001" || value.producer !== "ba") {
        throw new Error(`semantic-claims publication identity does not match run ${runId}`);
      }
      return;
    }
    if (identity === "artifacts/backend/openapi.yaml") {
      assertSchema("openapi", value, "OpenAPI publication");
      const metadata = value["x-sdlc-metadata"] as Record<string, unknown>;
      const taskId = metadata.task_id as string;
      const task = manifest.tasks.find((candidate) => candidate.id === taskId);
      if (metadata.run_id !== runId || metadata.producer !== "backend"
        || task === undefined || task.role !== "backend" || task.target !== "backend" || task.stage !== "api_contract"
        || !task.required_outputs.includes(identity)) {
        throw new Error(`OpenAPI publication identity does not match canonical authority for run ${runId}`);
      }
      return;
    }
    const assignment = /^tasks\/([A-Z][A-Z0-9]*-[0-9]+)\.assignment\.yaml$/u.exec(path);
    if (assignment !== null) {
      assertSchema("deliveryAssignment", value, "delivery assignment publication");
      if (value.run_id !== runId || value.task_id !== assignment[1]) throw new Error(`delivery assignment publication identity does not match ${runId}/${assignment[1]}`);
      return;
    }
    const report = /^artifacts\/(backend|web|mobile)\/([A-Z][A-Z0-9]*-[0-9]+)-delivery-report\.yaml$/u.exec(path);
    if (report !== null) {
      assertSchema("deliveryReport", value, "delivery report publication");
      if (value.run_id !== runId || value.task_id !== report[2] || value.target !== report[1]) {
        throw new Error(`delivery report publication identity does not match ${runId}/${report[2]}`);
      }
      return;
    }
    if (structuredDocumentRevision(value, path) === undefined) throw new Error(`${path} must declare a positive revision`);
    return;
  }
  if (identity.endsWith(".json")) {
    const strictValue = parseStrictYamlDocument(source);
    let value: unknown;
    try { value = JSON.parse(source) as unknown; } catch (error) {
      throw new Error(`${path} is invalid JSON: ${errorMessage(error)}`);
    }
    if (JSON.stringify(strictValue) !== JSON.stringify(value)) throw new Error(`${path} is not canonical strict JSON`);
    if (identity.endsWith("/evidence.json")) assertSchema("evidence", value, "evidence publication");
    if (identity === "evidence/diffs/changed-files.json") {
      if (project === undefined) throw new Error("changed-files publication requires project authority");
      await validateChangedFilesAuthorityDocument(root, value, manifest, project);
    }
    return;
  }
  if (identity.endsWith(".md") && identity !== "request.md") {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
    if (frontmatter === null) throw new Error(`${path} must contain strict YAML frontmatter`);
    const value = parseStrictYamlDocument(frontmatter[1]);
    if (structuredDocumentRevision(value, path) === undefined) {
      throw new Error(`${path} must declare a positive revision`);
    }
  }
}

async function readOptionalRegularFile(path: string): Promise<string | undefined> {
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error(`authority publication target is not a regular file: ${path}`);
    return readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function ensureParentDirectories(runDirectory: string, parent: string): Promise<string[]> {
  const missing: string[] = [];
  let current = parent;
  while (current !== runDirectory) {
    try {
      const information = await lstat(current);
      if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`authority publication parent is not a safe directory: ${current}`);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(current);
      current = dirname(current);
    }
  }
  const created: string[] = [];
  for (const directory of missing.reverse()) {
    await mkdir(directory);
    created.push(directory);
  }
  return created;
}

async function rollbackPublications(states: readonly PublicationState[]): Promise<void> {
  const failures: string[] = [];
  for (const state of [...states].reverse()) {
    try {
      if (state.replaced) {
        if (state.previousSource === undefined) await rm(state.destination, { force: true });
        else await replaceAtomically(state.destination, state.previousSource);
      }
    } catch (error) {
      failures.push(`${state.publication.path}: ${errorMessage(error)}`);
    }
    for (const directory of [...state.createdDirectories].reverse()) {
      try { await rmdir(directory); } catch (error) {
        if (!isMissing(error)) failures.push(`${directory}: ${errorMessage(error)}`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`unable to restore all authority destinations: ${failures.join("; ")}`);
}

const authorityVersionFile = ".sdlc-authority-version.json";

async function readAuthorityVersion(root: string, runId: string): Promise<number> {
  const path = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${authorityVersionFile}`);
  let source: string;
  try { source = await readFile(path, "utf8"); } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source) as unknown; } catch (error) {
    throw new Error(`run authority version is invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "schema_version,version"
    || value.schema_version !== 1
    || !Number.isInteger(value.version)
    || Number(value.version) < 0) throw new Error("run authority version is invalid");
  return Number(value.version);
}

async function assertAuthorityVersion(root: string, runId: string, expected: number): Promise<void> {
  const actual = await readAuthorityVersion(root, runId);
  if (actual !== expected) throw new Error(`run authority version changed during transaction: expected ${expected} but actual ${actual}`);
}

async function writeAuthorityVersion(root: string, runId: string, version: number): Promise<void> {
  const path = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/${authorityVersionFile}`);
  await replaceAtomically(path, `${JSON.stringify({ schema_version: 1, version })}\n`);
}

function assertSchema(name: "facts" | "semanticClaims" | "openapi" | "deliveryAssignment" | "deliveryReport" | "evidence", value: unknown, label: string): void {
  const validation = validateDocument(name, value);
  if (!validation.valid) throw new Error(`${label} is invalid: ${validation.diagnostics.join("; ")}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function persistAtomically(
  manifestPath: string,
  previousManifestSource: string,
  manifestSource: string,
  options: ManifestTransactionOptions,
  assertAuthorityUnchanged: () => Promise<void>,
  validatePublishedManifest: () => Promise<void>,
  validateRolledBackManifest: () => Promise<void>,
): Promise<void> {
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    await writeFile(temporaryPath, manifestSource, { encoding: "utf8", flag: "wx" });
    await options.beforeReplace?.(manifestPath, temporaryPath);
    await assertAuthorityUnchanged();
    await rename(temporaryPath, manifestPath);
    replaced = true;
    await options.beforeRelease?.();
    await validatePublishedManifest();
  } catch (error) {
    if (replaced) {
      try {
        await replaceAtomically(manifestPath, previousManifestSource);
        await validateRolledBackManifest();
      } catch (rollbackError) {
        throw new Error(`manifest publication failed (${errorMessage(error)}) and rollback failed: ${errorMessage(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    if (!replaced) await rm(temporaryPath, { force: true });
  }
}

async function replaceAtomically(path: string, source: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.rollback.tmp`;
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

interface AuthorityIdentity { files: ReadonlyMap<string, string> }

async function captureAuthorityIdentity(root: string, runId: string): Promise<AuthorityIdentity> {
  const runDirectory = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}`, { mustExist: true });
  const files = new Map<string, string>();
  await captureDirectoryFiles(runDirectory, runDirectory, files);
  for (const path of [".sdlc/project.yaml", ".sdlc/policies/permissions.yaml", ".sdlc/workflows/feature-development.yaml"]) {
    const absolutePath = await resolvePathInsideRoot(root, path, { mustExist: true });
    files.set(`repository:${path}`, hashSource(await readFile(absolutePath)));
  }
  return { files };
}

async function captureDirectoryFiles(directory: string, runDirectory: string, files: Map<string, string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".sdlc-manifest-lock" || entry.name === authorityVersionFile || entry.name === "manifest.yaml" || entry.name.endsWith(".tmp")) continue;
    const absolutePath = join(directory, entry.name);
    const relativePath = absolutePath.slice(runDirectory.length + 1).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await captureDirectoryFiles(absolutePath, runDirectory, files);
    } else if (entry.isFile()) {
      files.set(`run:${relativePath}`, hashSource(await readFile(absolutePath)));
    } else {
      throw new Error(`run authority contains a non-regular path: ${relativePath}`);
    }
  }
}

async function assertAuthorityIdentityUnchanged(root: string, runId: string, expected: AuthorityIdentity): Promise<void> {
  const actual = await captureAuthorityIdentity(root, runId);
  const paths = new Set([...expected.files.keys(), ...actual.files.keys()]);
  for (const path of paths) {
    if (expected.files.get(path) !== actual.files.get(path)) {
      throw new Error(`run authority identity changed after validation: ${path}`);
    }
  }
}

function hashSource(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
