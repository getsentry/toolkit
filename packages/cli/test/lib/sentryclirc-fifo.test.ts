/**
 * FIFO-safety tests for `.sentryclirc` loading. Parallels
 * `test/lib/dsn/fifo-safety.test.ts` (added by PR #806).
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearSentryCliRcCache,
  loadSentryCliRc,
} from "../../src/lib/sentryclirc.js";

/** Create a FIFO (named pipe) at the given path using mkfifo(1). */
function createFifo(path: string): void {
  execSync(`mkfifo ${JSON.stringify(path)}`);
}

describe("sentryclirc FIFO safety", () => {
  let dir: string;
  let originalHome: string | undefined;
  let originalSentryConfigDir: string | undefined;

  beforeEach(() => {
    // Clear both the load cache AND the cached global-paths singleton
    // so this describe block sees the overridden env vars below.
    clearSentryCliRcCache();
    dir = join(
      tmpdir(),
      `sentryclirc-fifo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    // Point both global fallback locations into `dir` so the loader
    // can't reach the real user's `$HOME/.sentryclirc`.
    originalHome = process.env.HOME;
    originalSentryConfigDir = process.env.SENTRY_CONFIG_DIR;
    process.env.HOME = dir;
    process.env.SENTRY_CONFIG_DIR = dir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.SENTRY_CONFIG_DIR = originalSentryConfigDir;
    rmSync(dir, { recursive: true, force: true });
    // Reset again so later test files don't inherit stale globalPaths
    // pointing at the now-deleted temp dir.
    clearSentryCliRcCache();
  });

  test("skips a `.sentryclirc` FIFO in the project tree without hanging", async () => {
    // Simulate a 1Password-managed `.sentryclirc` (unusual but
    // possible). The walk-up should emit a null and move on — not
    // hang on the FIFO read.
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    createFifo(join(cwd, ".sentryclirc"));

    const config = await loadSentryCliRc(cwd);
    // No config values resolved, but the function returned cleanly.
    expect(config.org).toBeUndefined();
    expect(config.project).toBeUndefined();
  });
});
