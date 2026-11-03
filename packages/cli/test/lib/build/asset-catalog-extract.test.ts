import { mkdtempSync, rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AssetCatalogEntry,
  extractAssetCatalogImages,
} from "../../../src/lib/build/asset-catalog-extract.js";

const mocks = vi.hoisted(() => ({
  runHelper: vi.fn(),
  helperBytes: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.runHelper }),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdtemp: vi.fn(original.mkdtemp),
    writeFile: vi.fn(original.writeFile),
    rm: vi.fn(original.rm),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(() => false) };
});
vi.mock("../../../src/lib/sea-assets.js", () => ({
  getSeaRawAsset: mocks.helperBytes,
}));
vi.mock("../../../src/lib/logger.js", () => ({
  logger: { withTag: () => ({ debug: mocks.debug }) },
}));

const CATALOG = "Products/Applications/DemoApp.app/Assets.car";
const IMAGE_ID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
const directories: string[] = [];

function imageEntry(imageId = IMAGE_ID): AssetCatalogEntry {
  return {
    imageId,
    size: 1234,
    name: "Logo.jpg",
    vector: false,
    width: 32,
    height: 16,
    filename: "Logo.jpg",
    type: 2,
    idiom: "universal",
    colorspace: "srgb",
    scale: 2,
  };
}

async function writeOutput(
  args: string[],
  assets: readonly AssetCatalogEntry[],
): Promise<string> {
  const outputRoot = args[1];
  if (!outputRoot) {
    throw new Error("Missing fixture output directory");
  }
  const directory = join(outputRoot, dirname(CATALOG));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Assets.json"), JSON.stringify(assets));
  return directory;
}

describe("asset-catalog extraction boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    Object.defineProperty(process, "arch", {
      configurable: true,
      value: "arm64",
    });
    mocks.helperBytes.mockReturnValue(new Uint8Array([1, 2, 3]));
    mocks.runHelper.mockImplementation(
      async (_helper: string, args: string[]) => {
        const output = await writeOutput(args, [imageEntry()]);
        await writeFile(
          join(output, `${IMAGE_ID}.jpg`),
          new Uint8Array([0xff, 0xd8, 0xff]),
        );
        return { stdout: "", stderr: "" };
      },
    );
  });

  afterEach(() => {
    if (platformDescriptor && archDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
      Object.defineProperty(process, "arch", archDescriptor);
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function extract() {
    const directory = mkdtempSync(join(tmpdir(), "car-boundary-"));
    directories.push(directory);
    const catalog = join(directory, "Assets.car");
    await writeFile(catalog, "fixture-catalog");
    return await extractAssetCatalogImages(CATALOG, catalog);
  }

  test.each([
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ])("keeps raw catalogs on %s/%s", async (platform, arch) => {
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "arch", { value: arch });
    expect(await extract()).toBeNull();
    expect(mocks.helperBytes).not.toHaveBeenCalled();
  });

  test("keeps raw catalogs when no helper is shipped", async () => {
    mocks.helperBytes.mockReturnValue(undefined);
    // The dev helper is absent in this unit test's source tree.
    expect(await extract()).toBeNull();
    expect(mocks.runHelper).not.toHaveBeenCalled();
  });

  test("preserves legacy fields and sibling imageId filenames", async () => {
    const extraction = await extract();
    expect(extraction).not.toBeNull();
    if (!extraction) {
      throw new Error("Expected fixture extraction");
    }
    try {
      const manifestFile = extraction.files.find(
        (file) => file.name === "Assets.json",
      );
      if (!manifestFile) {
        throw new Error("Missing fixture manifest");
      }
      const manifest = JSON.parse(
        await readFile(manifestFile.sourcePath, "utf8"),
      );
      expect(manifest).toEqual([
        { ...imageEntry(), imageId: expect.any(String) },
      ]);
      expect(manifest[0].imageId).toMatch(
        /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/,
      );
      expect(manifest[0].imageId).not.toBe(IMAGE_ID);
      expect(extraction.files.map((file) => file.name).sort()).toEqual(
        ["Assets.json", `${manifest[0].imageId}.jpg`].sort(),
      );
      const imageFile = extraction.files.find((file) =>
        file.name.endsWith(".jpg"),
      );
      expect(imageFile).toBeDefined();
      if (imageFile) {
        expect(await readFile(imageFile.sourcePath)).toEqual(
          Buffer.from([0xff, 0xd8, 0xff]),
        );
      }
    } finally {
      await extraction.cleanup();
    }
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
  });

  test("preserves vectors and the aggregate color row without requiring images", async () => {
    const assets: AssetCatalogEntry[] = [
      {
        imageId: IMAGE_ID,
        size: 50,
        name: "Vector.pdf",
        filename: "Vector.pdf",
        vector: true,
        contentHash: "a".repeat(64),
      },
      { imageId: "", size: 25, name: "2 Colors", vector: false },
    ];
    mocks.runHelper.mockImplementation(
      async (_helper: string, args: string[]) => {
        await writeOutput(args, assets);
        return { stdout: "", stderr: "" };
      },
    );
    const extraction = await extract();
    if (!extraction) {
      throw new Error("Expected vector fixture extraction");
    }
    try {
      expect(extraction.files.map((file) => file.name)).toEqual([
        "Assets.json",
      ]);
      const first = extraction.files[0];
      if (!first) {
        throw new Error("Missing vector fixture manifest");
      }
      expect(JSON.parse(await readFile(first.sourcePath, "utf8"))).toEqual(
        expect.arrayContaining([
          assets[1],
          { ...assets[0], imageId: expect.any(String) },
        ]),
      );
    } finally {
      await extraction.cleanup();
    }
  });

  test("stays deterministic when native UUIDs and rendition order change", async () => {
    const otherId = "11111111-2222-3333-4444-555555555555";
    const outputs: { name: string; bytes: Buffer }[][] = [];
    for (const ids of [
      [IMAGE_ID, otherId],
      [otherId, IMAGE_ID],
    ]) {
      mocks.runHelper.mockImplementation(
        async (_helper: string, args: string[]) => {
          const assets = ids.map((id, i) => ({
            ...imageEntry(id),
            name: i ? "Other.jpg" : "Logo.jpg",
          }));
          const output = await writeOutput(args, [...assets].reverse());
          for (const asset of assets) {
            await writeFile(join(output, `${asset.imageId}.jpg`), asset.name);
          }
          return { stdout: "", stderr: "" };
        },
      );
      const extraction = await extract();
      if (!extraction) {
        throw new Error("Expected deterministic fixture extraction");
      }
      try {
        const files = [];
        for (const file of extraction.files) {
          files.push({
            name: file.name,
            bytes: await readFile(file.sourcePath),
          });
        }
        outputs.push(files);
      } finally {
        await extraction.cleanup();
      }
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });

  test.each(["../outside", "/absolute", "not-a-uuid"])(
    "rejects unsafe native image ID %s",
    async (id) => {
      mocks.runHelper.mockImplementation(
        async (_helper: string, args: string[]) => {
          await writeOutput(args, [imageEntry(id)]);
          return { stdout: "", stderr: "" };
        },
      );
      expect(await extract()).toBeNull();
      expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    },
  );

  test("rejects duplicate IDs instead of associating the wrong image", async () => {
    mocks.runHelper.mockImplementation(
      async (_helper: string, args: string[]) => {
        await writeOutput(args, [imageEntry(), imageEntry()]);
        return { stdout: "", stderr: "" };
      },
    );
    expect(await extract()).toBeNull();
  });

  test("rejects symlinked decoded output", async () => {
    mocks.runHelper.mockImplementation(
      async (_helper: string, args: string[]) => {
        const output = await writeOutput(args, [imageEntry()]);
        await symlink(
          join(output, "Assets.json"),
          join(output, `${IMAGE_ID}.jpg`),
        );
        return { stdout: "", stderr: "" };
      },
    );
    expect(await extract()).toBeNull();
  });

  test.each([
    "../Assets.car",
    "/Assets.car",
    "a/../Assets.car",
    "a\\Assets.car",
  ])("rejects unsafe input path %s", async (path) => {
    expect(await extractAssetCatalogImages(path, "unused")).toBeNull();
    expect(mocks.runHelper).not.toHaveBeenCalled();
  });

  test("contains temp-creation failure without exposing its exception", async () => {
    vi.mocked(mkdtemp).mockRejectedValueOnce(
      new Error("private-catalog-input"),
    );
    expect(await extract()).toBeNull();
    expect(mocks.runHelper).not.toHaveBeenCalled();
    expect(mocks.debug).toHaveBeenCalledWith(
      "Asset-catalog extraction failed; uploading the original catalog unchanged",
    );
  });

  test("keeps PNG association for a native filename ending in a dot", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mocks.runHelper.mockImplementation(
      async (_helper: string, args: string[]) => {
        const output = await writeOutput(args, [
          { ...imageEntry(), filename: "icon." },
        ]);
        await writeFile(join(output, `${IMAGE_ID}.png`), bytes);
        return { stdout: "", stderr: "" };
      },
    );
    const result = await extract();
    if (!result) {
      throw new Error("Expected PNG fixture extraction");
    }
    try {
      const image = result.files.find((file) => file.name.endsWith(".png"));
      const manifest = result.files.find((file) => file.name === "Assets.json");
      if (!image || !manifest) {
        throw new Error("Missing associated image or manifest");
      }
      const assets = JSON.parse(await readFile(manifest.sourcePath, "utf8"));
      expect(image.name).toBe(`${assets[0].imageId}.png`);
      expect(assets[0].filename).toBe("icon.");
      expect(await readFile(image.sourcePath)).toEqual(Buffer.from(bytes));
    } finally {
      await result.cleanup();
    }
  });

  test("cleans staging when materializing the embedded helper fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "car-materialization-"));
    directories.push(directory);
    const catalog = join(directory, "Assets.car");
    await writeFile(catalog, "fixture-catalog");
    vi.mocked(writeFile).mockRejectedValueOnce(
      new Error("private-helper-write-failure"),
    );
    expect(await extractAssetCatalogImages(CATALOG, catalog)).toBeNull();
    expect(mocks.runHelper).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    const staging = vi.mocked(rm).mock.calls[0]?.[0];
    expect(typeof staging).toBe("string");
    if (typeof staging === "string") {
      await expect(
        readFile(join(staging, "car-extract")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(mocks.debug.mock.calls.flat().join(" ")).not.toContain(
      "private-helper-write-failure",
    );
  });

  test("cleans staging when the native helper crashes", async () => {
    mocks.runHelper.mockRejectedValueOnce(new Error("private-native-stdout"));
    expect(await extract()).toBeNull();
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    expect(mocks.debug.mock.calls.flat().join(" ")).not.toContain(
      "private-native-stdout",
    );
  });

  test("cleanup failure never escapes the fallback", async () => {
    mocks.runHelper.mockRejectedValueOnce(new Error("native failure"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup failure"));
    expect(await extract()).toBeNull();
    const directory = vi.mocked(rm).mock.calls[0]?.[0];
    if (typeof directory === "string") {
      directories.push(directory);
    }
    expect(mocks.debug).toHaveBeenCalledWith(
      "Could not remove the temporary asset-catalog extraction directory",
    );
  });
});
