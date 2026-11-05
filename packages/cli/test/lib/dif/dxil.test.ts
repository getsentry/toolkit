/**
 * Unit tests for DXIL shader binaries in the DIF scanner: detection by the
 * container header, the debug id taken from the file name, the manifest
 * lookup, and how the `--type`/`--id` filters apply.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildDifFilters,
  debugIdMatches,
  normalizeDebugId,
  prepareDifs,
  scanPaths,
} from "../../../src/lib/dif/scan.js";
import { SHADER_MANIFEST_FILE_NAME } from "../../../src/lib/dif/shader-manifest.js";

/** A compiled shader exported by an Unreal Engine 5.8 cook. */
const DXIL_NAME = "a223507a29b50f7132d44901c2228311.dxil";
const DXIL_DEBUG_ID = "a223507a-29b5-0f71-32d4-4901c2228311";
const DXIL_CODE_ID = "d9a5d2fa49f0cf6c";
const DXIL_GROUP = "Global/FSentryTestCS/0";

const FIXTURE_DIR = new URL("../../fixtures/dif/shader/", import.meta.url);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-dxil-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Copy the DXIL fixture into `tempDir` under `name`, with or without the manifest. */
async function writeShaderFixture(
  name: string,
  options: { manifest: boolean },
): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, readFileSync(new URL(DXIL_NAME, FIXTURE_DIR)));
  if (options.manifest) {
    await writeFile(
      join(tempDir, SHADER_MANIFEST_FILE_NAME),
      readFileSync(new URL(SHADER_MANIFEST_FILE_NAME, FIXTURE_DIR)),
    );
  }
  return path;
}

describe("normalizeDebugId with a bare 32-hex id", () => {
  test("hyphenates it so both spellings compare equal", () => {
    const stem = DXIL_NAME.replace(/\.dxil$/, "");
    expect(normalizeDebugId(stem.toUpperCase())).toBe(DXIL_DEBUG_ID);
    expect(normalizeDebugId(DXIL_DEBUG_ID)).toBe(DXIL_DEBUG_ID);
    expect(debugIdMatches(stem, DXIL_DEBUG_ID)).toBe(true);
    // Shorter or longer hex strings (a Breakpad id carries an age digit) are left alone.
    expect(normalizeDebugId("0F13A5DA412AFBF7C8662048F3294F3D0")).toBe(
      "0f13a5da412afbf7c8662048f3294f3d0",
    );
  });
});

describe("prepareDifs with DXIL shader binaries", () => {
  test("recognises a shader by its header and names it from the file stem", async () => {
    const path = await writeShaderFixture(DXIL_NAME, { manifest: true });
    const { prepared } = await prepareDifs(
      await scanPaths([path]),
      buildDifFilters({}),
    );

    expect(prepared).toHaveLength(1);
    const dif = prepared[0];
    expect(dif?.debugId).toBe(DXIL_DEBUG_ID);
    expect(dif?.codeId).toBe(DXIL_CODE_ID);
    expect(dif?.shaderGroup).toBe(DXIL_GROUP);
    expect(dif?.objects[0]?.fileFormat).toBe("dxil");
    expect(dif?.content.length).toBeGreaterThan(0);
  });

  test("uploads a shader without a manifest, just without code id", async () => {
    const path = await writeShaderFixture(DXIL_NAME, { manifest: false });
    const { prepared } = await prepareDifs(
      await scanPaths([path]),
      buildDifFilters({}),
    );

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.debugId).toBe(DXIL_DEBUG_ID);
    expect(prepared[0]?.codeId).toBeUndefined();
    expect(prepared[0]?.shaderGroup).toBeUndefined();
  });

  test("skips a shader whose name is not a 32-hex hash", async () => {
    const path = await writeShaderFixture("renamed.dxil", { manifest: false });
    const { prepared } = await prepareDifs(
      await scanPaths([path]),
      buildDifFilters({}),
    );

    expect(prepared).toHaveLength(0);
  });

  test("honours --type and --id", async () => {
    const path = await writeShaderFixture(DXIL_NAME, { manifest: true });
    const files = await scanPaths([path]);

    const byType = await prepareDifs(
      files,
      buildDifFilters({ types: ["dxil"] }),
    );
    expect(byType.prepared).toHaveLength(1);

    const otherType = await prepareDifs(
      files,
      buildDifFilters({ types: ["dsym"] }),
    );
    expect(otherType.prepared).toHaveLength(0);

    const byId = await prepareDifs(
      files,
      buildDifFilters({ ids: [DXIL_DEBUG_ID.toUpperCase()] }),
    );
    expect(byId.prepared).toHaveLength(1);

    const byStem = await prepareDifs(
      files,
      buildDifFilters({ ids: [DXIL_NAME.replace(/\.dxil$/, "")] }),
    );
    expect(byStem.prepared).toHaveLength(1);

    const otherId = await prepareDifs(
      files,
      buildDifFilters({ ids: ["00000000-0000-0000-0000-000000000001"] }),
    );
    expect(otherId.prepared).toHaveLength(0);
  });

  test("is not dropped by the feature filters shaders cannot satisfy", async () => {
    const path = await writeShaderFixture(DXIL_NAME, { manifest: false });
    const { prepared } = await prepareDifs(
      await scanPaths([path]),
      buildDifFilters({ noDebug: true, noUnwind: true, noSources: true }),
    );

    expect(prepared).toHaveLength(1);
  });

  test("counts an oversized shader like any other requested file", async () => {
    const path = await writeShaderFixture(DXIL_NAME, { manifest: false });
    const { prepared, oversizedCount } = await prepareDifs(
      await scanPaths([path]),
      buildDifFilters({ types: ["dxil"] }),
      { maxFileSize: 1 },
    );

    expect(prepared).toHaveLength(0);
    expect(oversizedCount).toBe(1);
  });
});
