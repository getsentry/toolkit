/**
 * Behavioural tests for WASM debug-file preparation.
 *
 * These cover the prepare decisions — what gets split, stamped, skipped, or
 * reconciled — and the on-disk effect of each. The split primitive itself is
 * covered by split.test.ts, and the envelope parser by binary.test.ts.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSections } from "../../../src/lib/wasm/binary.js";
import { formatBuildId, uuidToBytes } from "../../../src/lib/wasm/build-id.js";
import {
  companionPath,
  findReferencedCompanions,
  hasDwarfQuality,
  inspectWasm,
  isDebugCompanionPath,
  prepareWasmFile,
  uploadPath,
} from "../../../src/lib/wasm/prepare.js";
import { splitWasm } from "../../../src/lib/wasm/split.js";
import {
  byteVector,
  CODE_SECTION_ID,
  customSection,
  fromHex,
  section,
  toHex,
  wasmModule,
} from "./helpers.js";

/** Deterministic build id used where the exact value matters. */
const FIXED_UUID = "00000000-0000-4000-8000-000000000000";

/** A stand-in code section. Its contents are opaque to the parser. */
function code(): Uint8Array {
  return section(CODE_SECTION_ID, fromHex("00"));
}

/** A DWARF debug section. */
function dwarf(): Uint8Array {
  return customSection(".debug_info", fromHex("0102"));
}

/** A `build_id` section holding the given bytes. */
function buildIdSection(buildId: Uint8Array): Uint8Array {
  return customSection("build_id", byteVector(buildId));
}

/** An `external_debug_info` section pointing at `url`. */
function externalDebugInfoSection(url: string): Uint8Array {
  return customSection(
    "external_debug_info",
    byteVector(new TextEncoder().encode(url)),
  );
}

/** Module with inline DWARF: the splittable case. */
function dwarfModule(): Uint8Array {
  return wasmModule([code(), dwarf()]);
}

/** Module with function names only: no line-level debug info. */
function nameOnlyModule(): Uint8Array {
  return wasmModule([code(), customSection("name", fromHex("00"))]);
}

/** Module with no debug information at all. */
function emptyModule(): Uint8Array {
  return wasmModule([code()]);
}

/** Module already stripped: a build id but no debug sections. */
function strippedModule(): Uint8Array {
  return wasmModule([code(), buildIdSection(new Uint8Array(16).fill(0x07))]);
}

/** Whether a module carries a custom section with the given name. */
function hasSection(bytes: Uint8Array, name: string): boolean {
  return parseSections(bytes).some((entry) => entry.name === name);
}

/** Split a module the way `prepareWasmFile` does, for fixture setup. */
function split(bytes: Uint8Array, companionName: string) {
  return splitWasm(bytes, {
    companion: true,
    strip: true,
    buildId: uuidToBytes(FIXED_UUID) as Uint8Array,
    externalDebugInfo: companionName,
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wasm-prepare-"));
});

afterEach(() => {
  dir = "";
});

/** Write a module into the temp dir and return its path. */
async function writeModule(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/**
 * Companions written into a directory.
 *
 * Companion names carry a build id, which is random unless the test pinned one,
 * so tests assert on what landed in the directory rather than on a name they
 * would have to reconstruct.
 */
async function companionsIn(target = dir): Promise<string[]> {
  return (await readdir(target)).filter(isDebugCompanionPath);
}

describe("hasDwarfQuality", () => {
  test("counts an external companion pointer as having DWARF", () => {
    // Mirrors DebugQuality::has_dwarf in the Rust CLI: this describes how the
    // module was built, not whether its debug info can be reached. The
    // --require-dwarf gate applies the reachability check on top.
    expect(hasDwarfQuality("dwarf")).toBe(true);
    expect(hasDwarfQuality("external-debug-info")).toBe(true);
    expect(hasDwarfQuality("symtab")).toBe(false);
    expect(hasDwarfQuality("none")).toBe(false);
  });
});

/**
 * Golden vectors captured from Symbolicator's `wasm-split` (via `wasmbin`),
 * splitting a module holding a single `.debug_info` section with the build id
 * pinned to {@link FIXED_UUID}.
 *
 * Sentry treats companions from either tool identically, so these bytes are a
 * compatibility contract, not an implementation detail. Decoded, the outputs
 * confirm the two custom-section encodings this module depends on: `build_id`
 * is a length-prefixed byte vector, `external_debug_info` a length-prefixed
 * UTF-8 string.
 */
const WASM_SPLIT_INPUT = "0061736d0100000000100b2e64656275675f696e666f00010203";
const WASM_SPLIT_STRIPPED =
  "0061736d01000000001a086275696c645f6964100000000000004000800000000000000000231365787465726e616c5f64656275675f696e666f0e6170702e64656275672e7761736d";
const WASM_SPLIT_COMPANION =
  "0061736d0100000000100b2e64656275675f696e666f00010203001a086275696c645f69641000000000000040008000000000000000";

describe("wasm-split compatibility", () => {
  test("produces byte-identical output to wasm-split", () => {
    const result = split(fromHex(WASM_SPLIT_INPUT), "app.debug.wasm");

    expect(toHex(result.module)).toBe(WASM_SPLIT_STRIPPED);
    expect(toHex(result.companion as Uint8Array)).toBe(WASM_SPLIT_COMPANION);
  });

  test("reads back a module wasm-split wrote", () => {
    const inspection = inspectWasm(fromHex(WASM_SPLIT_STRIPPED));

    expect(inspection.quality).toBe("external-debug-info");
    expect(inspection.externalDebugInfo).toBe("app.debug.wasm");
    expect(toHex(inspection.buildId as Uint8Array)).toBe(
      "00000000000040008000000000000000",
    );
  });
});

describe("prepareWasmFile", () => {
  test("splits a module with DWARF", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path);

    expect(result.action).toBe("split");
    expect(result.quality).toBe("dwarf");
    expect(result.companion).toBe(
      companionPath(path, result.buildId as string),
    );
    expect(existsSync(result.companion as string)).toBe(true);
    expect(uploadPath(result)).toBe(result.companion);
    // The deployable keeps its original path so the build artifact does not move.
    expect(hasSection(await readFile(path), ".debug_info")).toBe(false);
  });

  test("names the companion after the build id and points the module at it", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path);

    expect(result.companion).toBe(
      join(dir, `app.${result.buildId}.debug.wasm`),
    );
    // The pointer is resolved relative to the module, so it must name the
    // companion as written, not as a guess at the old convention.
    expect(inspectWasm(await readFile(path)).externalDebugInfo).toBe(
      `app.${result.buildId}.debug.wasm`,
    );
  });

  test("keeps companions apart for same-named modules sharing an out-dir", async () => {
    // The collision --out-dir used to cause: both modules named their companion
    // app.debug.wasm, so the second write destroyed the first module's DWARF
    // after it had already been stripped in place.
    const outDir = await mkdtemp(join(tmpdir(), "wasm-out-"));
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    const first = await writeModule(join("a", "app.wasm"), dwarfModule());
    const second = await writeModule(join("b", "app.wasm"), dwarfModule());

    const a = await prepareWasmFile(first, { outDir });
    const b = await prepareWasmFile(second, { outDir });

    expect(a.companion).not.toBe(b.companion);
    expect(await companionsIn(outDir)).toHaveLength(2);
    // Both companions still hold the DWARF their module gave up.
    expect(
      hasSection(await readFile(a.companion as string), ".debug_info"),
    ).toBe(true);
    expect(
      hasSection(await readFile(b.companion as string), ".debug_info"),
    ).toBe(true);
  });

  test("stamps a symtab-only module but uploads nothing", async () => {
    const path = await writeModule("unity.wasm", nameOnlyModule());
    const result = await prepareWasmFile(path);

    expect(result.action).toBe("skipped");
    expect(result.quality).toBe("symtab");
    expect(result.warning).toContain("no line-level");
    expect(await companionsIn()).toEqual([]);
    // Stamped so a later DWARF build can be matched, but the name section stays
    // readable in the deployable, so there is nothing worth uploading.
    expect(result.buildId).toBeDefined();
    expect(uploadPath(result)).toBeNull();
    expect(inspectWasm(await readFile(path)).buildId).not.toBeNull();
  });

  test("stamps a module with no debug info", async () => {
    const path = await writeModule("app.wasm", emptyModule());
    const result = await prepareWasmFile(path);

    expect(result.action).toBe("skipped");
    expect(result.quality).toBe("none");
    expect(result.warning).toContain("no debug information");
    expect(result.buildId).toBeDefined();
  });

  test("does not re-split a module that only has a build id", async () => {
    const path = await writeModule("app.wasm", strippedModule());
    const result = await prepareWasmFile(path);

    expect(result.action).toBe("skipped");
    expect(result.quality).toBe("none");
    expect(result.warning).toContain("no debug information");
    expect(await companionsIn()).toEqual([]);
  });

  test("recommends checking build flags when debug info is missing", async () => {
    const missing = await prepareWasmFile(
      await writeModule("empty.wasm", emptyModule()),
    );
    const names = await prepareWasmFile(
      await writeModule("names.wasm", nameOnlyModule()),
    );

    expect(missing.recommendation).toBe("verify build flags emit DWARF");
    expect(names.recommendation).toBe("verify build flags emit DWARF");
  });

  test("detects an already-prepared pair on a second run", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const first = await prepareWasmFile(path);
    const second = await prepareWasmFile(path);

    expect(first.action).toBe("split");
    expect(second.action).toBe("already-prepared");
    expect(second.buildId).toBe(first.buildId);
  });

  test("dry run writes nothing and stamps nothing", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const before = await readFile(path);
    const result = await prepareWasmFile(path, { dryRun: true });

    expect(result.action).toBe("would-split");
    expect(await companionsIn()).toEqual([]);
    expect(await readFile(path)).toEqual(before);
  });

  test("dry run names the companion when the id is already settled", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path, {
      dryRun: true,
      buildId: uuidToBytes(FIXED_UUID) as Uint8Array,
    });

    // --build-id makes the real run's name knowable, so report it exactly.
    expect(result.companion).toBe(
      join(dir, "app.00000000000040008000000000000000.debug.wasm"),
    );
  });

  test("dry run reports a placeholder name for an unsettled id", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path, { dryRun: true });

    // The id will be random, so the shape of the name is the honest answer.
    expect(result.buildId).toBeUndefined();
    expect(result.companion).toBe(join(dir, "app.<build-id>.debug.wasm"));
  });

  test("dry run does not stamp a skipped module", async () => {
    const path = await writeModule("unity.wasm", nameOnlyModule());
    const result = await prepareWasmFile(path, { dryRun: true });

    expect(result.action).toBe("skipped");
    expect(result.buildId).toBeUndefined();
    expect(inspectWasm(await readFile(path)).buildId).toBeNull();
  });

  test("uses an explicit build id", async () => {
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path, {
      buildId: uuidToBytes(FIXED_UUID) as Uint8Array,
    });

    expect(result.buildId).toBe("00000000000040008000000000000000");
  });

  test("out-dir redirects the companion but strips in place", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "wasm-out-"));
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path, { outDir });

    expect(result.companion).toBe(
      join(outDir, `app.${result.buildId}.debug.wasm`),
    );
    expect(existsSync(result.companion as string)).toBe(true);
    expect(await companionsIn()).toEqual([]);
    // The deployed path is the one that ends up stripped and stamped.
    expect(hasSection(await readFile(path), ".debug_info")).toBe(false);
    expect(inspectWasm(await readFile(path)).buildId).not.toBeNull();
  });

  test("out-dir leaves a pointer the module can resolve", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "wasm-out-"));
    const path = await writeModule("app.wasm", dwarfModule());
    const result = await prepareWasmFile(path, { outDir });

    // A bare basename here would be a dangling pointer: the companion is not
    // beside the module. A second run has to be able to follow it.
    const pointer = inspectWasm(await readFile(path)).externalDebugInfo;
    expect(existsSync(join(dir, pointer as string))).toBe(true);
    expect(await prepareWasmFile(path, { outDir })).toMatchObject({
      action: "already-prepared",
      companion: result.companion,
    });
  });

  test("skips a companion given as input", async () => {
    const path = await writeModule("app.debug.wasm", dwarfModule());
    const result = await prepareWasmFile(path);

    expect(result.action).toBe("skipped");
    expect(result.warning).toContain("already a debug companion");
  });

  test("recognizes a companion named by external_debug_info", async () => {
    // A companion named by another tool is only findable by following the
    // module's own pointer.
    const result = split(dwarfModule(), "custom-name.wasm");
    const path = await writeModule("app.wasm", result.module);
    await writeModule("custom-name.wasm", result.companion as Uint8Array);

    const prepared = await prepareWasmFile(path);

    expect(prepared.action).toBe("already-prepared");
    expect(prepared.quality).toBe("external-debug-info");
    expect(prepared.companion).toBe(join(dir, "custom-name.wasm"));
  });

  test("ignores a remote external_debug_info URL", async () => {
    const result = split(dwarfModule(), "https://example.com/app.debug.wasm");
    const path = await writeModule("app.wasm", result.module);

    const prepared = await prepareWasmFile(path);

    // Nothing local to verify, so it is reported rather than claimed prepared.
    expect(prepared.action).toBe("skipped");
    expect(prepared.quality).toBe("external-debug-info");
  });

  test("skips a file that is not a WASM module", async () => {
    const path = join(dir, "not-wasm.wasm");
    await writeFile(path, "definitely not wasm");
    const result = await prepareWasmFile(path);

    expect(result.action).toBe("skipped");
    expect(result.warning).toContain("not a valid WASM module");
  });
});

describe("prepareWasmFile: pairs split by another tool", () => {
  /** Deployable left by a tool that stripped DWARF without stamping a build id. */
  function unstampedModule(companionName: string): Uint8Array {
    return wasmModule([code(), externalDebugInfoSection(companionName)]);
  }

  /** Companion carrying DWARF, optionally already stamped. */
  function companionModule(buildId?: Uint8Array): Uint8Array {
    const sections = [code(), dwarf()];
    if (buildId) {
      sections.push(buildIdSection(buildId));
    }
    return wasmModule(sections);
  }

  /** Write an unstamped module and its companion; return both paths. */
  async function writePair(
    companionBuildId?: Uint8Array,
  ): Promise<{ module: string; companion: string }> {
    return {
      module: await writeModule("app.wasm", unstampedModule("app.dbg.wasm")),
      companion: await writeModule(
        "app.dbg.wasm",
        companionModule(companionBuildId),
      ),
    };
  }

  test("adopts the build id the companion already carries", async () => {
    const expected = uuidToBytes(FIXED_UUID) as Uint8Array;
    const { module, companion } = await writePair(expected);
    const before = await readFile(companion);

    const result = await prepareWasmFile(module);

    expect(result.action).toBe("already-prepared");
    expect(result.buildId).toBe(formatBuildId(expected));
    expect(result.companion).toBe(companion);
    expect(result.warning).toBe("reconciled build_id with companion");
    // The module gains the companion's id; the companion is left untouched.
    const stamped = inspectWasm(await readFile(module)).buildId as Uint8Array;
    expect(Uint8Array.from(stamped)).toEqual(expected);
    expect(await readFile(companion)).toEqual(before);
  });

  test("stamps one shared id when neither file has one", async () => {
    const { module, companion } = await writePair();

    const result = await prepareWasmFile(module);

    expect(result.action).toBe("already-prepared");
    expect(result.warning).toContain("stamped both files");

    const moduleId = inspectWasm(await readFile(module)).buildId;
    const companionId = inspectWasm(await readFile(companion)).buildId;
    expect(moduleId).not.toBeNull();
    expect(companionId).toEqual(moduleId);
    expect(result.buildId).toBe(formatBuildId(moduleId as Uint8Array));
  });

  test("uploads the repaired companion", async () => {
    const { module, companion } = await writePair();

    expect(uploadPath(await prepareWasmFile(module))).toBe(companion);
  });

  test("writes nothing on a dry run", async () => {
    const { module, companion } = await writePair();
    const moduleBefore = await readFile(module);
    const companionBefore = await readFile(companion);

    const result = await prepareWasmFile(module, { dryRun: true });

    expect(result.warning).toBe("would reconcile build_id with companion");
    expect(await readFile(module)).toEqual(moduleBefore);
    expect(await readFile(companion)).toEqual(companionBefore);
  });

  test("splits rather than reconciles when DWARF is still inline", async () => {
    // A pointer left by a tool that never stripped the module: the DWARF is
    // right here, so producing a real companion beats adopting a foreign id.
    const module = await writeModule(
      "app.wasm",
      wasmModule([code(), dwarf(), externalDebugInfoSection("app.dbg.wasm")]),
    );
    await writeModule("app.dbg.wasm", companionModule());

    const result = await prepareWasmFile(module);

    expect(result.action).toBe("split");
    expect(hasSection(await readFile(module), ".debug_info")).toBe(false);
  });

  test("skips when the companion is missing", async () => {
    const module = await writeModule("app.wasm", unstampedModule("gone.wasm"));

    const result = await prepareWasmFile(module);

    expect(result.action).toBe("skipped");
    expect(result.quality).toBe("external-debug-info");
  });

  test("skips when the companion carries no DWARF", async () => {
    const module = await writeModule("app.wasm", unstampedModule("bare.wasm"));
    await writeModule("bare.wasm", emptyModule());

    const result = await prepareWasmFile(module);

    // Pairing with it would claim an id for a file holding no debug info.
    expect(result.action).toBe("skipped");
    expect(result.quality).toBe("external-debug-info");
  });
});

describe("findReferencedCompanions", () => {
  const buildId = new Uint8Array(16).fill(0x42);

  test("protects a custom-named companion its deployable points at", async () => {
    const companion = await writeModule(
      "app.symbols.wasm",
      wasmModule([code(), dwarf(), buildIdSection(buildId)]),
    );
    const module = await writeModule(
      "app.wasm",
      wasmModule([
        code(),
        buildIdSection(buildId),
        externalDebugInfoSection("app.symbols.wasm"),
      ]),
    );

    const companions = await findReferencedCompanions([module, companion]);
    const result = await prepareWasmFile(module);

    expect([...companions]).toEqual([companion]);
    expect(result.action).toBe("already-prepared");
    expect(result.companion).toBe(companion);
    expect(hasSection(await readFile(companion), ".debug_info")).toBe(true);
  });

  test("reads a pointer placed after a large payload", async () => {
    const module = await writeModule(
      "app.wasm",
      wasmModule([
        code(),
        customSection(".debug_info", new Uint8Array(1024 * 1024)),
        externalDebugInfoSection("app.symbols.wasm"),
      ]),
    );

    const companions = await findReferencedCompanions([module]);

    expect([...companions]).toEqual([join(dir, "app.symbols.wasm")]);
    expect(inspectWasm(await readFile(module)).externalDebugInfo).toBe(
      "app.symbols.wasm",
    );
  });

  test("ignores remote, self-referencing, and invalid modules", async () => {
    const paths = [
      await writeModule(
        "remote.wasm",
        wasmModule([code(), externalDebugInfoSection("https://cdn/app.wasm")]),
      ),
      await writeModule(
        "self.wasm",
        wasmModule([code(), externalDebugInfoSection("self.wasm")]),
      ),
      await writeModule("broken.wasm", fromHex("0061736d01000000ff")),
      await writeModule("text.wasm", new TextEncoder().encode("not wasm")),
    ];

    expect((await findReferencedCompanions(paths)).size).toBe(0);
  });
});
