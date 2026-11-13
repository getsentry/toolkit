/**
 * Unit tests for the DXIL shader manifest: row parsing and the per-directory
 * lookup that attaches a code id and shader group to a `.dxil` file.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadShaderManifest,
  parseShaderManifest,
  SHADER_MANIFEST_FILE_NAME,
  ShaderManifestCache,
} from "../../../src/lib/dif/shader-manifest.js";

const MANIFEST = [
  "709220027517385083\t000057e2ed5c597bf3ca2651c6e13a1d.pdb\tD:\\x\\000057e2ed5c597bf3ca2651c6e13a1d.dxil\r",
  "2\tb.pdb\tD:/y/b.dxil\tGlobalShaders",
  "3\tc.pdb\tc.dxil\t  Padded Group \r",
  "4\td.pdb\td.dxil\t   ",
  "123\t",
  "notanumber\tfoo.pdb\tfoo.dxil",
  "99999999999999999999999\tbig.pdb\tbig.dxil",
  "",
].join("\n");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-shader-manifest-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("parseShaderManifest", () => {
  test("keys rows by file name with the hash as 16 hex digits", () => {
    const manifest = parseShaderManifest(MANIFEST);

    expect(manifest.get("000057e2ed5c597bf3ca2651c6e13a1d.dxil")).toEqual({
      codeId: "09d7a7db7fc4397b",
    });
    expect(manifest.get("b.dxil")).toEqual({
      codeId: "0000000000000002",
      shaderGroup: "GlobalShaders",
    });
  });

  test("trims the group and drops a blank one", () => {
    const manifest = parseShaderManifest(MANIFEST);

    expect(manifest.get("c.dxil")?.shaderGroup).toBe("Padded Group");
    expect(manifest.get("d.dxil")).toEqual({ codeId: "0000000000000004" });
  });

  test("skips rows without a path, a numeric hash, or a 64-bit hash", () => {
    const manifest = parseShaderManifest(MANIFEST);

    expect(manifest.size).toBe(4);
    expect(manifest.has("foo.dxil")).toBe(false);
    expect(manifest.has("big.dxil")).toBe(false);
  });
});

describe("loadShaderManifest", () => {
  test("returns an empty manifest when the file is missing", async () => {
    expect((await loadShaderManifest(tempDir)).size).toBe(0);
  });

  test("reads the manifest next to the shaders", async () => {
    await writeFile(join(tempDir, SHADER_MANIFEST_FILE_NAME), MANIFEST);

    expect((await loadShaderManifest(tempDir)).get("b.dxil")?.codeId).toBe(
      "0000000000000002",
    );
  });
});

describe("ShaderManifestCache", () => {
  test("looks a file up in its own directory's manifest", async () => {
    await writeFile(join(tempDir, SHADER_MANIFEST_FILE_NAME), MANIFEST);
    const cache = new ShaderManifestCache();

    expect(await cache.lookup(join(tempDir, "b.dxil"))).toEqual({
      codeId: "0000000000000002",
      shaderGroup: "GlobalShaders",
    });
    expect(await cache.lookup(join(tempDir, "unknown.dxil"))).toBeUndefined();
    expect(await cache.lookup(join(tempDir, "sub", "b.dxil"))).toBeUndefined();
  });
});
