/**
 * Tests for pairing WebAssembly modules with their sourcemaps and giving both
 * the module's `build_id` as a debug ID.
 *
 * The single-pair sync is exercised directly — no walker, no upload API — so
 * each rule (stamp, adopt, correct, leave alone) is checked in isolation.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";
import picomatch from "picomatch";
import { beforeEach, describe, expect, test } from "vitest";
import { buildEmptyDiscoveryError } from "../../../src/lib/sourcemap/inject.js";
import {
  addWasmDiscoveryCounts,
  discoverWasmPairs,
  syncWasmSourcemap,
} from "../../../src/lib/sourcemap/wasm.js";
import { parseSections } from "../../../src/lib/wasm/binary.js";
import {
  buildIdFromSections,
  debugIdFromBuildId,
  formatBuildId,
  uuidToBytes,
} from "../../../src/lib/wasm/build-id.js";
import {
  byteVector,
  customSection,
  fromHex,
  wasmModule,
} from "../wasm/helpers.js";

/** Deterministic build id used wherever the exact debug ID matters. */
const FIXED_UUID = "00000000-0000-4000-8000-000000000000";

/** A second id, for the map-disagrees case. */
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentry-wasm-sourcemap-"));
});

/** Write a wasm module, optionally carrying a `build_id`. */
async function writeWasm(name: string, buildId?: string): Promise<string> {
  const sections = [customSection("name", fromHex("00"))];
  if (buildId) {
    sections.push(
      customSection("build_id", byteVector(uuidToBytes(buildId) as Uint8Array)),
    );
  }
  const path = join(dir, name);
  await writeFile(path, wasmModule(sections));
  return path;
}

/** Write a Source Map v3 file, optionally carrying a debug ID. */
async function writeMap(name: string, debugId?: string): Promise<string> {
  const map: Record<string, unknown> = {
    version: 3,
    sources: ["app.c"],
    names: [],
    mappings: "AAAA",
  };
  if (debugId) {
    map.debug_id = debugId;
  }
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(map));
  return path;
}

/** Read a map back as a plain object. */
async function readMap(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8"));
}

/** Read the debug ID a module's `build_id` section stands for. */
async function readModuleDebugId(path: string): Promise<string | undefined> {
  const buildId = buildIdFromSections(parseSections(await readFile(path)));
  return buildId ? debugIdFromBuildId(formatBuildId(buildId)) : undefined;
}

describe("syncWasmSourcemap", () => {
  /** Write a module whose `build_id` section holds exactly `body`. */
  async function writeWasmWithBuildIdBody(name: string, body: string) {
    const path = join(dir, name);
    await writeFile(
      path,
      wasmModule([
        customSection("name", fromHex("00")),
        customSection("build_id", fromHex(body)),
      ]),
    );
    return path;
  }

  /** Count the `build_id` sections in a module on disk. */
  async function countBuildIdSections(path: string): Promise<number> {
    return parseSections(await readFile(path)).filter(
      (s) => s.name === "build_id",
    ).length;
  }

  test("adopts a legacy bare 16-byte build_id instead of stamping a second", async () => {
    const wasmPath = await writeWasmWithBuildIdBody(
      "legacy.wasm",
      "90f5be01270255a18255e7c3e501bc25",
    );
    const before = await readFile(wasmPath);
    const mapPath = await writeMap("legacy.wasm.map");

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.moduleStamped).toBe(false);
    expect(result.debugId).toBe("90f5be01-2702-55a1-8255-e7c3e501bc25");
    expect(await readFile(wasmPath)).toEqual(before);
    expect(await countBuildIdSections(wasmPath)).toBe(1);
  });

  test("skips a module whose build_id section is malformed", async () => {
    // Declares 32 bytes but holds 2: unreadable, yet present.
    const wasmPath = await writeWasmWithBuildIdBody("bad-id.wasm", "200102");
    const before = await readFile(wasmPath);
    const mapPath = await writeMap("bad-id.wasm.map");
    const mapBefore = await readFile(mapPath);

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.skipped).toMatch(/build_id section is malformed/);
    expect(result.debugId).toBeUndefined();
    expect(await readFile(wasmPath)).toEqual(before);
    expect(await readFile(mapPath)).toEqual(mapBefore);
  });

  test("skips a .wasm file that is not a module", async () => {
    const wasmPath = join(dir, "404.wasm");
    await writeFile(wasmPath, "<html>Not Found</html>");
    const mapPath = await writeMap("404.wasm.map");
    const mapBefore = await readFile(mapPath);

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.skipped).toMatch(/not a valid wasm module/);
    expect(await readFile(mapPath)).toEqual(mapBefore);
  });

  test("skips a map that is not JSON without stamping the module", async () => {
    const wasmPath = await writeWasm("app.wasm");
    const before = await readFile(wasmPath);
    const mapPath = join(dir, "app.wasm.map");
    await writeFile(mapPath, "not json");

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.skipped).toMatch(/not valid JSON/);
    expect(result.moduleStamped).toBe(false);
    expect(await readFile(wasmPath)).toEqual(before);
  });

  test("reads a map saved with a BOM", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = join(dir, "app.wasm.map");
    await writeFile(
      mapPath,
      `\uFEFF${JSON.stringify({ version: 3, mappings: "" })}`,
    );

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.skipped).toBeUndefined();
    expect((await readMap(mapPath)).debug_id).toBe(FIXED_UUID);
  });

  test("leaves the map alone when the build_id is too short for a debug ID", async () => {
    const wasmPath = await writeWasmWithBuildIdBody(
      "short.wasm",
      "080102030405060708",
    );
    const mapPath = await writeMap("short.wasm.map");
    const mapBefore = await readFile(mapPath);

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.debugId).toBeUndefined();
    expect(result.moduleStamped).toBe(false);
    expect(result.mapWritten).toBe(false);
    expect(await readFile(mapPath)).toEqual(mapBefore);
  });

  test("stamps the map with the id the module already carries", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const before = await readFile(wasmPath);
    const mapPath = await writeMap("app.wasm.map");

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.debugId).toBe(FIXED_UUID);
    expect(result.mapWritten).toBe(true);
    expect(result.moduleStamped).toBe(false);
    const map = await readMap(mapPath);
    expect(map.debug_id).toBe(FIXED_UUID);
    expect(map.debugId).toBe(FIXED_UUID);
    // The module is the source of truth, so it is never rewritten.
    expect(await readFile(wasmPath)).toEqual(before);
  });

  test("stamps a module that has no build_id, then the map", async () => {
    const wasmPath = await writeWasm("bare.wasm");
    const mapPath = await writeMap("bare.wasm.map");

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.moduleStamped).toBe(true);
    // The minted id is random, so the invariant to check is that both sides
    // ended up with the one now on the module.
    expect(result.debugId).toBe(await readModuleDebugId(wasmPath));
    expect((await readMap(mapPath)).debug_id).toBe(result.debugId);
  });

  test("writes nothing when the map already carries the module's id", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = await writeMap("app.wasm.map", FIXED_UUID);
    const before = await readFile(mapPath);

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.debugId).toBe(FIXED_UUID);
    expect(result.mapWritten).toBe(false);
    expect(await readFile(mapPath)).toEqual(before);
  });

  test("overwrites a map id that disagrees with the module", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = await writeMap("app.wasm.map", OTHER_UUID);

    const result = await syncWasmSourcemap({ wasmPath, mapPath });

    expect(result.mapWritten).toBe(true);
    expect((await readMap(mapPath)).debug_id).toBe(FIXED_UUID);
  });

  test("preserves the rest of the map", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = await writeMap("app.wasm.map");

    await syncWasmSourcemap({ wasmPath, mapPath });

    const map = await readMap(mapPath);
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(["app.c"]);
    expect(map.mappings).toBe("AAAA");
  });

  test("dry run leaves both files untouched", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = await writeMap("app.wasm.map");
    const wasmBefore = await readFile(wasmPath);
    const mapBefore = await readFile(mapPath);

    const result = await syncWasmSourcemap(
      { wasmPath, mapPath },
      { dryRun: true },
    );

    // The id is still reportable: it was read off the module.
    expect(result.debugId).toBe(FIXED_UUID);
    // Reported as a real run would write it, so `inject --dry-run` counts it.
    expect(result.mapWritten).toBe(true);
    expect(result.moduleStamped).toBe(false);
    expect(await readFile(wasmPath)).toEqual(wasmBefore);
    expect(await readFile(mapPath)).toEqual(mapBefore);
  });

  test("dry run over an unstamped module reports no id but both changes", async () => {
    const wasmPath = await writeWasm("bare.wasm");
    const mapPath = await writeMap("bare.wasm.map");
    const wasmBefore = await readFile(wasmPath);
    const mapBefore = await readFile(mapPath);

    const result = await syncWasmSourcemap(
      { wasmPath, mapPath },
      { dryRun: true },
    );

    expect(result.debugId).toBeUndefined();
    expect(result.moduleStamped).toBe(true);
    expect(result.mapWritten).toBe(true);
    expect(await readFile(wasmPath)).toEqual(wasmBefore);
    expect(await readFile(mapPath)).toEqual(mapBefore);
  });

  test("dry run over an already-synced pair reports nothing to change", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = await writeMap("app.wasm.map", FIXED_UUID);

    const result = await syncWasmSourcemap(
      { wasmPath, mapPath },
      { dryRun: true },
    );

    expect(result.mapWritten).toBe(false);
    expect(result.moduleStamped).toBe(false);
  });
});

describe("discoverWasmPairs", () => {
  test("pairs a module with the map beside it", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    const mapPath = await writeMap("app.wasm.map");

    expect(await discoverWasmPairs(dir)).toEqual([{ wasmPath, mapPath }]);
  });

  test("skips DWARF companions written by debug-files wasm-upload", async () => {
    await writeWasm("app.debug.wasm", FIXED_UUID);
    await writeMap("app.debug.wasm.map");

    expect(await discoverWasmPairs(dir)).toEqual([]);
  });

  test("skips a module with no map beside it", async () => {
    await writeWasm("lonely.wasm", FIXED_UUID);

    expect(await discoverWasmPairs(dir)).toEqual([]);
  });

  test("honours a gitignore-style ignore matcher", async () => {
    await mkdir(join(dir, "vendor"));
    await writeFile(
      join(dir, "vendor", "lib.wasm"),
      wasmModule([
        customSection(
          "build_id",
          byteVector(uuidToBytes(FIXED_UUID) as Uint8Array),
        ),
      ]),
    );
    await writeFile(join(dir, "vendor", "lib.wasm.map"), '{"version":3}');
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    await writeMap("app.wasm.map");

    const matcher = ignore();
    matcher.add(["vendor/**"]);

    const pairs = await discoverWasmPairs(dir, { ignoreMatcher: matcher });

    expect(pairs.map((p) => p.wasmPath)).toEqual([wasmPath]);
  });

  test("keeps only pairs a glob target matches", async () => {
    await mkdir(join(dir, "pkg"));
    await writeFile(
      join(dir, "pkg", "app.wasm"),
      wasmModule([customSection("name", fromHex("00"))]),
    );
    await writeFile(join(dir, "pkg", "app.wasm.map"), '{"version":3}');
    await writeWasm("other.wasm", FIXED_UUID);
    await writeMap("other.wasm.map");

    const pairs = await discoverWasmPairs(dir, {
      include: picomatch("pkg/**"),
    });

    expect(pairs.map((p) => p.wasmPath)).toEqual([
      join(dir, "pkg", "app.wasm"),
    ]);
  });

  test("keeps a pair when only its map matches the glob", async () => {
    const wasmPath = await writeWasm("app.wasm", FIXED_UUID);
    await writeMap("app.wasm.map");

    const pairs = await discoverWasmPairs(dir, {
      include: picomatch("**/*.map"),
    });

    expect(pairs.map((p) => p.wasmPath)).toEqual([wasmPath]);
  });
});

describe("addWasmDiscoveryCounts", () => {
  test("counts modules and moves .wasm.map out of the JS map tally", async () => {
    await writeWasm("app.wasm", FIXED_UUID);
    await writeMap("app.wasm.map");

    const diag = await addWasmDiscoveryCounts(dir, {
      jsFiles: 0,
      mapFiles: 1,
    });

    expect(diag).toEqual({
      jsFiles: 0,
      mapFiles: 0,
      wasmFiles: 1,
      wasmMaps: 1,
    });
  });

  test("reports modules built without -gsource-map", async () => {
    await writeWasm("app.wasm", FIXED_UUID);

    const diag = await addWasmDiscoveryCounts(dir, {
      jsFiles: 0,
      mapFiles: 0,
    });

    expect(diag.wasmFiles).toBe(1);
    expect(diag.wasmMaps).toBe(0);
  });

  test("attributes a map with no module to wasm, not JS", async () => {
    await writeMap("app.wasm.map");

    const diag = await addWasmDiscoveryCounts(dir, {
      jsFiles: 0,
      mapFiles: 1,
    });

    expect(diag).toEqual({
      jsFiles: 0,
      mapFiles: 0,
      wasmFiles: 0,
      wasmMaps: 1,
    });
    expect(buildEmptyDiscoveryError(dir, diag).message).toContain(
      "1 .wasm.map file(s)",
    );
  });

  test("counts only what a glob target matches", async () => {
    await mkdir(join(dir, "pkg"));
    await writeFile(
      join(dir, "pkg", "app.wasm"),
      wasmModule([customSection("name", fromHex("00"))]),
    );
    await writeFile(join(dir, "pkg", "app.wasm.map"), '{"version":3}');
    await writeWasm("other.wasm", FIXED_UUID);
    await writeMap("other.wasm.map");

    const diag = await addWasmDiscoveryCounts(
      dir,
      { jsFiles: 0, mapFiles: 1 },
      { include: picomatch("pkg/**") },
    );

    expect(diag).toEqual({
      jsFiles: 0,
      mapFiles: 0,
      wasmFiles: 1,
      wasmMaps: 1,
    });
  });

  test("leaves JS maps in the JS tally", async () => {
    await writeMap("app.js.map");

    const diag = await addWasmDiscoveryCounts(dir, {
      jsFiles: 0,
      mapFiles: 1,
    });

    expect(diag.mapFiles).toBe(1);
    expect(diag.wasmMaps).toBe(0);
  });
});
