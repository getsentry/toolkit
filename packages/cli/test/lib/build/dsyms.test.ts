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
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { collectDsymEntries } from "../../../src/lib/build/dsyms.js";
import { ValidationError } from "../../../src/lib/errors.js";

const SYMBOL_PATH = "Contents/Resources/DWARF/MyApp";
const ZIP_SYMBOL_PATH = `MyApp.app.dSYM/${SYMBOL_PATH}`;
const SYMLINK_OPTIONS = { os: 3, attrs: 0o120777 * 0x1_0000 };

describe("collectDsymEntries", () => {
  const dirs: string[] = [];
  beforeEach(async () => {
    dirs.push(await mkdtemp(join(tmpdir(), "dsym-test-")));
  });
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function root(): string {
    const dir = dirs[0];
    if (!dir) {
      throw new Error("Missing fixture directory");
    }
    return dir;
  }

  async function bundle(
    name = "MyApp.app.dSYM",
    parent = root(),
  ): Promise<string> {
    const dir = join(parent, name);
    await mkdir(join(dir, "Contents/Resources/DWARF"), { recursive: true });
    await writeFile(join(dir, SYMBOL_PATH), "symbols");
    return dir;
  }

  async function collect(paths: readonly string[]) {
    const stage = await mkdtemp(join(root(), "stage-"));
    return await collectDsymEntries(paths, stage);
  }

  async function zip(bytes: Uint8Array): Promise<string> {
    const path = join(root(), "dsyms.zip");
    await writeFile(path, bytes);
    return path;
  }

  test("collects a direct bundle's files for streaming", async () => {
    const entries = await collect([await bundle()]);
    expect(entries.map((entry) => entry.relPath)).toEqual([ZIP_SYMBOL_PATH]);
    expect(await readFile(entries[0]!.sourcePath, "utf8")).toBe("symbols");
  });

  test("recognizes a direct bundle with trailing slashes", async () => {
    const entries = await collect([`${await bundle()}///`]);
    expect(entries.map((entry) => entry.relPath)).toEqual([ZIP_SYMBOL_PATH]);
  });

  test("recognizes case-insensitive bundle extensions", async () => {
    const entries = await collect([await bundle("MyApp.DsYm")]);
    expect(entries[0]?.relPath).toBe(`MyApp.DsYm/${SYMBOL_PATH}`);
  });

  test("collects directories containing multiple bundles", async () => {
    const container = join(root(), "bundles");
    await bundle("MyApp.app.dSYM", container);
    await bundle("Framework.dSYM", container);
    const entries = await collect([container]);
    expect(entries.map((entry) => entry.relPath).sort()).toEqual([
      `Framework.dSYM/${SYMBOL_PATH}`,
      ZIP_SYMBOL_PATH,
    ]);
  });

  test.each(["", "dSYMs/"])(
    "extracts a ZIP with wrapper %j and ignores macOS metadata",
    async (prefix) => {
      const path = await zip(
        zipSync({
          [`${prefix}${ZIP_SYMBOL_PATH}`]: strToU8("zip symbols"),
          "__MACOSX/._MyApp.app.dSYM": strToU8("metadata"),
          [`${prefix}MyApp.app.dSYM/.DS_Store`]: strToU8("metadata"),
        }),
      );
      const entries = await collect([path]);
      expect(entries.map((entry) => entry.relPath)).toEqual([ZIP_SYMBOL_PATH]);
      expect(await readFile(entries[0]!.sourcePath, "utf8")).toBe(
        "zip symbols",
      );
    },
  );

  test("accepts safe Windows ZIP separators", async () => {
    const path = await zip(
      zipSync({ [ZIP_SYMBOL_PATH.replaceAll("/", "\\")]: strToU8("symbols") }),
    );
    expect((await collect([path]))[0]?.relPath).toBe(ZIP_SYMBOL_PATH);
  });

  test("rejects corrupted stored symbol bytes instead of masking them with a new checksum", async () => {
    const bytes = Buffer.from(
      zipSync({ [ZIP_SYMBOL_PATH]: strToU8("symbols") }, { level: 0 }),
    );
    // Change one payload byte without changing its length or either ZIP checksum.
    const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes[dataOffset] = 0x58;
    await expect(collect([await zip(bytes)])).rejects.toThrow(
      "Invalid checksum in dSYM ZIP",
    );
  });

  test.each([0, 6] as const)(
    "rejects an incorrect central-directory checksum with compression level %s",
    async (level) => {
      const bytes = Buffer.from(
        zipSync({ [ZIP_SYMBOL_PATH]: strToU8("symbols") }, { level }),
      );
      // The generated ZIP has no comment; its EOCD points to the real entry.
      const directoryOffset = bytes.readUInt32LE(bytes.length - 6);
      expect(bytes.readUInt32LE(directoryOffset + 16)).not.toBe(0);
      bytes.writeUInt32LE(0, directoryOffset + 16);
      await expect(collect([await zip(bytes)])).rejects.toThrow(
        "Invalid checksum in dSYM ZIP",
      );
    },
  );

  test.each([0, 6] as const)(
    "accepts a valid multi-chunk symbol entry with compression level %s",
    async (level) => {
      const symbols = strToU8("symbols".repeat(24_000));
      const path = await zip(
        zipSync({ [ZIP_SYMBOL_PATH]: symbols }, { level }),
      );
      const entries = await collect([path]);
      expect(await readFile(entries[0]!.sourcePath)).toEqual(
        Buffer.from(symbols),
      );
    },
  );

  test("rejects ZIP symlinks instead of converting them to files", async () => {
    const path = await zip(
      zipSync({ [ZIP_SYMBOL_PATH]: [strToU8("/secret"), SYMLINK_OPTIONS] }),
    );
    await expect(collect([path])).rejects.toThrow(/symlinks/i);
  });

  test("rejects a ZIP symlink after a fake central-directory signature in stored file data", async () => {
    // This is a valid ZIP. The old byte scanner sees this fake PK record in
    // ordinary file contents and skips past the real symlink's directory record.
    const decoy = new Uint8Array(46);
    const view = new DataView(decoy.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(28, 0xffff, true);
    view.setUint16(30, 0xffff, true);
    view.setUint16(32, 0xffff, true);
    const path = await zip(
      zipSync(
        {
          "decoy.bin": decoy,
          [ZIP_SYMBOL_PATH]: [strToU8("/secret"), SYMLINK_OPTIONS],
        },
        { level: 0 },
      ),
    );
    await expect(collect([path])).rejects.toThrow(/symlinks/i);
  });

  test("rejects symlinks in directory markers and ignored metadata", async () => {
    for (const name of ["MyApp.app.dSYM/", "__MACOSX/._link"]) {
      const path = await zip(
        zipSync({
          [ZIP_SYMBOL_PATH]: strToU8("symbols"),
          [name]: [strToU8("/secret"), SYMLINK_OPTIONS],
        }),
      );
      await expect(collect([path])).rejects.toThrow(/symlinks/i);
    }
  });

  test.each([
    "../escape",
    "MyApp.app.dSYM/../../escape",
    "..\\escape",
    "MyApp.app.dSYM\\..\\..\\escape",
    "/escape",
    "C:\\escape",
    "\\\\server\\share\\escape",
    "__MACOSX/../escape",
    "MyApp.app.dSYM/file\0suffix",
  ])("rejects the entire ZIP containing unsafe entry %j", async (name) => {
    const path = await zip(
      zipSync({
        [ZIP_SYMBOL_PATH]: strToU8("symbols"),
        [name]: strToU8("unsafe"),
      }),
    );
    await expect(collect([path])).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects duplicate ZIP file entries", async () => {
    // Distinct names normalize to the same destination after yauzl converts
    // Windows separators. Never silently overwrite the first entry.
    const path = await zip(
      zipSync({
        [ZIP_SYMBOL_PATH]: strToU8("one"),
        [ZIP_SYMBOL_PATH.replaceAll("/", "\\")]: strToU8("two"),
      }),
    );
    await expect(collect([path])).rejects.toThrow(/invalid or unsafe/i);
  });

  test("rejects missing inputs and directories without bundles", async () => {
    await expect(collect([join(root(), "missing")])).rejects.toThrow(
      /does not exist/i,
    );
    await expect(collect([root()])).rejects.toThrow(/no .dSYM bundles/i);
  });

  test("rejects corrupt ZIP inputs", async () => {
    await expect(collect([await zip(strToU8("not a zip"))])).rejects.toThrow(
      /invalid or unsafe/i,
    );
  });

  test("rejects empty bundles", async () => {
    const empty = join(root(), "Empty.dSYM");
    await mkdir(empty);
    await expect(collect([empty])).rejects.toThrow(/contains no files/i);
  });

  test("rejects duplicate bundle names across inputs", async () => {
    const first = await bundle();
    const second = await bundle("MyApp.app.dSYM", join(root(), "other"));
    await expect(collect([first, second])).rejects.toThrow(
      /multiple dSYM bundles named/i,
    );
  });

  test("rejects filesystem symlinks, including trailing-slash bundle links", async () => {
    const target = await bundle();
    const link = join(root(), "Link.dSYM");
    await symlink(target, link, "junction");
    await expect(collect([`${link}/`])).rejects.toThrow(/symlinks/i);
  });

  test("rejects symlinks within a bundle", async () => {
    const dir = await bundle();
    await symlink(join(dir, SYMBOL_PATH), join(dir, "linked-file"));
    await expect(collect([dir])).rejects.toThrow(/symlinks/i);
  });
});
