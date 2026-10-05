/**
 * E2E Test: Delta Upgrade via Binary Patching
 *
 * Downloads two consecutive stable release binaries from GitHub,
 * generates a TRDIFF10 patch using zig-bsdiff, and verifies that
 * our `applyPatch()` produces byte-identical output.
 *
 * Requires: zig-bsdiff binary available at /tmp/bsdiff (or via ZIG_BSDIFF_PATH env).
 * Skipped in CI unless ZIG_BSDIFF_PATH is set.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, applyPatchChainInMemory } from "binpatch";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getPlatformBinaryName } from "../../src/lib/binary.js";

// Restore real fetch for E2E tests (preload.ts mocks it globally)
const realFetch = (globalThis as { __originalFetch?: typeof fetch })
  .__originalFetch;
const savedFetch = globalThis.fetch;

/** Path to zig-bsdiff binary */
const BSDIFF_PATH = process.env.ZIG_BSDIFF_PATH ?? "/tmp/bsdiff";

/** Two consecutive releases to test patching between */
const OLD_VERSION = "0.12.0";
const NEW_VERSION = "0.13.0";

/** Whether we can run this test (zig-bsdiff must be available) */
const canRun = existsSync(BSDIFF_PATH);

describe.skipIf(!canRun)("e2e: delta upgrade", () => {
  // Use real fetch for actual HTTP downloads
  beforeAll(() => {
    if (realFetch) {
      globalThis.fetch = realFetch;
    }
  });

  afterAll(() => {
    globalThis.fetch = savedFetch;
  });

  test(
    "patches previous release binary to produce next release binary",
    { timeout: 120_000 }, // Downloads can be slow
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "delta-e2e-"));
      const binaryName = getPlatformBinaryName();
      const oldPath = join(workDir, "old");
      const newPath = join(workDir, "new");
      const patchPath = join(workDir, "patch.trdiff10");
      const outputPath = join(workDir, "output");
      const chainPatchPath = join(workDir, "patch2.trdiff10");
      const chainOutputPath = join(workDir, "chain-output");

      try {
        // Download old and new binaries from GitHub Releases
        const baseUrl = "https://github.com/getsentry/cli/releases/download";
        await downloadBinary(
          `${baseUrl}/${OLD_VERSION}/${binaryName}`,
          oldPath
        );
        await downloadBinary(
          `${baseUrl}/${NEW_VERSION}/${binaryName}`,
          newPath
        );

        // Generate TRDIFF10 patch
        execSync(
          `${BSDIFF_PATH} ${oldPath} ${newPath} ${patchPath} --use-zstd`,
          {
            stdio: "pipe",
          }
        );

        // Apply patch with our implementation
        const patchData = new Uint8Array(await readFile(patchPath));
        const sha256 = await applyPatch(oldPath, patchData, outputPath);

        // Verify output matches expected new binary
        const expectedHash = createHash("sha256")
          .update(await readFile(newPath))
          .digest("hex");

        expect(sha256).toBe(expectedHash);

        // Also verify byte-for-byte equality
        const outputBytes = new Uint8Array(await readFile(outputPath));
        const expectedBytes = new Uint8Array(await readFile(newPath));
        expect(outputBytes.byteLength).toBe(expectedBytes.byteLength);
        expect(outputBytes).toEqual(expectedBytes);

        // Verify a real two-hop chain: old --p1--> new --p2--> new.
        // p2 is a (near-identity) new→new patch, so the chain must still yield
        // the new binary while keeping the intermediate entirely in memory.
        execSync(
          `${BSDIFF_PATH} ${newPath} ${newPath} ${chainPatchPath} --use-zstd`,
          { stdio: "pipe" }
        );
        const p1 = new Uint8Array(await readFile(patchPath));
        const p2 = new Uint8Array(await readFile(chainPatchPath));
        const chainSha = await applyPatchChainInMemory(
          oldPath,
          [p1, p2],
          chainOutputPath
        );
        expect(chainSha).toBe(expectedHash);
        expect(new Uint8Array(await readFile(chainOutputPath))).toEqual(
          expectedBytes
        );
        // Intermediates never touch disk.
        expect(existsSync(`${chainOutputPath}.patching.a`)).toBe(false);
        expect(existsSync(`${chainOutputPath}.patching.b`)).toBe(false);
      } finally {
        // Cleanup
        for (const path of [
          oldPath,
          newPath,
          patchPath,
          outputPath,
          chainPatchPath,
          chainOutputPath,
        ]) {
          try {
            unlinkSync(path);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
  );
});

/**
 * Download a binary file from a URL, following redirects.
 *
 * @param url - URL to download from
 * @param destPath - Local path to write the file
 */
async function downloadBinary(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "sentry-cli-e2e-test" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const body = await response.arrayBuffer();
  await writeFile(destPath, Buffer.from(body));
}
