/**
 * Unit Tests for Delta Upgrade Module
 *
 * Tests the exported pure-computation functions that drive chain resolution
 * for both stable (GitHub Releases) and nightly (GHCR) channels, plus
 * async orchestration functions tested via fetch mocking.
 */

import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getPlatformBinaryName,
  UPGRADE_SOURCES,
} from "../../src/lib/binary.js";
import {
  applyPatchChain,
  attemptDeltaUpgrade,
  canAttemptDelta,
  downloadStablePatch,
  type ExtractStableChainOpts,
  extractSha256,
  extractStableChain,
  fetchRecentReleases,
  filterAndSortChainTags,
  type GitHubAsset,
  type GitHubRelease,
  getPatchFromVersion,
  getPatchTargetSha256,
  getStableTargetSha256,
  type PatchChain,
  prefetchNightlyPatches,
  prefetchStablePatches,
  resolveNightlyChain,
  resolveNightlyDelta,
  resolveStableChain,
  resolveStableDelta,
  validateChainStep,
} from "../../src/lib/delta-upgrade.js";
import type { OciManifest } from "../../src/lib/ghcr.js";
import { useTestConfigDir } from "../helpers.js";

const LEGACY_UPGRADE_SOURCE = UPGRADE_SOURCES[1];
if (!LEGACY_UPGRADE_SOURCE) {
  throw new Error("Legacy upgrade source is not configured");
}

// ---------------------------------------------------------------------------
// Test helpers (file-scoped)
// ---------------------------------------------------------------------------

/** Create a GitHub asset with optional overrides */
function makeAsset(overrides: Partial<GitHubAsset> = {}): GitHubAsset {
  return {
    name: "sentry-linux-x64",
    size: 100_000,
    browser_download_url: "https://example.com/download",
    ...overrides,
  };
}

/** Create a GitHub release with optional overrides */
function makeRelease(tag: string, assets: GitHubAsset[] = []): GitHubRelease {
  return { tag_name: tag, assets };
}

/** Create an OCI manifest with patch annotations */
function makePatchManifest(
  fromVersion: string,
  sha256Map: Record<string, string> = {},
  layers: OciManifest["layers"] = []
): OciManifest {
  const annotations: Record<string, string> = {
    "from-version": fromVersion,
  };
  for (const [key, value] of Object.entries(sha256Map)) {
    annotations[`sha256-${key}`] = value;
  }
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      digest: "sha256:config",
      mediaType: "application/vnd.oci.empty.v1+json",
      size: 2,
    },
    layers,
    annotations,
  };
}

// ===================================================================
// Pure computation tests
// ===================================================================

// getPlatformBinaryName

describe("getPlatformBinaryName", () => {
  test("returns a string starting with 'sentry-'", () => {
    const name = getPlatformBinaryName();
    expect(name.startsWith("sentry-")).toBe(true);
  });

  test("contains platform and arch components", () => {
    const name = getPlatformBinaryName();
    const parts = name.replace(".exe", "").split("-");
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("sentry");
    expect(["linux", "darwin", "windows"]).toContain(parts[1]);
    expect(["x64", "arm64"]).toContain(parts[2]);
  });

  test("has .exe suffix on windows platform name", () => {
    const name = getPlatformBinaryName();
    if (process.platform === "win32") {
      expect(name.endsWith(".exe")).toBe(true);
    } else {
      expect(name.endsWith(".exe")).toBe(false);
    }
  });
});

// canAttemptDelta

describe("canAttemptDelta", () => {
  test("returns false for cross-channel upgrade (stable → nightly)", () => {
    const result = canAttemptDelta("0.14.0-dev.123");
    expect(result).toBe(false);
  });

  test("returns false for dev build", () => {
    const result = canAttemptDelta("0.14.0");
    expect(result).toBe(false);
  });

  test("returns false for nightly target from dev build", () => {
    const result = canAttemptDelta("0.14.0-dev.abc123");
    expect(result).toBe(false);
  });
});

// extractSha256

describe("extractSha256", () => {
  test("extracts hex from sha256: prefixed digest", () => {
    const asset = makeAsset({ digest: "sha256:abcdef0123456789" });
    expect(extractSha256(asset)).toBe("abcdef0123456789");
  });

  test("returns null when no digest field", () => {
    const asset = makeAsset({});
    expect(extractSha256(asset)).toBeNull();
  });

  test("returns null for empty digest", () => {
    const asset = makeAsset({ digest: "" });
    expect(extractSha256(asset)).toBeNull();
  });

  test("returns null for non-sha256 digest format", () => {
    const asset = makeAsset({ digest: "md5:abcdef" });
    expect(extractSha256(asset)).toBeNull();
  });

  test("normalizes uppercase hex to lowercase", () => {
    const asset = makeAsset({ digest: "sha256:ABCDEF0123456789" });
    expect(extractSha256(asset)).toBe("abcdef0123456789");
  });

  test("handles mixed case prefix", () => {
    const asset = makeAsset({ digest: "SHA256:abc123" });
    expect(extractSha256(asset)).toBe("abc123");
  });
});

// getStableTargetSha256

describe("getStableTargetSha256", () => {
  test("returns hex from matching binary asset", () => {
    const release = makeRelease("0.14.0", [
      makeAsset({
        name: "sentry-linux-x64",
        digest: "sha256:deadbeef",
      }),
    ]);
    expect(getStableTargetSha256(release, "sentry-linux-x64")).toBe("deadbeef");
  });

  test("returns null when binary asset not found", () => {
    const release = makeRelease("0.14.0", [
      makeAsset({ name: "sentry-darwin-arm64" }),
    ]);
    expect(getStableTargetSha256(release, "sentry-linux-x64")).toBeNull();
  });

  test("returns null when binary asset has no digest", () => {
    const release = makeRelease("0.14.0", [
      makeAsset({ name: "sentry-linux-x64" }),
    ]);
    expect(getStableTargetSha256(release, "sentry-linux-x64")).toBeNull();
  });

  test("returns null for empty assets array", () => {
    const release = makeRelease("0.14.0", []);
    expect(getStableTargetSha256(release, "sentry-linux-x64")).toBeNull();
  });
});

// extractStableChain

describe("extractStableChain", () => {
  /**
   * Create a deterministic hex digest from a version string.
   *
   * Converts each char to its hex code to produce valid [0-9a-f]+ output.
   */
  function versionToHex(version: string): string {
    return Array.from(version)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
  }

  /** Build a standard chain of releases (newest first) with valid patch assets */
  function buildReleases(
    versions: string[],
    binaryName: string,
    patchSize = 1000,
    gzSize = 100_000
  ): GitHubRelease[] {
    return versions.map((v) =>
      makeRelease(v, [
        makeAsset({
          name: binaryName,
          digest: `sha256:${versionToHex(v)}`,
        }),
        makeAsset({
          name: `${binaryName}.patch`,
          size: patchSize,
          browser_download_url: `https://example.com/${v}.patch`,
        }),
        makeAsset({
          name: `${binaryName}.gz`,
          size: gzSize,
        }),
      ])
    );
  }

  function makeOpts(
    overrides: Partial<ExtractStableChainOpts> = {}
  ): ExtractStableChainOpts {
    return {
      releases: [],
      currentVersion: "0.12.0",
      targetVersion: "0.14.0",
      binaryName: "sentry-linux-x64",
      fullGzSize: 100_000,
      ...overrides,
    };
  }

  test("resolves single-hop chain (0.12→0.13)", () => {
    const releases = buildReleases(["0.13.0", "0.12.0"], "sentry-linux-x64");
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.12.0",
        targetVersion: "0.13.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).not.toBeNull();
    expect(result?.patchUrls).toHaveLength(1);
    expect(result?.patchUrls[0]).toBe("https://example.com/0.13.0.patch");
    expect(result?.expectedSha256).toBe(versionToHex("0.13.0"));
    expect(result?.steps).toEqual([
      { fromVersion: "0.12.0", toVersion: "0.13.0" },
    ]);
  });

  test("resolves multi-hop chain (0.12→0.13→0.14)", () => {
    const releases = buildReleases(
      ["0.14.0", "0.13.0", "0.12.0"],
      "sentry-linux-x64"
    );
    const result = extractStableChain(
      makeOpts({ releases, fullGzSize: 100_000 })
    );
    expect(result).not.toBeNull();
    expect(result?.patchUrls).toHaveLength(2);
    expect(result?.patchUrls[0]).toBe("https://example.com/0.13.0.patch");
    expect(result?.patchUrls[1]).toBe("https://example.com/0.14.0.patch");
    expect(result?.expectedSha256).toBe(versionToHex("0.14.0"));
    expect(result?.steps).toEqual([
      { fromVersion: "0.12.0", toVersion: "0.13.0" },
      { fromVersion: "0.13.0", toVersion: "0.14.0" },
    ]);
  });

  test("returns null when target version not in release list", () => {
    const releases = buildReleases(["0.13.0", "0.12.0"], "sentry-linux-x64");
    const result = extractStableChain(
      makeOpts({
        releases,
        targetVersion: "0.15.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).toBeNull();
  });

  test("returns null when target is older than current (downgrade)", () => {
    const releases = buildReleases(
      ["0.14.0", "0.13.0", "0.12.0"],
      "sentry-linux-x64"
    );
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.14.0",
        targetVersion: "0.12.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).toBeNull();
  });

  test("returns null when target equals current", () => {
    const releases = buildReleases(["0.13.0", "0.12.0"], "sentry-linux-x64");
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.13.0",
        targetVersion: "0.13.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).toBeNull();
  });

  test("returns null when chain exceeds size threshold", () => {
    const releases = buildReleases(
      ["0.14.0", "0.13.0", "0.12.0"],
      "sentry-linux-x64",
      70_000
    );
    const result = extractStableChain(
      makeOpts({ releases, fullGzSize: 100_000 })
    );
    expect(result).toBeNull();
  });

  test("returns null when patch asset missing from a release", () => {
    const releases = [
      makeRelease("0.14.0", [
        makeAsset({
          name: "sentry-linux-x64",
          digest: `sha256:${versionToHex("0.14.0")}`,
        }),
        makeAsset({ name: "sentry-linux-x64.gz", size: 100_000 }),
      ]),
      makeRelease("0.13.0", [makeAsset({ name: "sentry-linux-x64" })]),
    ];
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.13.0",
        targetVersion: "0.14.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).toBeNull();
  });

  test("returns null when target binary has no digest (no SHA-256)", () => {
    const releases = [
      makeRelease("0.14.0", [
        makeAsset({ name: "sentry-linux-x64" }),
        makeAsset({
          name: "sentry-linux-x64.patch",
          size: 1000,
          browser_download_url: "https://example.com/0.14.0.patch",
        }),
        makeAsset({ name: "sentry-linux-x64.gz", size: 100_000 }),
      ]),
      makeRelease("0.13.0", [makeAsset({ name: "sentry-linux-x64" })]),
    ];
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.13.0",
        targetVersion: "0.14.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).toBeNull();
  });

  test("returns null for chain depth exceeding MAX_STABLE_CHAIN_DEPTH (10)", () => {
    const versions = Array.from({ length: 12 }, (_, i) => `0.${i + 1}.0`);
    versions.reverse();
    const releases = buildReleases(versions, "sentry-linux-x64", 100);
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.1.0",
        targetVersion: "0.12.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).toBeNull();
  });

  test("handles exactly MAX_STABLE_CHAIN_DEPTH (10) hops", () => {
    const versions = Array.from({ length: 11 }, (_, i) => `0.${i + 1}.0`);
    versions.reverse();
    const releases = buildReleases(versions, "sentry-linux-x64", 100);
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.1.0",
        targetVersion: "0.11.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).not.toBeNull();
    expect(result?.patchUrls).toHaveLength(10);
  });

  test("patch URLs are returned in apply order (oldest first)", () => {
    const releases = buildReleases(
      ["0.15.0", "0.14.0", "0.13.0", "0.12.0"],
      "sentry-linux-x64"
    );
    const result = extractStableChain(
      makeOpts({
        releases,
        currentVersion: "0.12.0",
        targetVersion: "0.15.0",
        fullGzSize: 100_000,
      })
    );
    expect(result).not.toBeNull();
    expect(result?.patchUrls).toEqual([
      "https://example.com/0.13.0.patch",
      "https://example.com/0.14.0.patch",
      "https://example.com/0.15.0.patch",
    ]);
  });

  test("cumulative size threshold is checked progressively", () => {
    const releases = [
      makeRelease("0.14.0", [
        makeAsset({
          name: "sentry-linux-x64",
          digest: `sha256:${versionToHex("0.14.0")}`,
        }),
        makeAsset({
          name: "sentry-linux-x64.patch",
          size: 50_000,
          browser_download_url: "https://example.com/0.14.0.patch",
        }),
        makeAsset({ name: "sentry-linux-x64.gz", size: 100_000 }),
      ]),
      makeRelease("0.13.0", [
        makeAsset({
          name: "sentry-linux-x64",
          digest: `sha256:${versionToHex("0.13.0")}`,
        }),
        makeAsset({
          name: "sentry-linux-x64.patch",
          size: 15_000,
          browser_download_url: "https://example.com/0.13.0.patch",
        }),
      ]),
      makeRelease("0.12.0", [makeAsset({ name: "sentry-linux-x64" })]),
    ];
    const result = extractStableChain(
      makeOpts({ releases, fullGzSize: 100_000 })
    );
    expect(result).toBeNull();
  });
});

// getPatchFromVersion & getPatchTargetSha256

describe("getPatchFromVersion", () => {
  test("extracts from-version annotation", () => {
    const manifest = makePatchManifest("0.12.0");
    expect(getPatchFromVersion(manifest)).toBe("0.12.0");
  });

  test("returns null when annotation missing", () => {
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: "sha256:config",
        mediaType: "application/vnd.oci.empty.v1+json",
        size: 2,
      },
      layers: [],
      annotations: {},
    };
    expect(getPatchFromVersion(manifest)).toBeNull();
  });

  test("returns null when annotations object is undefined", () => {
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: "sha256:config",
        mediaType: "application/vnd.oci.empty.v1+json",
        size: 2,
      },
      layers: [],
    };
    expect(getPatchFromVersion(manifest)).toBeNull();
  });
});

describe("getPatchTargetSha256", () => {
  test("extracts sha256 annotation for the given platform", () => {
    const manifest = makePatchManifest("0.12.0", {
      "sentry-linux-x64": "abc123",
      "sentry-darwin-arm64": "def456",
    });
    expect(getPatchTargetSha256(manifest, "sentry-linux-x64")).toBe("abc123");
    expect(getPatchTargetSha256(manifest, "sentry-darwin-arm64")).toBe(
      "def456"
    );
  });

  test("returns null when platform not found", () => {
    const manifest = makePatchManifest("0.12.0", {
      "sentry-linux-x64": "abc123",
    });
    expect(getPatchTargetSha256(manifest, "sentry-freebsd-x64")).toBeNull();
  });

  test("returns null when annotations are undefined", () => {
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: "sha256:config",
        mediaType: "application/vnd.oci.empty.v1+json",
        size: 2,
      },
      layers: [],
    };
    expect(getPatchTargetSha256(manifest, "sentry-linux-x64")).toBeNull();
  });
});

// filterAndSortChainTags

describe("filterAndSortChainTags", () => {
  test("returns empty array when no tags match the range", () => {
    const tags = ["patch-0.0.0-dev.90", "patch-0.0.0-dev.95"];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.100",
      "0.0.0-dev.105"
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when tags list is empty", () => {
    const result = filterAndSortChainTags([], "0.0.0-dev.100", "0.0.0-dev.105");
    expect(result).toEqual([]);
  });

  test("filters to tags strictly between current and target (inclusive of target)", () => {
    const tags = [
      "patch-0.0.0-dev.100",
      "patch-0.0.0-dev.101",
      "patch-0.0.0-dev.102",
      "patch-0.0.0-dev.103",
    ];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.100",
      "0.0.0-dev.102"
    );
    // currentVersion (100) excluded, target (102) included
    expect(result).toEqual(["patch-0.0.0-dev.101", "patch-0.0.0-dev.102"]);
  });

  test("excludes tags outside the range", () => {
    const tags = [
      "patch-0.0.0-dev.98",
      "patch-0.0.0-dev.101",
      "patch-0.0.0-dev.105",
    ];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.100",
      "0.0.0-dev.103"
    );
    expect(result).toEqual(["patch-0.0.0-dev.101"]);
  });

  test("sorts tags by version in ascending order", () => {
    // Tags arrive in arbitrary order from registry
    const tags = [
      "patch-0.0.0-dev.103",
      "patch-0.0.0-dev.101",
      "patch-0.0.0-dev.102",
    ];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.100",
      "0.0.0-dev.103"
    );
    expect(result).toEqual([
      "patch-0.0.0-dev.101",
      "patch-0.0.0-dev.102",
      "patch-0.0.0-dev.103",
    ]);
  });

  test("includes target version tag", () => {
    const tags = ["patch-0.0.0-dev.101"];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.100",
      "0.0.0-dev.101"
    );
    expect(result).toEqual(["patch-0.0.0-dev.101"]);
  });

  test("excludes current version tag", () => {
    const tags = ["patch-0.0.0-dev.100", "patch-0.0.0-dev.101"];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.100",
      "0.0.0-dev.101"
    );
    expect(result).toEqual(["patch-0.0.0-dev.101"]);
  });

  test("handles real-world version strings with timestamps", () => {
    const tags = [
      "patch-0.14.0-dev.1772661724",
      "patch-0.14.0-dev.1772732047",
      "patch-0.14.0-dev.1772800000",
    ];
    const result = filterAndSortChainTags(
      tags,
      "0.14.0-dev.1772661724",
      "0.14.0-dev.1772800000"
    );
    expect(result).toEqual([
      "patch-0.14.0-dev.1772732047",
      "patch-0.14.0-dev.1772800000",
    ]);
  });

  test("returns >10 tags for nightly chains (higher depth limit than stable)", () => {
    // Simulate 25 nightly builds — should all be returned since nightly
    // chains allow up to MAX_NIGHTLY_CHAIN_DEPTH (30) hops
    const tags = Array.from(
      { length: 25 },
      (_, i) => `patch-0.14.0-dev.${1000 + i + 1}`
    );
    const result = filterAndSortChainTags(
      tags,
      "0.14.0-dev.1000",
      "0.14.0-dev.1025"
    );
    expect(result).toHaveLength(25);
    expect(result[0]).toBe("patch-0.14.0-dev.1001");
    expect(result[24]).toBe("patch-0.14.0-dev.1025");
  });

  test("handles cross-minor version nightly chains", () => {
    // Versions crossing 0.16.x → 0.17.x boundary
    const tags = [
      "patch-0.16.0-dev.200",
      "patch-0.16.0-dev.300",
      "patch-0.17.0-dev.400",
      "patch-0.17.0-dev.500",
    ];
    const result = filterAndSortChainTags(
      tags,
      "0.16.0-dev.100",
      "0.17.0-dev.500"
    );
    expect(result).toEqual([
      "patch-0.16.0-dev.200",
      "patch-0.16.0-dev.300",
      "patch-0.17.0-dev.400",
      "patch-0.17.0-dev.500",
    ]);
  });

  test("returns single tag for single-hop upgrade", () => {
    const tags = [
      "patch-0.0.0-dev.100",
      "patch-0.0.0-dev.101",
      "patch-0.0.0-dev.102",
    ];
    const result = filterAndSortChainTags(
      tags,
      "0.0.0-dev.101",
      "0.0.0-dev.102"
    );
    expect(result).toEqual(["patch-0.0.0-dev.102"]);
  });
});

// validateChainStep

describe("validateChainStep", () => {
  const PATCH_LAYER_NAME = `${getPlatformBinaryName()}.patch`;

  function makeLayer(
    title: string,
    size: number
  ): OciManifest["layers"][number] {
    return {
      digest: `sha256:${title.replace(/\W/g, "")}`,
      mediaType: "application/octet-stream",
      size,
      annotations: { "org.opencontainers.image.title": title },
    };
  }

  test("returns version-mismatch when from-version differs", () => {
    const manifest = makePatchManifest("0.1.0", {}, [
      makeLayer(PATCH_LAYER_NAME, 500),
    ]);
    const result = validateChainStep(manifest, {
      expectedFrom: "0.0.9",
      patchLayerName: PATCH_LAYER_NAME,
      sizeLimit: 100_000,
    });
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: "version-mismatch",
        expected: "0.0.9",
        actual: "0.1.0",
      },
    });
  });

  test("returns missing-layer when platform layer is absent", () => {
    const manifest = makePatchManifest("0.0.9", {}, [
      makeLayer("sentry-other-platform.patch", 500),
    ]);
    const result = validateChainStep(manifest, {
      expectedFrom: "0.0.9",
      patchLayerName: PATCH_LAYER_NAME,
      sizeLimit: 100_000,
    });
    expect(result).toEqual({
      ok: false,
      failure: { reason: "missing-layer", layerName: PATCH_LAYER_NAME },
    });
  });

  test("returns size-exceeded when layer exceeds budget", () => {
    const manifest = makePatchManifest("0.0.9", {}, [
      makeLayer(PATCH_LAYER_NAME, 200_000),
    ]);
    const result = validateChainStep(manifest, {
      expectedFrom: "0.0.9",
      patchLayerName: PATCH_LAYER_NAME,
      sizeLimit: 100_000,
    });
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: "size-exceeded",
        layerSize: 200_000,
        budget: 100_000,
      },
    });
  });

  test("returns ok with digest and size on success", () => {
    const manifest = makePatchManifest("0.0.9", {}, [
      makeLayer(PATCH_LAYER_NAME, 500),
    ]);
    const result = validateChainStep(manifest, {
      expectedFrom: "0.0.9",
      patchLayerName: PATCH_LAYER_NAME,
      sizeLimit: 100_000,
    });
    expect(result).toEqual({
      ok: true,
      digest: `sha256:${PATCH_LAYER_NAME.replace(/\W/g, "")}`,
      size: 500,
    });
  });
});

// ===================================================================
// Async functions (fetch-mocked)
// ===================================================================

/** Helper to mock globalThis.fetch */
function mockFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

/** Store original fetch for restoration */
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// fetchRecentReleases

describe("fetchRecentReleases", () => {
  test("returns releases from GitHub API", async () => {
    const releases: GitHubRelease[] = [
      makeRelease("cli@0.14.0", [makeAsset({ name: "sentry-linux-x64" })]),
      makeRelease("cli@0.13.0", [makeAsset({ name: "sentry-linux-x64" })]),
      makeRelease("mcp@9.0.0", [makeAsset({ name: "sentry-linux-x64" })]),
    ];

    mockFetch(async (url) => {
      expect(String(url)).toContain(
        "api.github.com/repos/getsentry/toolkit/releases"
      );
      expect(String(url)).toContain("per_page=");
      return new Response(JSON.stringify(releases), { status: 200 });
    });

    const result = await fetchRecentReleases();
    expect(result).toHaveLength(2);
    expect(result[0]?.tag_name).toBe("0.14.0");
  });

  test.each([
    ["Toolkit", undefined, "cli@0.14.0-dev.1", "cli@0.14.0"],
    ["legacy", LEGACY_UPGRADE_SOURCE, "0.14.0-dev.1", "0.14.0"],
  ])("excludes semantic prereleases from the %s stable source", async (_name, source, prereleaseTag, stableTag) => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            { ...makeRelease(prereleaseTag, []), prerelease: false },
            makeRelease(stableTag, []),
          ]),
          { status: 200 }
        )
    );

    const result = await fetchRecentReleases(undefined, source);
    expect(result.map((release) => release.tag_name)).toEqual(["0.14.0"]);
  });

  test("uses the selected legacy GitHub repository", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await fetchRecentReleases(undefined, LEGACY_UPGRADE_SOURCE);

    expect(urls).toEqual([
      "https://api.github.com/repos/getsentry/cli/releases?per_page=12",
    ]);
  });

  test("returns empty array on HTTP error", async () => {
    mockFetch(async () => new Response("Server Error", { status: 500 }));

    const result = await fetchRecentReleases();
    expect(result).toEqual([]);
  });

  test("returns empty array on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await fetchRecentReleases();
    expect(result).toEqual([]);
  });
});

// downloadStablePatch

describe("downloadStablePatch", () => {
  test("returns Uint8Array on success", async () => {
    const patchData = new Uint8Array([1, 2, 3, 4, 5]);

    mockFetch(async (url) => {
      expect(String(url)).toBe("https://example.com/patch.bin");
      return new Response(patchData.buffer as ArrayBuffer, {
        status: 200,
      });
    });

    const result = await downloadStablePatch("https://example.com/patch.bin");
    expect(result).not.toBeNull();
    expect(result).toEqual(patchData);
  });

  test("returns null on HTTP 404", async () => {
    mockFetch(async () => new Response("Not Found", { status: 404 }));

    const result = await downloadStablePatch("https://example.com/missing.bin");
    expect(result).toBeNull();
  });

  test("returns null on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await downloadStablePatch("https://example.com/fail.bin");
    expect(result).toBeNull();
  });
});

// resolveStableChain (async orchestrator)

describe("resolveStableChain", () => {
  /**
   * Create a deterministic hex digest from a version string.
   * Reuses the same approach as the extractStableChain tests above.
   */
  function versionHex(version: string): string {
    return Array.from(version)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
  }

  /** Build a mock that serves both releases API and patch downloads */
  function setupStableMocks(
    releases: GitHubRelease[],
    patches: Map<string, Uint8Array>
  ): void {
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      const patchData = patches.get(urlStr);
      if (patchData) {
        return new Response(patchData.buffer as ArrayBuffer, {
          status: 200,
        });
      }
      return new Response("Not Found", { status: 404 });
    });
  }

  test("resolves prefixed Toolkit CLI releases and ignores other products", async () => {
    const binaryName = getPlatformBinaryName();
    const patchBytes = new Uint8Array([10, 20, 30]);
    const patchUrl = `https://github.com/getsentry/toolkit/releases/download/cli@0.14.0/${binaryName}.patch`;

    const releases: GitHubRelease[] = [
      makeRelease("mcp@9.0.0", [makeAsset({ name: binaryName })]),
      makeRelease("cli@0.14.0", [
        makeAsset({
          name: binaryName,
          digest: `sha256:${versionHex("0.14.0")}`,
        }),
        makeAsset({
          name: `${binaryName}.patch`,
          size: 100,
          browser_download_url: patchUrl,
        }),
        makeAsset({ name: `${binaryName}.gz`, size: 100_000 }),
      ]),
      makeRelease("cli@0.13.0", [makeAsset({ name: binaryName })]),
    ];

    setupStableMocks(releases, new Map([[patchUrl, patchBytes]]));

    const chain = await resolveStableChain("0.13.0", "0.14.0");
    expect(chain).not.toBeNull();
    expect(chain?.patches).toHaveLength(1);
    expect(chain?.patches[0]?.data).toEqual(patchBytes);
    expect(chain?.expectedSha256).toBe(versionHex("0.14.0"));
    expect(chain?.steps).toEqual([
      { fromVersion: "0.13.0", toVersion: "0.14.0" },
    ]);
  });

  test("keeps stable resolution on the selected legacy source", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response("Not Found", { status: 404 });
    });

    await expect(
      resolveStableChain("0.13.0", "0.14.0", undefined, LEGACY_UPGRADE_SOURCE)
    ).resolves.toBeNull();
    expect(urls).toEqual([
      "https://api.github.com/repos/getsentry/cli/releases?per_page=12",
    ]);
    expect(urls.every((url) => !url.includes("getsentry/toolkit"))).toBe(true);
  });

  test("resolves multi-hop chain with parallel downloads", async () => {
    const binaryName = getPlatformBinaryName();
    const patchA = new Uint8Array([1, 2]);
    const patchB = new Uint8Array([3, 4]);
    const urlA = "https://example.com/0.14.0.patch";
    const urlB = "https://example.com/0.15.0.patch";

    const releases: GitHubRelease[] = [
      makeRelease("cli@0.15.0", [
        makeAsset({
          name: binaryName,
          digest: `sha256:${versionHex("0.15.0")}`,
        }),
        makeAsset({
          name: `${binaryName}.patch`,
          size: 50,
          browser_download_url: urlB,
        }),
        makeAsset({ name: `${binaryName}.gz`, size: 100_000 }),
      ]),
      makeRelease("cli@0.14.0", [
        makeAsset({
          name: binaryName,
          digest: `sha256:${versionHex("0.14.0")}`,
        }),
        makeAsset({
          name: `${binaryName}.patch`,
          size: 50,
          browser_download_url: urlA,
        }),
        makeAsset({ name: `${binaryName}.gz`, size: 100_000 }),
      ]),
      makeRelease("cli@0.13.0", [makeAsset({ name: binaryName })]),
    ];

    setupStableMocks(
      releases,
      new Map([
        [urlA, patchA],
        [urlB, patchB],
      ])
    );

    const chain = await resolveStableChain("0.13.0", "0.15.0");
    expect(chain).not.toBeNull();
    expect(chain?.patches).toHaveLength(2);
    // Oldest patch first (apply order)
    expect(chain?.patches[0]?.data).toEqual(patchA);
    expect(chain?.patches[1]?.data).toEqual(patchB);
    expect(chain?.steps).toEqual([
      { fromVersion: "0.13.0", toVersion: "0.14.0" },
      { fromVersion: "0.14.0", toVersion: "0.15.0" },
    ]);
  });

  test("returns null when target not in releases", async () => {
    const releases: GitHubRelease[] = [
      makeRelease("cli@0.13.0", [makeAsset({ name: "sentry-linux-x64" })]),
    ];
    setupStableMocks(releases, new Map());

    const chain = await resolveStableChain("0.12.0", "0.14.0");
    expect(chain).toBeNull();
  });

  test("returns null when releases API fails", async () => {
    mockFetch(async () => new Response("Error", { status: 500 }));

    const chain = await resolveStableChain("0.12.0", "0.13.0");
    expect(chain).toBeNull();
  });

  test("returns null when a patch download fails", async () => {
    const binaryName = getPlatformBinaryName();
    const releases: GitHubRelease[] = [
      makeRelease("cli@0.14.0", [
        makeAsset({
          name: binaryName,
          digest: `sha256:${versionHex("0.14.0")}`,
        }),
        makeAsset({
          name: `${binaryName}.patch`,
          size: 100,
          browser_download_url: "https://example.com/missing.patch",
        }),
        makeAsset({ name: `${binaryName}.gz`, size: 100_000 }),
      ]),
      makeRelease("cli@0.13.0", [makeAsset({ name: binaryName })]),
    ];

    // Only mock releases API, no patch data available
    setupStableMocks(releases, new Map());

    const chain = await resolveStableChain("0.13.0", "0.14.0");
    expect(chain).toBeNull();
  });

  test("returns null when chain depth exceeds stable limit", async () => {
    const binaryName = getPlatformBinaryName();
    // 15 releases = 14 hops, exceeds MAX_STABLE_CHAIN_DEPTH (10)
    const versions = Array.from({ length: 15 }, (_, i) => `0.${i + 1}.0`);
    versions.reverse(); // newest first
    const releases = versions.map((v) =>
      makeRelease(`cli@${v}`, [
        makeAsset({ name: binaryName, digest: `sha256:${versionHex(v)}` }),
        makeAsset({
          name: `${binaryName}.patch`,
          size: 100,
          browser_download_url: `https://example.com/${v}.patch`,
        }),
        makeAsset({ name: `${binaryName}.gz`, size: 100_000 }),
      ])
    );

    setupStableMocks(releases, new Map());

    const chain = await resolveStableChain("0.1.0", "0.15.0");
    expect(chain).toBeNull();
  });
});

// resolveNightlyChain (async orchestrator)

describe("resolveNightlyChain", () => {
  const BINARY_NAME = getPlatformBinaryName();
  const PATCH_NAME = `${BINARY_NAME}.patch`;

  /** Set up GHCR mocks for tag listing, manifest fetches, and blob downloads */
  function setupNightlyMocks(
    tags: string[],
    manifests: Map<string, OciManifest>,
    blobs: Map<string, Uint8Array>
  ): void {
    mockFetch(async (url) => {
      const urlStr = String(url);

      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "test-token" }), {
          status: 200,
        });
      }

      if (urlStr.includes("/tags/list")) {
        return new Response(JSON.stringify({ tags }), {
          status: 200,
        });
      }

      const manifestMatch = urlStr.match(/\/manifests\/(.+)$/);
      if (manifestMatch) {
        const tag = manifestMatch[1];
        const manifest = manifests.get(tag ?? "");
        if (manifest) {
          return new Response(JSON.stringify(manifest), {
            status: 200,
          });
        }
        return new Response("Not Found", { status: 404 });
      }

      // Blob download — redirect then serve
      const blobMatch = urlStr.match(/\/blobs\/(sha256:[a-f0-9A-F]+)/);
      if (blobMatch) {
        const digest = blobMatch[1];
        const blobData = blobs.get(digest ?? "");
        if (blobData) {
          // Manual redirect response (redirect: "manual" is used by downloadNightlyBlob)
          return new Response(null, {
            status: 307,
            headers: { Location: `https://blob.test/${digest}` },
          });
        }
        return new Response("Not Found", { status: 404 });
      }

      // Follow redirect — serve blob by digest from URL
      if (urlStr.includes("blob.test/")) {
        const digestFromUrl = urlStr.split("blob.test/")[1];
        const blobData = blobs.get(digestFromUrl ?? "");
        if (blobData) {
          return new Response(blobData.buffer as ArrayBuffer, { status: 200 });
        }
      }

      return new Response("Not Found", { status: 404 });
    });
  }

  test("resolves single-hop nightly chain", async () => {
    const patchData = new Uint8Array([99, 88, 77]);
    const patchDigest = "sha256:aabbccdd1122334455";
    const patchManifest = makePatchManifest(
      "0.0.0-dev.100",
      { [BINARY_NAME]: "aabb1122" },
      [
        {
          digest: patchDigest,
          mediaType: "application/octet-stream",
          size: 100,
          annotations: {
            "org.opencontainers.image.title": PATCH_NAME,
          },
        },
      ]
    );

    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map([["patch-0.0.0-dev.101", patchManifest]]),
      new Map([[patchDigest, patchData]])
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.101",
      fullGzSize: 100_000,
    });

    expect(chain).not.toBeNull();
    expect(chain?.patches).toHaveLength(1);
    expect(chain?.expectedSha256).toBe("aabb1122");
    expect(chain?.steps).toEqual([
      { fromVersion: "0.0.0-dev.100", toVersion: "0.0.0-dev.101" },
    ]);
  });

  test("keeps nightly resolution on the selected legacy source", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ tags: [] }), { status: 200 });
    });

    await expect(
      resolveNightlyChain({
        token: "test-token",
        currentVersion: "0.0.0-dev.100",
        targetVersion: "0.0.0-dev.101",
        fullGzSize: 100_000,
        source: LEGACY_UPGRADE_SOURCE,
      })
    ).resolves.toBeNull();
    expect(urls).toEqual(["https://ghcr.io/v2/getsentry/cli/tags/list?n=100"]);
    expect(urls.every((url) => !url.includes("getsentry/toolkit"))).toBe(true);
  });

  test("returns null when no matching patches in graph", async () => {
    setupNightlyMocks([], new Map(), new Map());

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.102",
      fullGzSize: 100_000,
    });

    expect(chain).toBeNull();
  });

  test("returns null when chain depth exceeds MAX_NIGHTLY_CHAIN_DEPTH (30)", async () => {
    // 35 tags exceeds the nightly limit of 30
    const tags = Array.from(
      { length: 35 },
      (_, i) => `patch-0.0.0-dev.${101 + i}`
    );

    setupNightlyMocks(tags, new Map(), new Map());

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.135",
      fullGzSize: 100_000,
      preloadedTags: tags,
    });

    expect(chain).toBeNull();
  });

  test("resolves multi-hop nightly chain", async () => {
    const patchA = new Uint8Array([10, 20]);
    const patchB = new Uint8Array([30, 40]);
    const digestA = "sha256:aaaa1111";
    const digestB = "sha256:bbbb2222";

    const manifestA = makePatchManifest("0.0.0-dev.100", {}, [
      {
        digest: digestA,
        mediaType: "application/octet-stream",
        size: 50,
        annotations: {
          "org.opencontainers.image.title": PATCH_NAME,
        },
      },
    ]);

    const manifestB = makePatchManifest(
      "0.0.0-dev.101",
      { [BINARY_NAME]: "finalhash" },
      [
        {
          digest: digestB,
          mediaType: "application/octet-stream",
          size: 60,
          annotations: {
            "org.opencontainers.image.title": PATCH_NAME,
          },
        },
      ]
    );

    setupNightlyMocks(
      ["patch-0.0.0-dev.101", "patch-0.0.0-dev.102"],
      new Map([
        ["patch-0.0.0-dev.101", manifestA],
        ["patch-0.0.0-dev.102", manifestB],
      ]),
      new Map([
        [digestA, patchA],
        [digestB, patchB],
      ])
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.102",
      fullGzSize: 100_000,
    });

    expect(chain).not.toBeNull();
    expect(chain?.patches).toHaveLength(2);
    expect(chain?.patches[0]?.data).toEqual(patchA);
    expect(chain?.patches[1]?.data).toEqual(patchB);
    expect(chain?.expectedSha256).toBe("finalhash");
    expect(chain?.steps).toEqual([
      { fromVersion: "0.0.0-dev.100", toVersion: "0.0.0-dev.101" },
      { fromVersion: "0.0.0-dev.101", toVersion: "0.0.0-dev.102" },
    ]);
  });

  test("returns null when from-version does not match chain linkage", async () => {
    // Manifest claims from-version is dev.99 but chain expects dev.100
    const patchManifest = makePatchManifest(
      "0.0.0-dev.99", // wrong — should be dev.100
      { [BINARY_NAME]: "aabb1122" },
      [
        {
          digest: "sha256:dd1122",
          mediaType: "application/octet-stream",
          size: 50,
          annotations: {
            "org.opencontainers.image.title": PATCH_NAME,
          },
        },
      ]
    );

    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map([["patch-0.0.0-dev.101", patchManifest]]),
      new Map()
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.101",
      fullGzSize: 100_000,
    });

    expect(chain).toBeNull();
  });

  test("returns null when patch layer exceeds size budget", async () => {
    // Patch layer size (90_000) > fullGzSize * 0.6 (60_000)
    const patchManifest = makePatchManifest(
      "0.0.0-dev.100",
      { [BINARY_NAME]: "aabb1122" },
      [
        {
          digest: "sha256:bigpatch",
          mediaType: "application/octet-stream",
          size: 90_000,
          annotations: {
            "org.opencontainers.image.title": PATCH_NAME,
          },
        },
      ]
    );

    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map([["patch-0.0.0-dev.101", patchManifest]]),
      new Map()
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.101",
      fullGzSize: 100_000,
    });

    expect(chain).toBeNull();
  });

  test("returns null when manifest fetch fails for a chain tag", async () => {
    // Tag exists but manifest 404s — fetchChainManifests catches the error
    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map(), // no manifests — will 404
      new Map()
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.101",
      fullGzSize: 100_000,
    });

    expect(chain).toBeNull();
  });

  test("returns null when last tag version does not match target", async () => {
    // Chain has patch-dev.101 but target is dev.102 — chain stops short
    const patchManifest = makePatchManifest(
      "0.0.0-dev.100",
      { [BINARY_NAME]: "aabb1122" },
      [
        {
          digest: "sha256:dd1122",
          mediaType: "application/octet-stream",
          size: 50,
          annotations: {
            "org.opencontainers.image.title": PATCH_NAME,
          },
        },
      ]
    );

    // Only patch-dev.101 is in the graph, but target is dev.102
    // filterAndSortChainTags will include dev.101 (it's in range)
    // but the last tag (dev.101) != targetVersion (dev.102)
    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map([["patch-0.0.0-dev.101", patchManifest]]),
      new Map()
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.102",
      fullGzSize: 100_000,
      preloadedTags: ["patch-0.0.0-dev.101"],
    });

    expect(chain).toBeNull();
  });

  test("returns null when target manifest lacks sha256 annotation", async () => {
    // Manifest is valid but missing the sha256-<binary> annotation
    const patchManifest = makePatchManifest(
      "0.0.0-dev.100",
      {}, // no sha256 annotations
      [
        {
          digest: "sha256:dd1122",
          mediaType: "application/octet-stream",
          size: 50,
          annotations: {
            "org.opencontainers.image.title": PATCH_NAME,
          },
        },
      ]
    );

    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map([["patch-0.0.0-dev.101", patchManifest]]),
      new Map()
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.101",
      fullGzSize: 100_000,
    });

    expect(chain).toBeNull();
  });

  test("returns null when patch layer name is missing from manifest", async () => {
    // Manifest has a layer but with a different title
    const patchManifest = makePatchManifest(
      "0.0.0-dev.100",
      { [BINARY_NAME]: "aabb1122" },
      [
        {
          digest: "sha256:dd1122",
          mediaType: "application/octet-stream",
          size: 50,
          annotations: {
            "org.opencontainers.image.title": "wrong-name.patch",
          },
        },
      ]
    );

    setupNightlyMocks(
      ["patch-0.0.0-dev.101"],
      new Map([["patch-0.0.0-dev.101", patchManifest]]),
      new Map()
    );

    const chain = await resolveNightlyChain({
      token: "test-token",
      currentVersion: "0.0.0-dev.100",
      targetVersion: "0.0.0-dev.101",
      fullGzSize: 100_000,
    });

    expect(chain).toBeNull();
  });
});

// applyPatchChain (real filesystem + TRDIFF10 fixtures)

describe("applyPatchChain", () => {
  const fixturesDir = join(import.meta.dirname, "../fixtures/patches");

  /** Generate a unique temp file path */
  function tempFile(name: string): string {
    return join(tmpdir(), `delta-test-${Date.now()}-${name}`);
  }

  test("applies single-patch chain and verifies SHA-256", async () => {
    const oldPath = join(fixturesDir, "small-old.bin");
    const destPath = tempFile("single-chain-out.bin");
    const patchData = await readFile(join(fixturesDir, "small.trdiff10"));
    const expectedNewData = await readFile(join(fixturesDir, "small-new.bin"));

    const expectedSha256 = createHash("sha256")
      .update(expectedNewData)
      .digest("hex");

    const chain: PatchChain = {
      patches: [
        {
          data: new Uint8Array(patchData),
          size: patchData.byteLength,
        },
      ],
      totalSize: patchData.byteLength,
      expectedSha256,
    };

    try {
      const sha256 = await applyPatchChain(chain, oldPath, destPath);
      expect(sha256).toBe(expectedSha256);

      // Verify output matches expected
      const outputData = await readFile(destPath);
      expect(outputData).toEqual(expectedNewData);
    } finally {
      if (existsSync(destPath)) {
        unlinkSync(destPath);
      }
    }
  });

  test("throws on SHA-256 mismatch", async () => {
    const oldPath = join(fixturesDir, "small-old.bin");
    const destPath = tempFile("mismatch-out.bin");
    const patchData = await readFile(join(fixturesDir, "small.trdiff10"));

    const chain: PatchChain = {
      patches: [
        {
          data: new Uint8Array(patchData),
          size: patchData.byteLength,
        },
      ],
      totalSize: patchData.byteLength,
      expectedSha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };

    try {
      await expect(applyPatchChain(chain, oldPath, destPath)).rejects.toThrow(
        "SHA-256 mismatch"
      );
    } finally {
      if (existsSync(destPath)) {
        unlinkSync(destPath);
      }
    }
  });

  test("applies multi-step chains in memory without intermediate files", async () => {
    // Intermediate hops are kept in memory, so the legacy `.patching.a`/`.b`
    // scratch files must never be written. We only have one-step fixtures, so
    // reuse the same patch twice: the first hop produces valid bytes, the
    // second applies to mismatched bytes and fails final-hash verification —
    // but either way no intermediate file should touch disk.
    const oldPath = join(fixturesDir, "small-old.bin");
    const destPath = tempFile("multi-chain-out.bin");
    const intermediateA = `${destPath}.patching.a`;
    const intermediateB = `${destPath}.patching.b`;
    const patchData = await readFile(join(fixturesDir, "small.trdiff10"));

    const chain: PatchChain = {
      patches: [
        {
          data: new Uint8Array(patchData),
          size: patchData.byteLength,
        },
        {
          data: new Uint8Array(patchData),
          size: patchData.byteLength,
        },
      ],
      totalSize: patchData.byteLength * 2,
      expectedSha256: "anything",
    };

    try {
      await applyPatchChain(chain, oldPath, destPath).catch(() => {
        // Expected — second patch applied to mismatched bytes fails verification
      });

      // The in-memory chain never creates scratch files on disk.
      expect(existsSync(intermediateA)).toBe(false);
      expect(existsSync(intermediateB)).toBe(false);
    } finally {
      for (const p of [destPath, intermediateA, intermediateB]) {
        if (existsSync(p)) {
          unlinkSync(p);
        }
      }
    }
  });

  test("creates output file that is readable", async () => {
    const oldPath = join(fixturesDir, "small-old.bin");
    const destPath = tempFile("output-readable.bin");
    const patchData = await readFile(join(fixturesDir, "small.trdiff10"));
    const expectedNewData = await readFile(join(fixturesDir, "small-new.bin"));
    const expectedSha256 = createHash("sha256")
      .update(expectedNewData)
      .digest("hex");

    const chain: PatchChain = {
      patches: [
        {
          data: new Uint8Array(patchData),
          size: patchData.byteLength,
        },
      ],
      totalSize: patchData.byteLength,
      expectedSha256,
    };

    try {
      await applyPatchChain(chain, oldPath, destPath);

      expect(
        await access(destPath).then(
          () => true,
          () => false
        )
      ).toBe(true);
    } finally {
      if (existsSync(destPath)) {
        unlinkSync(destPath);
      }
    }
  });
});

// resolveStableDelta (high-level orchestrator)
// CLI_VERSION is "0.0.0-dev" in test mode, so chain resolution returns null.
// This still exercises the function entry, chain check, and null-return path.

describe("resolveStableDelta", () => {
  test("returns null when current version is dev", async () => {
    // Mock fetch to return releases (won't match "0.0.0-dev")
    mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            makeRelease("0.14.0", [
              makeAsset({ name: "sentry-linux-x64.patch" }),
            ]),
          ]),
          { status: 200 }
        )
    );

    const result = await resolveStableDelta(
      "0.14.0",
      "/tmp/fake-old",
      "/tmp/fake-out"
    );
    expect(result).toBeNull();
  });
});

// resolveNightlyDelta (high-level orchestrator)

describe("resolveNightlyDelta", () => {
  const BINARY_NAME_ND = getPlatformBinaryName();

  /** Set up GHCR mocks for the full resolveNightlyDelta flow */
  function setupFullNightlyMocks(opts: {
    targetVersion: string;
    targetManifest: OciManifest;
    patchTags: string[];
    patchManifests: Map<string, OciManifest>;
    blobs: Map<string, Uint8Array>;
  }): void {
    mockFetch(async (url) => {
      const urlStr = String(url);

      // Token exchange
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "test-token" }), {
          status: 200,
        });
      }

      // Tag listing
      if (urlStr.includes("/tags/list")) {
        return new Response(JSON.stringify({ tags: opts.patchTags }), {
          status: 200,
        });
      }

      // Manifest fetch — target nightly or patch manifests
      const manifestMatch = urlStr.match(/\/manifests\/(.+)$/);
      if (manifestMatch) {
        const tag = manifestMatch[1] ?? "";
        if (tag === `nightly-${opts.targetVersion}`) {
          return new Response(JSON.stringify(opts.targetManifest), {
            status: 200,
          });
        }
        const patchManifest = opts.patchManifests.get(tag);
        if (patchManifest) {
          return new Response(JSON.stringify(patchManifest), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      }

      // Blob redirect
      const blobMatch = urlStr.match(/\/blobs\/(sha256:[a-f0-9A-F]+)/);
      if (blobMatch) {
        const digest = blobMatch[1] ?? "";
        if (opts.blobs.has(digest)) {
          return new Response(null, {
            status: 307,
            headers: { Location: `https://blob.test/${digest}` },
          });
        }
        return new Response("Not Found", { status: 404 });
      }

      // Follow redirect
      if (urlStr.includes("blob.test/")) {
        const digestFromUrl = urlStr.split("blob.test/")[1] ?? "";
        const blobData = opts.blobs.get(digestFromUrl);
        if (blobData) {
          return new Response(blobData.buffer as ArrayBuffer, { status: 200 });
        }
      }

      return new Response("Not Found", { status: 404 });
    });
  }

  test("returns null when GHCR token fetch fails", async () => {
    mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    await expect(
      resolveNightlyDelta("0.14.0-dev.123", "/tmp/fake-old", "/tmp/fake-out")
    ).resolves.toBeNull();
  });

  test("returns null when no patch tags exist for the version range", async () => {
    // Target manifest exists with .gz layer, but no patch tags match
    // Exercises: resolveNightlyChainWithContext → resolveAndApplyDelta null path
    const targetManifest: OciManifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: "sha256:config",
        mediaType: "application/vnd.oci.empty.v1+json",
        size: 2,
      },
      layers: [
        {
          digest: "sha256:targetgz",
          mediaType: "application/octet-stream",
          size: 100_000,
          annotations: {
            "org.opencontainers.image.title": `${BINARY_NAME_ND}.gz`,
          },
        },
      ],
      annotations: {},
    };

    setupFullNightlyMocks({
      targetVersion: "0.14.0-dev.200",
      targetManifest,
      patchTags: [], // no patches
      patchManifests: new Map(),
      blobs: new Map(),
    });

    const result = await resolveNightlyDelta(
      "0.14.0-dev.200",
      "/tmp/fake-old",
      "/tmp/fake-out"
    );
    expect(result).toBeNull();
  });

  test("returns null when target manifest has no .gz layer", async () => {
    // Target manifest exists but lacks the .gz layer needed for size threshold
    // Exercises: resolveNightlyChainWithContext gzLayer null check
    const targetManifest: OciManifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: "sha256:config",
        mediaType: "application/vnd.oci.empty.v1+json",
        size: 2,
      },
      layers: [
        {
          digest: "sha256:onlypatch",
          mediaType: "application/octet-stream",
          size: 500,
          annotations: {
            "org.opencontainers.image.title": `${BINARY_NAME_ND}.patch`,
          },
        },
      ],
      annotations: {},
    };

    setupFullNightlyMocks({
      targetVersion: "0.14.0-dev.200",
      targetManifest,
      patchTags: ["patch-0.14.0-dev.200"],
      patchManifests: new Map(),
      blobs: new Map(),
    });

    const result = await resolveNightlyDelta(
      "0.14.0-dev.200",
      "/tmp/fake-old",
      "/tmp/fake-out"
    );
    expect(result).toBeNull();
  });
});

// attemptDeltaUpgrade (top-level orchestrator)

describe("attemptDeltaUpgrade", () => {
  test("returns null when canAttemptDelta is false (dev version)", async () => {
    const result = await attemptDeltaUpgrade(
      "0.14.0",
      "/tmp/fake-old",
      "/tmp/fake-out"
    );
    expect(result).toBeNull();
  });
});

// prefetch functions (background version-check optimization)
// CLI_VERSION is "0.0.0-dev" in test, so canAttemptDelta bails early.
// This exercises the function entry and the guard in prefetchAndCache.

describe("prefetchNightlyPatches", () => {
  test("returns immediately when CLI_VERSION is dev", async () => {
    // Should not make any fetch calls since canAttemptDelta returns false
    mockFetch(async () => {
      throw new Error("fetch should not be called");
    });

    await prefetchNightlyPatches("0.14.0-dev.123");
  });
});

describe("prefetchStablePatches", () => {
  test("returns immediately when CLI_VERSION is dev", async () => {
    mockFetch(async () => {
      throw new Error("fetch should not be called");
    });

    await prefetchStablePatches("0.14.0");
  });
});

async function importDeltaUpgradeWithVersion(version: string) {
  vi.resetModules();
  vi.doMock("../../src/lib/constants.js", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../../src/lib/constants.js")>();
    return { ...actual, CLI_VERSION: version };
  });
  return import("../../src/lib/delta-upgrade.js");
}

function restoreDeltaUpgradeModule(): void {
  vi.doUnmock("../../src/lib/constants.js");
  vi.resetModules();
}

describe("selected source affinity", () => {
  useTestConfigDir("delta-source-affinity-");
  afterEach(restoreDeltaUpgradeModule);

  test("attemptDeltaUpgrade keeps stable requests on the legacy source", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response("Not Found", { status: 404 });
    });
    const versionedDelta = await importDeltaUpgradeWithVersion("0.13.0");

    await expect(
      versionedDelta.attemptDeltaUpgrade(
        "0.14.0",
        "/tmp/fake-old",
        "/tmp/fake-out",
        false,
        undefined,
        LEGACY_UPGRADE_SOURCE
      )
    ).resolves.toBeNull();
    expect(urls).toEqual([
      "https://api.github.com/repos/getsentry/cli/releases?per_page=12",
    ]);
    expect(urls.every((url) => !url.includes("getsentry/toolkit"))).toBe(true);
  });

  test("attemptDeltaUpgrade keeps nightly requests on the legacy source", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response("Unauthorized", { status: 401 });
    });
    const versionedDelta =
      await importDeltaUpgradeWithVersion("0.14.0-dev.100");

    await expect(
      versionedDelta.attemptDeltaUpgrade(
        "0.14.0-dev.101",
        "/tmp/fake-old",
        "/tmp/fake-out",
        false,
        undefined,
        LEGACY_UPGRADE_SOURCE
      )
    ).resolves.toBeNull();
    expect(urls).toEqual([
      "https://ghcr.io/token?scope=repository:getsentry/cli:pull",
    ]);
    expect(urls.every((url) => !url.includes("getsentry/toolkit"))).toBe(true);
  });

  test("prefetchStablePatches keeps requests on the legacy source", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response("Not Found", { status: 404 });
    });
    const versionedDelta = await importDeltaUpgradeWithVersion("0.13.0");

    await versionedDelta.prefetchStablePatches(
      "0.14.0",
      undefined,
      LEGACY_UPGRADE_SOURCE
    );
    expect(urls).toEqual([
      "https://api.github.com/repos/getsentry/cli/releases?per_page=12",
    ]);
    expect(urls.every((url) => !url.includes("getsentry/toolkit"))).toBe(true);
  });

  test("prefetchNightlyPatches keeps requests on the legacy source", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response("Unauthorized", { status: 401 });
    });
    const versionedDelta =
      await importDeltaUpgradeWithVersion("0.14.0-dev.100");

    await versionedDelta.prefetchNightlyPatches(
      "0.14.0-dev.101",
      undefined,
      LEGACY_UPGRADE_SOURCE
    );
    expect(urls).toEqual([
      "https://ghcr.io/token?scope=repository:getsentry/cli:pull",
    ]);
    expect(urls.every((url) => !url.includes("getsentry/toolkit"))).toBe(true);
  });
});
