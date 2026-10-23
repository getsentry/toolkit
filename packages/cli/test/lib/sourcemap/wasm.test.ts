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
    expect(result.mapWritten).toBe(false);
    expect(await readFile(wasmPath)).toEqual(wasmBefore);
    expect(await readFile(mapPath)).toEqual(mapBefore);
  });

  test("dry run over an unstamped module reports no id", async () => {
    const wasmPath = await writeWasm("bare.wasm");
    const mapPath = await writeMap("bare.wasm.map");
    const wasmBefore = await readFile(wasmPath);

    const result = await syncWasmSourcemap(
      { wasmPath, mapPath },
      { dryRun: true },
    );

    expect(result.debugId).toBeUndefined();
    expect(result.moduleStamped).toBe(false);
    expect(await readFile(wasmPath)).toEqual(wasmBefore);
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

    const pairs = await discoverWasmPairs(dir, matcher);

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
