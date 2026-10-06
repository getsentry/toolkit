/**
 * Tests for `sentry wasm-split`.
 *
 * Drives the command through its wrapper `loader()` with a fake stdout, so the
 * stdout contract — a bare lowercase hex build id and nothing else — is
 * asserted on the real output path rather than on the return value.
 */

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { wasmSplitCommand } from "../../src/commands/wasm-split.js";
import { ValidationError } from "../../src/lib/errors.js";
import { parseSections } from "../../src/lib/wasm/binary.js";
import {
  buildIdFromSections,
  formatBuildId,
} from "../../src/lib/wasm/build-id.js";
import {
  byteVector,
  CODE_SECTION_ID,
  customSection,
  fromHex,
  readByteVectorString,
  section,
  toHex,
  wasmModule,
} from "../lib/wasm/helpers.js";

/** Flags the command sees when the user passes none. */
const NO_FLAGS = {
  strip: false,
  "strip-names": false,
  quiet: false,
} as const;

function createContext() {
  const writes: string[] = [];
  return {
    context: {
      stdout: {
        write: (data: string | Uint8Array) => {
          writes.push(
            typeof data === "string" ? data : new TextDecoder().decode(data)
          );
          return true;
        },
      },
      stderr: { write: () => true },
      cwd: "/tmp",
      env: {} as NodeJS.ProcessEnv,
      process: { ...process, exitCode: undefined } as typeof process,
    },
    output: () => writes.join(""),
  };
}

/** Run the command, returning its stdout. */
async function run(
  flags: Record<string, unknown>,
  input: string
): Promise<string> {
  const harness = createContext();
  const func = await wasmSplitCommand.loader();
  await func.call(harness.context, { ...NO_FLAGS, ...flags }, input);
  return harness.output();
}

/** A module with code, names, and DWARF, but no build id. */
function debugModule(): Uint8Array {
  return wasmModule([
    section(CODE_SECTION_ID, fromHex("0102030405")),
    customSection("name", fromHex("deadbeef")),
    customSection(".debug_info", fromHex("cafebabe")),
  ]);
}

async function writeModule(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wasm-split-"));
  const path = join(dir, "app.wasm");
  await writeFile(path, bytes);
  return path;
}

/** Names of the custom sections in a file on disk, in order. */
async function customNames(path: string): Promise<(string | undefined)[]> {
  return parseSections(await readFile(path))
    .filter((entry) => entry.id === 0)
    .map((entry) => entry.name);
}

describe("stdout contract", () => {
  test("prints only the lowercase hex build id", async () => {
    const buildId = "a1b2c3d4-e5f6-4788-99aa-bbccddeeff00";
    const output = await run(
      { "build-id": buildId },
      await writeModule(debugModule())
    );

    expect(output).toBe("a1b2c3d4e5f6478899aabbccddeeff00\n");
  });

  test("--quiet suppresses stdout entirely", async () => {
    const path = await writeModule(debugModule());
    expect(await run({ quiet: true }, path)).toBe("");
    // The work still happened.
    expect(await customNames(path)).toContain("build_id");
  });

  test("--quiet cannot be used with --json", async () => {
    const path = await writeModule(debugModule());
    await expect(run({ quiet: true, json: true }, path)).rejects.toThrow(
      ValidationError
    );
  });

  test("--json reports the paths alongside the id", async () => {
    const path = await writeModule(debugModule());
    const output = await run(
      { json: true, "build-id": "a1b2c3d4-e5f6-4788-99aa-bbccddeeff00" },
      path
    );

    expect(JSON.parse(output)).toMatchObject({
      buildId: "a1b2c3d4e5f6478899aabbccddeeff00",
      input: path,
      output: path,
    });
  });
});

describe("build id", () => {
  test("mints one when the module has none", async () => {
    const path = await writeModule(debugModule());
    const output = await run({}, path);

    expect(output.trim()).toMatch(/^[0-9a-f]{32}$/);
    expect(
      formatBuildId(
        buildIdFromSections(parseSections(await readFile(path))) as Uint8Array
      )
    ).toBe(output.trim());
  });

  test("rejects a --build-id that is not a UUID", async () => {
    const path = await writeModule(debugModule());
    await expect(run({ "build-id": "not-a-uuid" }, path)).rejects.toThrow(
      /Invalid --build-id/
    );
  });

  test("rejects a missing input file", async () => {
    await expect(
      run({}, join(tmpdir(), "definitely-absent.wasm"))
    ).rejects.toThrow(/does not exist/);
  });
});

describe("writing", () => {
  test("modifies the input in place when --out is absent", async () => {
    const path = await writeModule(debugModule());
    await run({ strip: true }, path);

    expect(await customNames(path)).toEqual(["name", "build_id"]);
  });

  test("writes elsewhere and leaves the input alone when --out is given", async () => {
    const path = await writeModule(debugModule());
    const original = await readFile(path);
    const out = join(path, "..", "out.wasm");

    await run({ strip: true, out }, path);

    expect(toHex(await readFile(path))).toBe(toHex(original));
    expect(await customNames(out)).toEqual(["name", "build_id"]);
  });

  test("does not touch the file when nothing changed", async () => {
    const bytes = wasmModule([
      section(CODE_SECTION_ID, fromHex("01")),
      customSection("build_id", byteVector(fromHex("00".repeat(16)))),
    ]);
    const path = await writeModule(bytes);
    const before = await stat(path);

    await run({}, path);

    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(toHex(await readFile(path))).toBe(toHex(bytes));
  });
});

describe("splitting", () => {
  test("--debug-out writes a companion that keeps the code section", async () => {
    const path = await writeModule(debugModule());
    const debugOut = join(path, "..", "app.debug.wasm");

    await run({ "debug-out": debugOut, strip: true }, path);

    const companion = parseSections(await readFile(debugOut));
    expect(companion.some((entry) => entry.id === CODE_SECTION_ID)).toBe(true);
    expect(companion.map((entry) => entry.name)).toContain(".debug_info");
    // The deployable module lost its DWARF, the companion kept it.
    expect(await customNames(path)).toEqual([
      "name",
      "build_id",
      "external_debug_info",
    ]);
  });
});

describe("external_debug_info", () => {
  test("falls back to the basename of --debug-out", async () => {
    const path = await writeModule(debugModule());
    const debugOut = join(path, "..", "nested", "..", "app.debug.wasm");

    await run({ "debug-out": debugOut }, path);

    expect(await readExternalDebugInfo(path)).toBe("app.debug.wasm");
  });

  test("--external-dwarf-url wins over the basename", async () => {
    const path = await writeModule(debugModule());

    await run(
      {
        "debug-out": join(path, "..", "app.debug.wasm"),
        "external-dwarf-url": "https://cdn.example/debug/app.debug.wasm",
      },
      path
    );

    expect(await readExternalDebugInfo(path)).toBe(
      "https://cdn.example/debug/app.debug.wasm"
    );
  });
});

/** Read the `external_debug_info` value out of a file on disk. */
async function readExternalDebugInfo(path: string): Promise<string | null> {
  const found = parseSections(await readFile(path)).find(
    (entry) => entry.name === "external_debug_info"
  );
  return found?.contents ? readByteVectorString(found.contents) : null;
}
