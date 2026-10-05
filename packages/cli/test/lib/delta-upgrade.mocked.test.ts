/**
 * Integration tests for delta upgrade orchestration with a non-dev CLI_VERSION.
 *
 * These tests use `vi.mock()` to override `CLI_VERSION` from constants.js
 * so that `canAttemptDelta()` passes its dev-build guard (the real `CLI_VERSION`
 * is "0.0.0-dev" in test mode, which short-circuits the orchestrator).
 *
 * Kept as a sibling file to `delta-upgrade.test.ts` because its
 * `vi.mock()` would invert the assumptions of the dev-mode null-return
 * tests in that file. Under `bun test --isolate` each file gets a fresh
 * module graph, so the mocks here don't leak.
 */

import { copyFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("delta-upgrade-mocked-");

// ============================================================================
// Mock Setup
// ============================================================================

/**
 * Mock constants.js to pretend we're running a real stable version.
 * This satisfies canAttemptDelta()'s CLI_VERSION !== "0.0.0-dev" check.
 */
vi.mock("../../src/lib/constants.js", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("../../src/lib/constants.js")>();
  return {
    ...orig,
    CLI_VERSION: "0.13.0",
  };
});

// Import AFTER mock setup so the mocked constants are used
import { getPlatformBinaryName } from "../../src/lib/binary.js";
import {
  attemptDeltaUpgrade,
  resolveNightlyDelta,
  resolveStableDelta,
} from "../../src/lib/delta-upgrade.js";

// ============================================================================
// Fetch mock infrastructure
// ============================================================================

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

// ============================================================================
// Helpers
// ============================================================================

const BINARY_NAME = getPlatformBinaryName();

function versionHex(version: string): string {
  return Array.from(version)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

function tempFile(name: string): string {
  return join(
    tmpdir(),
    `delta-iso-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`
  );
}

// ============================================================================
// resolveStableDelta
// ============================================================================

describe("resolveStableDelta", () => {
  test("resolves and applies a stable delta patch", async () => {
    // Create a "current binary" to patch from
    const oldBinaryPath = tempFile("old-binary.bin");
    const destPath = tempFile("patched-binary.bin");
    writeFileSync(oldBinaryPath, Buffer.from("old binary content for testing"));

    // Set up fetch mocks — releases API + patch download
    // Since applyPatch will fail (we don't have a real TRDIFF10 matching this binary),
    // we expect resolveStableDelta to throw, but the chain resolution should succeed
    const patchUrl = `https://github.com/getsentry/toolkit/releases/download/cli@0.14.0/${BINARY_NAME}.patch`;
    const releases = [
      {
        tag_name: "cli@0.14.0",
        assets: [
          {
            name: BINARY_NAME,
            size: 100_000,
            digest: `sha256:${versionHex("0.14.0")}`,
            browser_download_url: `https://example.com/${BINARY_NAME}`,
          },
          {
            name: `${BINARY_NAME}.patch`,
            size: 500,
            browser_download_url: patchUrl,
          },
          {
            name: `${BINARY_NAME}.gz`,
            size: 100_000,
            browser_download_url: `https://example.com/${BINARY_NAME}.gz`,
          },
        ],
      },
      {
        tag_name: "cli@0.13.0",
        assets: [
          {
            name: BINARY_NAME,
            size: 100_000,
            browser_download_url: `https://example.com/${BINARY_NAME}`,
          },
        ],
      },
    ];

    // A fake patch that is valid TRDIFF10 header but will fail during application
    // (header says 0 control/diff/new size, which produces an empty file)
    const emptyTrdiff10 = new Uint8Array(32);
    // Set magic: "TRDIFF10"
    const magic = new TextEncoder().encode("TRDIFF10");
    emptyTrdiff10.set(magic, 0);
    // All sizes stay 0 — this will produce an empty output

    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      if (urlStr === patchUrl) {
        return new Response(emptyTrdiff10.buffer as ArrayBuffer, {
          status: 200,
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      // resolveStableDelta will:
      // 1. Fetch releases (success)
      // 2. Extract chain (success — single hop 0.13→0.14)
      // 3. Download patch (success)
      // 4. Apply patch (produces empty file)
      // 5. SHA-256 check fails → throws
      await expect(
        resolveStableDelta("0.14.0", oldBinaryPath, destPath)
      ).rejects.toThrow("SHA-256 mismatch");
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  test("returns null when no chain is available", async () => {
    const oldBinaryPath = tempFile("old-binary.bin");
    const destPath = tempFile("patched.bin");
    writeFileSync(oldBinaryPath, Buffer.from("old content"));

    mockFetch(async () => new Response("Error", { status: 500 }));

    try {
      const result = await resolveStableDelta(
        "0.14.0",
        oldBinaryPath,
        destPath
      );
      expect(result).toBeNull();
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
    }
  });
});

// ============================================================================
// resolveNightlyDelta
// ============================================================================

describe("resolveNightlyDelta", () => {
  test("returns null when nightly manifest has no .gz layer", async () => {
    const oldBinaryPath = tempFile("old-nightly.bin");
    const destPath = tempFile("patched-nightly.bin");
    writeFileSync(oldBinaryPath, Buffer.from("old nightly"));

    // Mock GHCR: token exchange succeeds, nightly manifest has no .gz layer
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "test-token" }), {
          status: 200,
        });
      }
      if (urlStr.includes("/manifests/nightly-")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            config: {
              digest: "sha256:config",
              mediaType: "application/vnd.oci.empty.v1+json",
              size: 2,
            },
            layers: [
              {
                digest: "sha256:aabb",
                mediaType: "application/octet-stream",
                size: 1000,
                annotations: {
                  "org.opencontainers.image.title": `${BINARY_NAME}`,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      // listTags runs in parallel with fetchManifest — must not 404
      if (urlStr.includes("/tags/list")) {
        return new Response(JSON.stringify({ tags: [] }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const result = await resolveNightlyDelta(
        "0.0.0-dev.200",
        oldBinaryPath,
        destPath
      );
      expect(result).toBeNull();
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
    }
  });

  test("returns null when no patch chain exists", async () => {
    const oldBinaryPath = tempFile("old-nightly.bin");
    const destPath = tempFile("patched-nightly.bin");
    writeFileSync(oldBinaryPath, Buffer.from("old nightly"));

    // Mock GHCR: nightly manifest has .gz layer, but no patch tags
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "test-token" }), {
          status: 200,
        });
      }
      if (urlStr.includes("/manifests/nightly-")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            config: {
              digest: "sha256:config",
              mediaType: "application/vnd.oci.empty.v1+json",
              size: 2,
            },
            layers: [
              {
                digest: "sha256:aabb",
                mediaType: "application/octet-stream",
                size: 30_000_000,
                annotations: {
                  "org.opencontainers.image.title": `${BINARY_NAME}.gz`,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/tags/list")) {
        return new Response(JSON.stringify({ tags: [] }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const result = await resolveNightlyDelta(
        "0.0.0-dev.200",
        oldBinaryPath,
        destPath
      );
      expect(result).toBeNull();
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
    }
  });
});

// ============================================================================
// attemptDeltaUpgrade
// ============================================================================

describe("attemptDeltaUpgrade", () => {
  test("returns null for cross-channel upgrade (stable → nightly)", async () => {
    // CLI_VERSION is mocked as "0.13.0" (stable), target is nightly
    const result = await attemptDeltaUpgrade(
      "0.0.0-dev.100",
      "/tmp/fake-binary",
      "/tmp/fake-dest"
    );
    expect(result).toBeNull();
  });

  test("returns null when stable chain resolution fails", async () => {
    const oldBinaryPath = tempFile("old.bin");
    const destPath = tempFile("dest.bin");
    writeFileSync(oldBinaryPath, Buffer.from("binary"));

    // All fetches fail
    mockFetch(async () => new Response("Error", { status: 500 }));

    try {
      const result = await attemptDeltaUpgrade(
        "0.14.0",
        oldBinaryPath,
        destPath
      );
      expect(result).toBeNull();
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
    }
  });

  test("catches errors from patch application and returns null", async () => {
    const oldBinaryPath = tempFile("old.bin");
    const destPath = tempFile("dest.bin");
    writeFileSync(oldBinaryPath, Buffer.from("binary"));

    // Return releases + a broken patch
    const patchUrl = "https://example.com/patch";
    const releases = [
      {
        tag_name: "cli@0.14.0",
        assets: [
          {
            name: BINARY_NAME,
            size: 100_000,
            digest: `sha256:${versionHex("0.14.0")}`,
            browser_download_url: `https://example.com/${BINARY_NAME}`,
          },
          {
            name: `${BINARY_NAME}.patch`,
            size: 500,
            browser_download_url: patchUrl,
          },
          {
            name: `${BINARY_NAME}.gz`,
            size: 100_000,
            browser_download_url: `https://example.com/${BINARY_NAME}.gz`,
          },
        ],
      },
      {
        tag_name: "cli@0.13.0",
        assets: [
          {
            name: BINARY_NAME,
            size: 100_000,
            browser_download_url: `https://example.com/${BINARY_NAME}`,
          },
        ],
      },
    ];

    // Return garbage patch data
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      if (urlStr === patchUrl) {
        return new Response(
          new Uint8Array([0, 1, 2, 3]).buffer as ArrayBuffer,
          {
            status: 200,
          }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      // Should catch the bspatch error and return null
      const result = await attemptDeltaUpgrade(
        "0.14.0",
        oldBinaryPath,
        destPath
      );
      expect(result).toBeNull();
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  test("returns DeltaResult with telemetry on successful stable patch", async () => {
    // Use real TRDIFF10 fixture for end-to-end success
    const fixturesDir = join(import.meta.dirname, "../fixtures/patches");
    const oldBinaryPath = tempFile("old-success.bin");
    const destPath = tempFile("dest-success.bin");

    // Copy the real fixture "old" binary — loadOldBinary will copy+mmap this
    copyFileSync(join(fixturesDir, "small-old.bin"), oldBinaryPath);

    // SHA-256 of the expected output (small-new.bin)
    const expectedSha256 =
      "54d0dcd74478bc154b5b24393fdc6129518271baa36f446384d60e84021bb724";

    // Read the real TRDIFF10 patch
    const patchData = await readFile(join(fixturesDir, "small.trdiff10"));

    const patchUrl = "https://example.com/small.patch";
    const releases = [
      {
        tag_name: "cli@0.14.0",
        assets: [
          {
            name: BINARY_NAME,
            size: 54,
            digest: `sha256:${expectedSha256}`,
            browser_download_url: `https://example.com/${BINARY_NAME}`,
          },
          {
            name: `${BINARY_NAME}.patch`,
            size: 89,
            browser_download_url: patchUrl,
          },
          {
            name: `${BINARY_NAME}.gz`,
            size: 100_000,
            browser_download_url: `https://example.com/${BINARY_NAME}.gz`,
          },
        ],
      },
      {
        tag_name: "cli@0.13.0",
        assets: [
          {
            name: BINARY_NAME,
            size: 54,
            browser_download_url: `https://example.com/${BINARY_NAME}`,
          },
        ],
      },
    ];

    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      if (urlStr === patchUrl) {
        return new Response(patchData, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const result = await attemptDeltaUpgrade(
        "0.14.0",
        oldBinaryPath,
        destPath
      );
      expect(result).not.toBeNull();
      expect(result!.sha256).toBe(expectedSha256);
      expect(result!.patchBytes).toBe(89);
      expect(result!.chainLength).toBe(1);

      // Verify patched output matches expected file
      const actual = await readFile(destPath);
      const expected = await readFile(join(fixturesDir, "small-new.bin"));
      expect(new Uint8Array(actual)).toEqual(new Uint8Array(expected));
    } finally {
      if (existsSync(oldBinaryPath)) unlinkSync(oldBinaryPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });
});
