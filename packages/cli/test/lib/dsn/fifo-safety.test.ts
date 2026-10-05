/**
 * FIFO / Named Pipe Safety Tests
 *
 * Verifies that DSN detection gracefully skips non-regular files
 * (FIFOs, sockets, etc.) instead of blocking indefinitely.
 *
 * Motivation: 1Password streams secrets via symlinked named pipes for .env
 * files. Bun.file().text() blocks indefinitely on FIFOs because open()
 * waits for a writer. The isRegularFile() guard prevents this hang by
 * checking file type with stat() before attempting to read.
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isRegularFile } from "../../../src/lib/dsn/fs-utils.js";
import { useTestConfigDir } from "../../helpers.js";

/** Create a FIFO (named pipe) at the given path using mkfifo(1). */
function createFifo(path: string): void {
  execSync(`mkfifo ${JSON.stringify(path)}`);
}

const getConfigDir = useTestConfigDir("fifo-safety-");

describe("isRegularFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sentry-fifo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("returns true for regular files", async () => {
    const filePath = join(testDir, ".env");
    writeFileSync(filePath, "SENTRY_DSN=https://key@sentry.io/123\n");
    expect(await isRegularFile(filePath)).toBe(true);
  });

  test("returns false for FIFOs (named pipes)", async () => {
    const fifoPath = join(testDir, ".env");
    createFifo(fifoPath);
    // Verify it's actually a FIFO
    expect(statSync(fifoPath).isFIFO()).toBe(true);
    expect(await isRegularFile(fifoPath)).toBe(false);
  });

  test("returns false for symlinks to FIFOs (1Password pattern)", async () => {
    const fifoPath = join(testDir, ".env.fifo");
    createFifo(fifoPath);
    const symlinkPath = join(testDir, ".env");
    symlinkSync(fifoPath, symlinkPath);
    // stat() follows the symlink and sees the FIFO target
    expect(await isRegularFile(symlinkPath)).toBe(false);
  });

  test("returns true for symlinks to regular files", async () => {
    const realPath = join(testDir, ".env.real");
    writeFileSync(realPath, "SENTRY_DSN=https://key@sentry.io/123\n");
    const symlinkPath = join(testDir, ".env");
    symlinkSync(realPath, symlinkPath);
    expect(await isRegularFile(symlinkPath)).toBe(true);
  });

  test("returns false for directories", async () => {
    const dirPath = join(testDir, ".env");
    mkdirSync(dirPath);
    expect(await isRegularFile(dirPath)).toBe(false);
  });

  test("returns false for non-existent paths", async () => {
    expect(await isRegularFile(join(testDir, "no-such-file"))).toBe(false);
  });
});

describe("FIFO: env file detection", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sentry-fifo-env-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    // Create .git so this is treated as project root (stops walk-up)
    mkdirSync(join(testDir, ".git"));
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("detectFromEnvFiles skips FIFO .env without hanging", async () => {
    // Ensure config dir is set for DB access
    getConfigDir();

    const fifoPath = join(testDir, ".env");
    createFifo(fifoPath);

    const { detectFromEnvFiles } = await import(
      "../../../src/lib/dsn/env-file.js"
    );

    // This would hang indefinitely before the fix.
    // 2-second timeout ensures the test fails fast if the guard is broken.
    const result = await Promise.race([
      detectFromEnvFiles(testDir),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000)
      ),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).toBeNull();
  });

  test("detectFromEnvFiles reads regular .env normally", async () => {
    getConfigDir();

    writeFileSync(
      join(testDir, ".env"),
      "SENTRY_DSN=https://abc123@o456.ingest.sentry.io/789\n"
    );

    const { detectFromEnvFiles } = await import(
      "../../../src/lib/dsn/env-file.js"
    );
    const result = await detectFromEnvFiles(testDir);

    expect(result).not.toBeNull();
    expect(result!.raw).toBe("https://abc123@o456.ingest.sentry.io/789");
  });

  test("detectFromEnvFiles skips FIFO .env but reads regular .env.local", async () => {
    getConfigDir();

    // .env is a FIFO (would hang)
    createFifo(join(testDir, ".env"));
    // .env.local is a regular file with a DSN
    writeFileSync(
      join(testDir, ".env.local"),
      "SENTRY_DSN=https://key@o1.ingest.sentry.io/111\n"
    );

    const { detectFromEnvFiles } = await import(
      "../../../src/lib/dsn/env-file.js"
    );
    const result = await Promise.race([
      detectFromEnvFiles(testDir),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000)
      ),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).not.toBeNull();
    expect(result!.raw).toBe("https://key@o1.ingest.sentry.io/111");
  });

  test("findProjectRoot walk-up skips FIFO .env without hanging", async () => {
    getConfigDir();

    // Create a nested dir structure:  testDir/.git + testDir/sub/.env (FIFO)
    const subDir = join(testDir, "sub");
    mkdirSync(subDir);
    createFifo(join(subDir, ".env"));

    const { findProjectRoot } = await import(
      "../../../src/lib/dsn/project-root.js"
    );

    const result = await Promise.race([
      findProjectRoot(subDir),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000)
      ),
    ]);

    expect(result).not.toBe("timeout");
    // Should still find the project root (.git in parent)
    expect((result as { projectRoot: string }).projectRoot).toBe(testDir);
  });

  test("detectDsn skips symlinked FIFO .env.local and falls back to regular .env", async () => {
    getConfigDir();

    const fifoPath = join(testDir, ".env.local.fifo");
    createFifo(fifoPath);
    symlinkSync(fifoPath, join(testDir, ".env.local"));
    writeFileSync(
      join(testDir, ".env"),
      "SENTRY_DSN=https://fallback@o1.ingest.sentry.io/222\n"
    );

    const { detectDsn } = await import("../../../src/lib/dsn/detector.js");

    const result = await Promise.race([
      detectDsn(testDir),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000)
      ),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).not.toBeNull();
    expect(result!.raw).toBe("https://fallback@o1.ingest.sentry.io/222");
    expect(result!.source).toBe("env_file");
  });

  test("detectDsn cache verification skips source file after it becomes a symlinked FIFO", async () => {
    getConfigDir();

    const cachedDsn = "https://cached@o1.ingest.sentry.io/111";
    const fallbackDsn = "https://fallback@o2.ingest.sentry.io/333";
    const envPath = join(testDir, ".env");
    writeFileSync(envPath, `SENTRY_DSN=${cachedDsn}\n`);

    const { detectDsn } = await import("../../../src/lib/dsn/detector.js");

    const firstResult = await detectDsn(testDir);
    expect(firstResult?.raw).toBe(cachedDsn);
    expect(firstResult?.source).toBe("env_file");

    rmSync(envPath);
    const fifoPath = join(testDir, ".env.fifo");
    createFifo(fifoPath);
    symlinkSync(fifoPath, envPath);
    process.env.SENTRY_DSN = fallbackDsn;

    const result = await Promise.race([
      detectDsn(testDir),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000)
      ),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).not.toBeNull();
    expect(result!.raw).toBe(fallbackDsn);
    expect(result!.source).toBe("env");
  });
});
