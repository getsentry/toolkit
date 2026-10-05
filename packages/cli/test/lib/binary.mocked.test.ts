/**
 * Tests for installBinary's canonical() fallback when realpath throws on an
 * existing path. Kept in a separate file so the node:fs/promises mock doesn't
 * leak into binary.test.ts.
 */

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock only realpath to throw; everything else stays real via importOriginal.
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    realpath: () =>
      Promise.reject(new Error("EACCES: permission denied (simulated)")),
  };
});

// Import AFTER the mock so binary.ts picks up the throwing realpath.
import { getBinaryFilename, installBinary } from "../../src/lib/binary.js";
import { logger } from "../../src/lib/logger.js";

describe("installBinary canonical() fallback when realpath throws", () => {
  let testDir: string;
  let installDir: string;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `binary-mocked-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    installDir = join(testDir, "install");
    mkdirSync(installDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("falls back to resolve() and logs when realpath throws on an existing path", async () => {
    if (process.platform === "win32") return;

    // Mirror the upgrade-spawn case: sourcePath IS the .download file, so the
    // guard must recognize them as the same file. With realpath throwing,
    // canonical() falls back to resolve() rather than unlinking the source.
    const tempPath = join(installDir, `${getBinaryFilename()}.download`);
    await writeFile(tempPath, "upgraded binary");
    chmodSync(tempPath, 0o755);

    const debugSpy = vi.spyOn(logger, "debug");

    const result = await installBinary(tempPath, installDir);

    expect(result).toBe(join(installDir, getBinaryFilename()));
    expect(await readFile(result, "utf-8")).toBe("upgraded binary");
    expect(debugSpy).toHaveBeenCalledWith(
      "realpath failed, falling back to resolve()",
      expect.any(Error)
    );
  });
});
