/**
 * FIFO-safety tests for `.sentryclirc` loading. Parallels
 * `test/lib/dsn/fifo-safety.test.ts` (added by PR #806).
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearSentryCliRcCache,
  loadSentryCliRc,
} from "../../src/lib/sentryclirc.js";
import { useTestConfigDir } from "../helpers.js";

const getConfigDir = useTestConfigDir("sentryclirc-fifo-");

/** Create a FIFO (named pipe) at the given path using mkfifo(1). */
function createFifo(path: string): void {
  execSync(`mkfifo ${JSON.stringify(path)}`);
}

describe("sentryclirc FIFO safety", () => {
  beforeEach(() => {
    // Point HOME at the test config dir too, so the loader can't reach the
    // real `$HOME/.sentryclirc`, and drop the cached global paths.
    vi.stubEnv("HOME", getConfigDir());
    clearSentryCliRcCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSentryCliRcCache();
  });

  test("skips a `.sentryclirc` FIFO in the project tree without hanging", async () => {
    // Simulate a 1Password-managed `.sentryclirc` (unusual but
    // possible). The walk-up should emit a null and move on — not
    // hang on the FIFO read.
    const cwd = join(getConfigDir(), "project");
    mkdirSync(cwd);
    createFifo(join(cwd, ".sentryclirc"));

    const config = await loadSentryCliRc(cwd);
    // No config values resolved, but the function returned cleanly.
    expect(config.org).toBeUndefined();
    expect(config.project).toBeUndefined();
  });
});
