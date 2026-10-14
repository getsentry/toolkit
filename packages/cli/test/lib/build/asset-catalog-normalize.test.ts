import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, Unzip, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AssetCatalogExtraction,
  extractAssetCatalogImages,
} from "../../../src/lib/build/asset-catalog-extract.js";
import {
  normalizeBuildDirectory,
  normalizeIpa,
} from "../../../src/lib/build/index.js";

vi.mock("../../../src/lib/build/asset-catalog-extract.js", () => ({
  extractAssetCatalogImages: vi.fn(),
}));
const state = { directory: "" };
const CATALOG_PATH = "Products/Applications/DemoApp.app/Assets.car";
const IMAGE_ID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const CATALOG_BYTES = strToU8("original-catalog");
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const MANIFEST = [
  {
    imageId: IMAGE_ID,
    size: 123,
    name: "Logo",
    vector: false,
    filename: "Logo.png",
  },
];

function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const unzip = new Unzip((file) => names.push(file.name));
  // Record every local header: unzipSync collapses duplicate entry names.
  unzip.push(bytes, true);
  return names;
}

describe("parsed asset normalization", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    state.directory = await mkdtemp(join(tmpdir(), "car-normalize-"));
    vi.mocked(extractAssetCatalogImages).mockResolvedValue(null);
  });
  afterEach(async () => {
    await rm(state.directory, { recursive: true, force: true });
  });

  async function extraction(): Promise<AssetCatalogExtraction> {
    const manifestPath = join(state.directory, "Assets.json");
    const imagePath = join(state.directory, `${IMAGE_ID}.png`);
    await writeFile(manifestPath, JSON.stringify(MANIFEST));
    await writeFile(imagePath, IMAGE_BYTES);
    const result = {
      files: [
        { name: "Assets.json", sourcePath: manifestPath },
        { name: `${IMAGE_ID}.png`, sourcePath: imagePath },
      ],
      cleanup: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    vi.mocked(extractAssetCatalogImages).mockResolvedValue(result);
    return result;
  }

  async function archive(): Promise<string> {
    const directory = join(state.directory, "Demo.xcarchive");
    await mkdir(join(directory, "Products/Applications/DemoApp.app"), {
      recursive: true,
    });
    await writeFile(join(directory, "Info.plist"), "<plist/>");
    await writeFile(join(directory, CATALOG_PATH), CATALOG_BYTES);
    return directory;
  }

  test("streams XCArchive images next to the legacy manifest and preserves the catalog", async () => {
    const parsed = await extraction();
    const source = await archive();
    const output = join(state.directory, "normalized.zip");
    await normalizeBuildDirectory(source, output, null);
    const entries = unzipSync(await readFile(output));
    const prefix =
      "Demo.xcarchive/ParsedAssets/Products/Applications/DemoApp.app";
    expect(entries[`Demo.xcarchive/${CATALOG_PATH}`]).toEqual(CATALOG_BYTES);
    expect(entries[`${prefix}/${IMAGE_ID}.png`]).toEqual(IMAGE_BYTES);
    expect(
      JSON.parse(new TextDecoder().decode(entries[`${prefix}/Assets.json`])),
    ).toEqual(MANIFEST);
    expect(vi.mocked(extractAssetCatalogImages)).toHaveBeenCalledWith(
      CATALOG_PATH,
      join(source, CATALOG_PATH),
    );
    expect(parsed.cleanup).toHaveBeenCalledTimes(1);
  });

  test("expands the staged IPA catalog without loading the whole IPA into memory", async () => {
    const parsed = await extraction();
    const source = join(state.directory, "Demo.ipa");
    await writeFile(
      source,
      zipSync({
        "Payload/DemoApp.app/Info.plist": strToU8("<plist/>"),
        "Payload/DemoApp.app/Assets.car": CATALOG_BYTES,
      }),
    );
    const output = join(state.directory, "normalized.zip");
    await normalizeIpa(source, output, null);
    const entries = unzipSync(await readFile(output));
    const prefix =
      "archive.xcarchive/ParsedAssets/Products/Applications/DemoApp.app";
    expect(entries[`archive.xcarchive/${CATALOG_PATH}`]).toEqual(CATALOG_BYTES);
    expect(entries[`${prefix}/${IMAGE_ID}.png`]).toEqual(IMAGE_BYTES);
    expect(entries[`${prefix}/Assets.json`]).toBeDefined();
    expect(parsed.cleanup).toHaveBeenCalledTimes(1);
  });

  test("keeps failed or unsupported catalogs unchanged", async () => {
    const output = join(state.directory, "normalized.zip");
    await normalizeBuildDirectory(await archive(), output, null);
    const entries = unzipSync(await readFile(output));
    expect(entries[`Demo.xcarchive/${CATALOG_PATH}`]).toEqual(CATALOG_BYTES);
    expect(
      Object.keys(entries).some((name) => name.includes("ParsedAssets")),
    ).toBe(false);
  });

  test("never follows a symlinked catalog", async () => {
    const source = await archive();
    await rm(join(source, CATALOG_PATH));
    const outside = join(state.directory, "outside.car");
    await writeFile(outside, CATALOG_BYTES);
    await symlink(outside, join(source, CATALOG_PATH));
    await normalizeBuildDirectory(
      source,
      join(state.directory, "normalized.zip"),
      null,
    );
    expect(extractAssetCatalogImages).not.toHaveBeenCalled();
  });

  test("cleans extracted files when writing the ZIP fails", async () => {
    const parsed = await extraction();
    await rm(parsed.files[1]?.sourcePath ?? "invalid-fixture-path");
    await expect(
      normalizeBuildDirectory(
        await archive(),
        join(state.directory, "normalized.zip"),
        null,
      ),
    ).rejects.toThrow();
    expect(parsed.cleanup).toHaveBeenCalledTimes(1);
  });

  test("keeps one manifest when multiple catalogs share a folder", async () => {
    const parsed = await extraction();
    const source = await archive();
    await writeFile(
      join(source, "Products/Applications/DemoApp.app/Other.car"),
      CATALOG_BYTES,
    );
    const output = join(state.directory, "normalized.zip");
    await normalizeBuildDirectory(source, output, null);
    expect(extractAssetCatalogImages).toHaveBeenCalledTimes(2);
    expect(parsed.cleanup).toHaveBeenCalledTimes(2);
    const names = zipEntryNames(await readFile(output));
    expect(names.filter((name) => name.endsWith("Assets.json"))).toHaveLength(
      1,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(["Assets.json", `${IMAGE_ID}.png`])(
    "preserves existing parsed %s without duplicate ZIP entries",
    async (filename) => {
      const parsed = await extraction();
      const source = await archive();
      const prefix = "ParsedAssets/Products/Applications/DemoApp.app";
      await mkdir(join(source, prefix), { recursive: true });
      const original = strToU8("original-parsed-content");
      await writeFile(join(source, prefix, filename), original);
      const output = join(state.directory, "normalized.zip");
      await normalizeBuildDirectory(source, output, null);
      const bytes = await readFile(output);
      const names = zipEntryNames(bytes);
      expect(new Set(names).size).toBe(names.length);
      const entries = unzipSync(bytes);
      expect(entries[`Demo.xcarchive/${prefix}/${filename}`]).toEqual(original);
      expect(entries[`Demo.xcarchive/${CATALOG_PATH}`]).toEqual(CATALOG_BYTES);
      expect(names.filter((name) => name.includes("/ParsedAssets/"))).toEqual([
        `Demo.xcarchive/${prefix}/${filename}`,
      ]);
      expect(parsed.cleanup).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["file", "symlink"])(
    "preserves a %s occupying the generated parent path",
    async (kind) => {
      const parsed = await extraction();
      const source = await archive();
      const occupied = join(source, "ParsedAssets");
      if (kind === "file") {
        await writeFile(occupied, "original-parent-file");
      } else {
        await symlink("Products", occupied);
      }
      const output = join(state.directory, "normalized.zip");
      await normalizeBuildDirectory(source, output, null);
      const bytes = await readFile(output);
      const names = zipEntryNames(bytes);
      expect(new Set(names).size).toBe(names.length);
      expect(names.some((name) => name.includes("/ParsedAssets/"))).toBe(false);
      const entries = unzipSync(bytes);
      expect(
        new TextDecoder().decode(entries["Demo.xcarchive/ParsedAssets"]),
      ).toBe(kind === "file" ? "original-parent-file" : "Products");
      expect(entries[`Demo.xcarchive/${CATALOG_PATH}`]).toEqual(CATALOG_BYTES);
      expect(parsed.cleanup).toHaveBeenCalledTimes(1);
    },
  );
});
