import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolvePathInsideRoot } from "./paths.js";

const lockRetryDelayMs = 5;
const defaultLockTimeoutMs = 15_000;
const defaultStaleLockThresholdMs = 60_000;

export interface RunAuthorityLockOptions {
  lockTimeoutMs?: number;
  staleLockThresholdMs?: number;
  lockToken?: string;
  now?: () => string;
  /** Test-only signal emitted after observing another live lock owner. */
  onLockWait?: () => void;
}

declare const heldRunAuthorityLockBrand: unique symbol;

/** Opaque proof that the caller owns the shared lock for one active run. */
export interface HeldRunAuthorityLock {
  readonly [heldRunAuthorityLockBrand]: true;
  readonly path: string;
  readonly root: string;
  readonly runId: string;
  readonly token: string;
}

interface LockOwner { pid: number; token: string; created_at: string }

export async function acquireRunAuthorityLock(
  root: string,
  runId: string,
  options: RunAuthorityLockOptions = {},
): Promise<HeldRunAuthorityLock> {
  await resolvePathInsideRoot(root, `.sdlc/runs/${runId}`, { mustExist: true });
  const lockPath = await resolvePathInsideRoot(root, `.sdlc/runs/${runId}/.sdlc-manifest-lock`);
  const deadline = Date.now() + (options.lockTimeoutMs ?? defaultLockTimeoutMs);
  const token = options.lockToken ?? randomUUID();
  let waitReported = false;
  for (;;) {
    try {
      await mkdir(lockPath);
      const owner: LockOwner = { pid: process.pid, token, created_at: (options.now ?? (() => new Date().toISOString()))() };
      try {
        await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { path: lockPath, root: resolve(root), runId, token } as HeldRunAuthorityLock;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await reclaimStaleLock(lockPath, options)) continue;
      if (!waitReported) {
        waitReported = true;
        options.onLockWait?.();
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for manifest transaction lock");
      await delay(lockRetryDelayMs);
    }
  }
}

export async function assertHeldRunAuthorityLock(
  lock: HeldRunAuthorityLock,
  root: string,
  runId: string,
): Promise<void> {
  if (lock.root !== resolve(root) || lock.runId !== runId) {
    throw new Error(`run authority lock does not belong to ${runId}`);
  }
  let owner: LockOwner;
  try {
    owner = JSON.parse(await readFile(join(lock.path, "owner.json"), "utf8")) as LockOwner;
  } catch {
    throw new Error(`run authority lock is no longer held for ${runId}`);
  }
  if (owner.token !== lock.token) throw new Error(`run authority lock ownership changed for ${runId}`);
}

export async function releaseRunAuthorityLock(lock: HeldRunAuthorityLock): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lock.path, "owner.json"), "utf8")) as LockOwner;
    if (owner.token !== lock.token) return;
  } catch {
    return;
  }
  await rm(lock.path, { recursive: true, force: true });
}

async function reclaimStaleLock(lockPath: string, options: RunAuthorityLockOptions): Promise<boolean> {
  let information;
  try {
    information = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (information.isSymbolicLink() || !information.isDirectory()) throw new Error("manifest transaction lock is not a safe directory");
  let owner: LockOwner;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return false;
  }
  const now = Date.parse((options.now ?? (() => new Date().toISOString()))());
  const age = now - Date.parse(owner.created_at);
  if (!Number.isFinite(age) || age < (options.staleLockThresholdMs ?? defaultStaleLockThresholdMs) || isProcessAlive(owner.pid)) return false;
  const quarantine = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const moved = JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8")) as LockOwner;
    if (moved.token !== owner.token) throw new Error("stale manifest lock token changed during reclaim");
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    await rename(quarantine, lockPath).catch(() => undefined);
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
