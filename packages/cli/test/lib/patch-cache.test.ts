/**
 * Unit Tests for Patch Cache Module
 *
 * Tests the file-based cache for delta upgrade patches, including
 * save, load, stitching from multiple runs, and cleanup.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ChainMeta,
  chainFileName,
  cleanupPatchCache,
  clearPatchCache,
  loadCachedChain,
  patchFileName,
  savePatchesToCache,
} from "../../src/lib/patch-cache.js";
import { useTestConfigDir } from "../helpers.js";

// All tests need an isolated config dir to store patch cache files
const getConfigDir = useTestConfigDir("patch-cache-test-");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the patch-cache subdirectory path */
function getCacheDir(): string {
  return join(getConfigDir(), "patch-cache");
}

/** Build a simple patch chain for testing */
function makeChain(
  patchDataList: Uint8Array[],
  expectedSha256: string
): {
  patches: { data: Uint8Array; size: number }[];
  expectedSha256: string;
} {
  return {
    patches: patchDataList.map((data) => ({ data, size: data.byteLength })),
    expectedSha256,
  };
}

/** Build version steps for a sequential chain */
function makeSteps(
  versions: string[]
): { fromVersion: string; toVersion: string }[] {
  const steps: { fromVersion: string; toVersion: string }[] = [];
  for (let i = 0; i < versions.length - 1; i++) {
    const from = versions[i];
    const to = versions[i + 1];
    if (from && to) {
      steps.push({ fromVersion: from, toVersion: to });
    }
  }
  return steps;
}

// ===========================================================================
// patchFileName & chainFileName
// ===========================================================================

describe("patchFileName", () => {
  test("produces expected format for simple versions", () => {
    expect(patchFileName("0.13.0", "0.14.0")).toBe("0.13.0-0.14.0.patch");
  });

  test("sanitizes special characters in version strings", () => {
    expect(patchFileName("0.14.0-dev.100", "0.14.0-dev.101")).toBe(
      "0.14.0-dev.100-0.14.0-dev.101.patch"
    );
  });

  test("replaces non-safe characters with underscore", () => {
    expect(patchFileName("1.0.0+build", "1.0.1+build")).toBe(
      "1.0.0_build-1.0.1_build.patch"
    );
  });
});

describe("chainFileName", () => {
  test("produces expected format", () => {
    expect(chainFileName("0.13.0", "0.14.0")).toBe("chain-0.13.0-0.14.0.json");
  });

  test("handles nightly versions", () => {
    expect(chainFileName("0.14.0-dev.100", "0.14.0-dev.101")).toBe(
      "chain-0.14.0-dev.100-0.14.0-dev.101.json"
    );
  });
});

// ===========================================================================
// savePatchesToCache
// ===========================================================================

describe("savePatchesToCache", () => {
  test("creates cache directory and saves patch + metadata files", async () => {
    const patchData = new Uint8Array([1, 2, 3, 4, 5]);
    const chain = makeChain([patchData], "abc123");
    const steps = [{ fromVersion: "0.13.0", toVersion: "0.14.0" }];

    await savePatchesToCache(chain, steps);

    const cacheDir = getCacheDir();
    expect(existsSync(cacheDir)).toBe(true);

    // Verify patch file
    const patchFilePath = join(cacheDir, patchFileName("0.13.0", "0.14.0"));
    expect(
      await access(patchFilePath).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(new Uint8Array(await readFile(patchFilePath))).toEqual(patchData);

    // Verify chain metadata
    const metaFilePath = join(cacheDir, chainFileName("0.13.0", "0.14.0"));
    expect(
      await access(metaFilePath).then(
        () => true,
        () => false
      )
    ).toBe(true);
    const meta = JSON.parse(await readFile(metaFilePath, "utf-8")) as ChainMeta;
    expect(meta.fromVersion).toBe("0.13.0");
    expect(meta.toVersion).toBe("0.14.0");
    expect(meta.expectedSha256).toBe("abc123");
    expect(meta.patches).toHaveLength(1);
    expect(meta.cachedAt).toBeGreaterThan(0);
  });

  test("saves multi-step chain with correct metadata", async () => {
    const patches = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
    ];
    const chain = makeChain(patches, "target-hash");
    const steps = makeSteps(["0.12.0", "0.13.0", "0.14.0", "0.15.0"]);

    await savePatchesToCache(chain, steps);

    const cacheDir = getCacheDir();
    // All 3 patch files
    expect(
      await access(join(cacheDir, patchFileName("0.12.0", "0.13.0"))).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(
      await access(join(cacheDir, patchFileName("0.13.0", "0.14.0"))).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(
      await access(join(cacheDir, patchFileName("0.14.0", "0.15.0"))).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Chain metadata spans 0.12.0 → 0.15.0
    const metaFilePath2 = join(cacheDir, chainFileName("0.12.0", "0.15.0"));
    const meta = JSON.parse(
      await readFile(metaFilePath2, "utf-8")
    ) as ChainMeta;
    expect(meta.patches).toHaveLength(3);
    expect(meta.expectedSha256).toBe("target-hash");
  });

  test("handles empty steps gracefully", async () => {
    const chain = makeChain([], "nope");
    await savePatchesToCache(chain, []);
    // Should not create cache dir or fail
  });
});

// ===========================================================================
// loadCachedChain
// ===========================================================================

describe("loadCachedChain", () => {
  test("loads a single-hop cached chain", async () => {
    const patchData = new Uint8Array([10, 20, 30]);
    const chain = makeChain([patchData], "sha-single");
    const steps = [{ fromVersion: "0.13.0", toVersion: "0.14.0" }];

    await savePatchesToCache(chain, steps);

    const result = await loadCachedChain("0.13.0", "0.14.0");
    expect(result).not.toBeNull();
    expect(result?.patches).toHaveLength(1);
    expect(result?.patches[0]?.data).toEqual(patchData);
    expect(result?.totalSize).toBe(3);
    expect(result?.expectedSha256).toBe("sha-single");
  });

  test("loads a multi-hop cached chain", async () => {
    const patchA = new Uint8Array([1, 2]);
    const patchB = new Uint8Array([3, 4, 5]);
    const chain = makeChain([patchA, patchB], "sha-multi");
    const steps = makeSteps(["0.12.0", "0.13.0", "0.14.0"]);

    await savePatchesToCache(chain, steps);

    const result = await loadCachedChain("0.12.0", "0.14.0");
    expect(result).not.toBeNull();
    expect(result?.patches).toHaveLength(2);
    expect(result?.patches[0]?.data).toEqual(patchA);
    expect(result?.patches[1]?.data).toEqual(patchB);
    expect(result?.totalSize).toBe(5);
    expect(result?.expectedSha256).toBe("sha-multi");
  });

  test("stitches patches from multiple version check runs", async () => {
    // First run: caches 0.12→0.13
    const patchA = new Uint8Array([10]);
    await savePatchesToCache(makeChain([patchA], "sha-a"), [
      { fromVersion: "0.12.0", toVersion: "0.13.0" },
    ]);

    // Second run: caches 0.13→0.14 with updated target hash
    const patchB = new Uint8Array([20]);
    await savePatchesToCache(makeChain([patchB], "sha-final"), [
      { fromVersion: "0.13.0", toVersion: "0.14.0" },
    ]);

    // Load full chain 0.12→0.14 — stitches both patches
    const result = await loadCachedChain("0.12.0", "0.14.0");
    expect(result).not.toBeNull();
    expect(result?.patches).toHaveLength(2);
    expect(result?.patches[0]?.data).toEqual(patchA);
    expect(result?.patches[1]?.data).toEqual(patchB);
    expect(result?.expectedSha256).toBe("sha-final");
  });

  test("returns null when cache directory does not exist", async () => {
    const result = await loadCachedChain("0.13.0", "0.14.0");
    expect(result).toBeNull();
  });

  test("returns null when chain metadata is missing", async () => {
    // Create cache dir with just a patch file (no metadata)
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, patchFileName("0.13.0", "0.14.0")),
      new Uint8Array([1, 2, 3])
    );

    const result = await loadCachedChain("0.13.0", "0.14.0");
    expect(result).toBeNull();
  });

  test("returns null when patch file is missing", async () => {
    // Create metadata without the actual patch file
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const meta: ChainMeta = {
      fromVersion: "0.13.0",
      toVersion: "0.14.0",
      expectedSha256: "abc",
      cachedAt: Date.now(),
      patches: [{ fromVersion: "0.13.0", toVersion: "0.14.0", size: 100 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.13.0", "0.14.0")),
      JSON.stringify(meta)
    );

    const result = await loadCachedChain("0.13.0", "0.14.0");
    expect(result).toBeNull();
  });

  test("returns null when intermediate step is missing", async () => {
    // Cache 0.12→0.13 and 0.14→0.15 but not 0.13→0.14
    const patchA = new Uint8Array([10]);
    await savePatchesToCache(makeChain([patchA], "sha-a"), [
      { fromVersion: "0.12.0", toVersion: "0.13.0" },
    ]);
    const patchB = new Uint8Array([20]);
    await savePatchesToCache(makeChain([patchB], "sha-b"), [
      { fromVersion: "0.14.0", toVersion: "0.15.0" },
    ]);

    const result = await loadCachedChain("0.12.0", "0.15.0");
    expect(result).toBeNull();
  });

  test("returns null when expectedSha256 is missing from metadata", async () => {
    // Create metadata with empty expectedSha256
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const meta: ChainMeta = {
      fromVersion: "0.13.0",
      toVersion: "0.14.0",
      expectedSha256: "",
      cachedAt: Date.now(),
      patches: [{ fromVersion: "0.13.0", toVersion: "0.14.0", size: 3 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.13.0", "0.14.0")),
      JSON.stringify(meta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.13.0", "0.14.0")),
      new Uint8Array([1, 2, 3])
    );

    const result = await loadCachedChain("0.13.0", "0.14.0");
    expect(result).toBeNull();
  });

  test("handles corrupt metadata JSON gracefully", async () => {
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "chain-0.13.0-0.14.0.json"),
      "not valid json!!!"
    );

    const result = await loadCachedChain("0.13.0", "0.14.0");
    expect(result).toBeNull();
  });

  test("handles nightly version strings", async () => {
    const patchData = new Uint8Array([42]);
    const chain = makeChain([patchData], "nightly-sha");
    const steps = [
      { fromVersion: "0.14.0-dev.100", toVersion: "0.14.0-dev.101" },
    ];

    await savePatchesToCache(chain, steps);

    const result = await loadCachedChain("0.14.0-dev.100", "0.14.0-dev.101");
    expect(result).not.toBeNull();
    expect(result?.patches[0]?.data).toEqual(patchData);
    expect(result?.expectedSha256).toBe("nightly-sha");
  });
});

// ===========================================================================
// cleanupPatchCache
// ===========================================================================

describe("cleanupPatchCache", () => {
  test("does nothing when cache directory does not exist", async () => {
    // Should not throw
    await cleanupPatchCache();
  });

  test("removes entries older than 7 days", async () => {
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // Create an old chain entry (8 days ago)
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const meta: ChainMeta = {
      fromVersion: "0.13.0",
      toVersion: "0.14.0",
      expectedSha256: "old-sha",
      cachedAt: eightDaysAgo,
      patches: [{ fromVersion: "0.13.0", toVersion: "0.14.0", size: 10 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.13.0", "0.14.0")),
      JSON.stringify(meta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.13.0", "0.14.0")),
      new Uint8Array([1, 2, 3])
    );

    await cleanupPatchCache();

    // Both metadata and patch file should be removed
    expect(existsSync(join(cacheDir, chainFileName("0.13.0", "0.14.0")))).toBe(
      false
    );
    expect(existsSync(join(cacheDir, patchFileName("0.13.0", "0.14.0")))).toBe(
      false
    );
  });

  test("preserves entries less than 7 days old", async () => {
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // Create a fresh chain entry (1 hour ago)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const meta: ChainMeta = {
      fromVersion: "0.13.0",
      toVersion: "0.14.0",
      expectedSha256: "fresh-sha",
      cachedAt: oneHourAgo,
      patches: [{ fromVersion: "0.13.0", toVersion: "0.14.0", size: 10 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.13.0", "0.14.0")),
      JSON.stringify(meta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.13.0", "0.14.0")),
      new Uint8Array([1, 2, 3])
    );

    await cleanupPatchCache();

    // Both files should still exist
    expect(existsSync(join(cacheDir, chainFileName("0.13.0", "0.14.0")))).toBe(
      true
    );
    expect(existsSync(join(cacheDir, patchFileName("0.13.0", "0.14.0")))).toBe(
      true
    );
  });

  test("removes corrupt metadata files", async () => {
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const corruptPath = join(cacheDir, "chain-corrupt-0.14.0.json");
    writeFileSync(corruptPath, "not json");

    await cleanupPatchCache();

    expect(existsSync(corruptPath)).toBe(false);
  });

  test("handles mixed old and fresh entries", async () => {
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // Old entry
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oldMeta: ChainMeta = {
      fromVersion: "0.12.0",
      toVersion: "0.13.0",
      expectedSha256: "old",
      cachedAt: eightDaysAgo,
      patches: [{ fromVersion: "0.12.0", toVersion: "0.13.0", size: 10 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.12.0", "0.13.0")),
      JSON.stringify(oldMeta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.12.0", "0.13.0")),
      new Uint8Array([1])
    );

    // Fresh entry
    const freshMeta: ChainMeta = {
      fromVersion: "0.13.0",
      toVersion: "0.14.0",
      expectedSha256: "fresh",
      cachedAt: Date.now(),
      patches: [{ fromVersion: "0.13.0", toVersion: "0.14.0", size: 10 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.13.0", "0.14.0")),
      JSON.stringify(freshMeta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.13.0", "0.14.0")),
      new Uint8Array([2])
    );

    await cleanupPatchCache();

    // Old entry removed
    expect(existsSync(join(cacheDir, chainFileName("0.12.0", "0.13.0")))).toBe(
      false
    );
    expect(existsSync(join(cacheDir, patchFileName("0.12.0", "0.13.0")))).toBe(
      false
    );

    // Fresh entry preserved
    expect(existsSync(join(cacheDir, chainFileName("0.13.0", "0.14.0")))).toBe(
      true
    );
    expect(existsSync(join(cacheDir, patchFileName("0.13.0", "0.14.0")))).toBe(
      true
    );
  });

  test("preserves shared patch files referenced by live chains", async () => {
    const cacheDir = getCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    // Old chain: A→B (expired)
    const oldMeta: ChainMeta = {
      fromVersion: "0.12.0",
      toVersion: "0.13.0",
      expectedSha256: "old-sha",
      cachedAt: eightDaysAgo,
      patches: [{ fromVersion: "0.12.0", toVersion: "0.13.0", size: 10 }],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.12.0", "0.13.0")),
      JSON.stringify(oldMeta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.12.0", "0.13.0")),
      new Uint8Array([1])
    );

    // Fresh chain: A→B→C (alive) — shares the A→B patch file
    const freshMeta: ChainMeta = {
      fromVersion: "0.12.0",
      toVersion: "0.14.0",
      expectedSha256: "fresh-sha",
      cachedAt: oneHourAgo,
      patches: [
        { fromVersion: "0.12.0", toVersion: "0.13.0", size: 10 },
        { fromVersion: "0.13.0", toVersion: "0.14.0", size: 10 },
      ],
    };
    await writeFile(
      join(cacheDir, chainFileName("0.12.0", "0.14.0")),
      JSON.stringify(freshMeta)
    );
    await writeFile(
      join(cacheDir, patchFileName("0.13.0", "0.14.0")),
      new Uint8Array([2])
    );

    await cleanupPatchCache();

    // Old chain metadata removed
    expect(existsSync(join(cacheDir, chainFileName("0.12.0", "0.13.0")))).toBe(
      false
    );

    // Shared A→B patch file preserved (still used by fresh chain)
    expect(existsSync(join(cacheDir, patchFileName("0.12.0", "0.13.0")))).toBe(
      true
    );

    // Fresh chain fully intact
    expect(existsSync(join(cacheDir, chainFileName("0.12.0", "0.14.0")))).toBe(
      true
    );
    expect(existsSync(join(cacheDir, patchFileName("0.13.0", "0.14.0")))).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// clearPatchCache — wipe all cached patches after successful upgrade
// ---------------------------------------------------------------------------

describe("clearPatchCache", () => {
  test("removes all patch and chain files", async () => {
    const cacheDir = getCacheDir();

    // Populate cache with a multi-step chain
    await savePatchesToCache(
      {
        patches: [
          { data: new Uint8Array([1, 2, 3]), size: 3 },
          { data: new Uint8Array([4, 5, 6]), size: 3 },
        ],
        expectedSha256: "abc123",
      },
      [
        { fromVersion: "0.10.0", toVersion: "0.11.0" },
        { fromVersion: "0.11.0", toVersion: "0.12.0" },
      ]
    );

    // Verify files exist
    expect(existsSync(join(cacheDir, patchFileName("0.10.0", "0.11.0")))).toBe(
      true
    );
    expect(existsSync(join(cacheDir, patchFileName("0.11.0", "0.12.0")))).toBe(
      true
    );
    expect(existsSync(join(cacheDir, chainFileName("0.10.0", "0.12.0")))).toBe(
      true
    );

    await clearPatchCache();

    // All files gone
    expect(existsSync(join(cacheDir, patchFileName("0.10.0", "0.11.0")))).toBe(
      false
    );
    expect(existsSync(join(cacheDir, patchFileName("0.11.0", "0.12.0")))).toBe(
      false
    );
    expect(existsSync(join(cacheDir, chainFileName("0.10.0", "0.12.0")))).toBe(
      false
    );
  });

  test("is a no-op when cache directory does not exist", async () => {
    // Don't create anything — cache dir doesn't exist
    await clearPatchCache(); // Should not throw
  });

  test("is a no-op when cache directory is empty", async () => {
    // Create the cache dir but no files
    mkdirSync(getCacheDir(), { recursive: true });
    await clearPatchCache(); // Should not throw
  });
});
