/**
 * Shared npm bundle build helper for e2e tests.
 *
 * Serializes bundle builds across parallel test files so `bundle.test.ts` and
 * `library.test.ts` never run `pnpm run bundle` concurrently. vitest runs each
 * test file in its own worker process (`pool: "forks"`), so an in-process
 * promise cannot coordinate them — the lock has to live on the filesystem.
 * Whichever worker wins the `mkdir` lock builds once; the rest wait for the
 * bundle to appear.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

const ROOT_DIR = join(import.meta.dirname, "../..");

/** Cross-process build lock directory (kept outside `dist/`). */
const LOCK_DIR = join(ROOT_DIR, ".bundle-build.lock");

/** Bundled library entrypoint used by library-mode e2e tests. */
export const BUNDLE_INDEX_PATH = join(ROOT_DIR, "dist/index.cjs");

/** CLI wrapper entrypoint used by npm bundle e2e tests. */
export const BUNDLE_BIN_PATH = join(ROOT_DIR, "dist/bin.cjs");

/** Bundled library type declarations. */
export const BUNDLE_TYPES_PATH = join(ROOT_DIR, "dist/index.d.cts");

let buildPromise: Promise<void> | null = null;

/**
 * Ensure the npm bundle exists under `dist/`, building it once if needed.
 *
 * Safe to call concurrently from multiple test files: a filesystem lock
 * ensures exactly one worker runs `pnpm run bundle` while the others wait for
 * the bundle to appear.
 */
export function ensureBundleBuilt(): Promise<void> {
  if (existsSync(BUNDLE_INDEX_PATH) && !existsSync(LOCK_DIR)) {
    return Promise.resolve();
  }

  buildPromise ??= runBundleBuild();
  return buildPromise;
}

async function runBundleBuild(): Promise<void> {
  // Atomic `mkdir` acts as a cross-process lock: only one worker creates the
  // directory and builds; the rest fall through to wait for the bundle.
  let holdsLock = false;
  try {
    mkdirSync(LOCK_DIR);
    holdsLock = true;
  } catch {
    // Another worker is building — wait for the bundle to appear.
  }

  if (!holdsLock) {
    buildPromise = null;
    await waitForBundle();
    return;
  }

  try {
    await spawnBundle();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }

  if (!existsSync(BUNDLE_INDEX_PATH)) {
    buildPromise = null;
    throw new Error("Bundle not built — cannot run library/bundle tests");
  }
}

async function waitForBundle(): Promise<void> {
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    if (existsSync(BUNDLE_INDEX_PATH) && !existsSync(LOCK_DIR)) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Bundle not built — cannot run library/bundle tests");
}

async function spawnBundle(): Promise<void> {
  const exitCode = await new Promise<number>((resolve) => {
    let buildStderr = "";
    const proc = spawn("pnpm", ["run", "bundle"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        SENTRY_CLIENT_ID: process.env.SENTRY_CLIENT_ID || "test-client-id",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.on("error", noop);
    proc.stderr.on("data", (d: Buffer) => {
      buildStderr += d;
    });
    proc.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        console.error(`Bundle failed with exit code ${code}: ${buildStderr}`);
      }
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    buildPromise = null;
    throw new Error("Bundle not built — cannot run library/bundle tests");
  }
}
