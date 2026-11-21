/**
 * Tests for mobile build detection + normalization.
 *
 * Fixtures are built in-memory with fflate (no committed binaries): a "fake
 * APK/AAB" is just a ZIP carrying the marker entry names the detector keys on.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fromBufferPromise } from "yauzl";
import {
  detectBuildFormat,
  detectBuildFormatFromFile,
  extractIpaAppName,
  normalizeBuildDirectory,
  normalizeBuildFile,
  normalizeIpa,
  parsePluginFromPipeline,
  validateXcarchiveDirectory,
} from "../../../src/lib/build/index.js";

/** Temp dirs created by tests; cleaned up via {@link cleanupTmp}. */
const tmpDirs: string[] = [];

/** Create a tracked temp directory that {@link cleanupTmp} will remove. */
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Remove every tracked temp directory. */
function cleanupTmp(): void {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

/** Write bytes to a fresh temp file and return its path. */
function writeTmpFile(name: string, data: Uint8Array): string {
  const dir = makeTmpDir("build-fixture-");
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(data));
  return path;
}

/**
 * Run a normalizer that writes a wrapper ZIP to disk and return the bytes.
 * The output path lives in a tracked temp dir.
 */
async function normalizeToBuffer(
  run: (outPath: string) => Promise<void>,
): Promise<Buffer> {
  const dir = makeTmpDir("build-out-");
  const outPath = join(dir, "normalized.zip");
  await run(outPath);
  return readFileSync(outPath);
}

function fakeApk(): Uint8Array {
  return zipSync({ "AndroidManifest.xml": strToU8("binary-xml") });
}

function fakeAab(): Uint8Array {
  return zipSync({
    "BundleConfig.pb": strToU8("cfg"),
    "base/manifest/AndroidManifest.xml": strToU8("xml"),
  });
}

function fakeIpa(): Uint8Array {
  return zipSync({ "Payload/MyApp.app/Info.plist": strToU8("plist") });
}

describe("detectBuildFormat", () => {
  test("detects an APK by its root AndroidManifest.xml", () => {
    expect(detectBuildFormat(fakeApk())).toBe("apk");
  });

  test("detects an AAB by BundleConfig.pb + base manifest", () => {
    expect(detectBuildFormat(fakeAab())).toBe("aab");
  });

  test("detects an IPA by its Payload/*.app/Info.plist", () => {
    expect(detectBuildFormat(fakeIpa())).toBe("ipa");
  });

  test("returns null for a ZIP without build markers", () => {
    expect(detectBuildFormat(zipSync({ "readme.txt": strToU8("hi") }))).toBe(
      null,
    );
  });

  test("returns null for non-ZIP bytes", () => {
    expect(detectBuildFormat(strToU8("not a zip"))).toBe(null);
  });
});

describe("parsePluginFromPipeline", () => {
  test("parses the gradle plugin", () => {
    expect(parsePluginFromPipeline("sentry-gradle-plugin/4.12.0")).toEqual({
      name: "sentry-gradle-plugin",
      version: "4.12.0",
    });
  });

  test("parses the fastlane plugin", () => {
    expect(parsePluginFromPipeline("sentry-fastlane-plugin/1.2.3")).toEqual({
      name: "sentry-fastlane-plugin",
      version: "1.2.3",
    });
  });

  test("ignores unrecognized plugins", () => {
    expect(parsePluginFromPipeline("some-other-tool/9.9.9")).toBe(null);
  });

  test("returns null for malformed or empty input", () => {
    expect(parsePluginFromPipeline(undefined)).toBe(null);
    expect(parsePluginFromPipeline("")).toBe(null);
    expect(parsePluginFromPipeline("no-slash")).toBe(null);
    expect(parsePluginFromPipeline("sentry-gradle-plugin/")).toBe(null);
  });
});

describe("normalizeBuildFile", () => {
  afterEach(cleanupTmp);

  test("wraps the build under its basename plus a metadata file", async () => {
    const apk = fakeApk();
    const src = writeTmpFile("app-release.apk", apk);
    const zip = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, null),
    );

    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      ".sentry-cli-metadata.txt",
      "app-release.apk",
    ]);
    // The build bytes are stored verbatim.
    expect(entries["app-release.apk"]).toEqual(apk);
    const metadata = new TextDecoder().decode(
      entries[".sentry-cli-metadata.txt"],
    );
    expect(metadata).toContain("sentry-cli-version:");
  });

  test("records a recognized plugin in the metadata file", async () => {
    const src = writeTmpFile("app.aab", fakeAab());
    const zip = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, {
        name: "sentry-gradle-plugin",
        version: "4.12.0",
      }),
    );
    const metadata = new TextDecoder().decode(
      unzipSync(zip)[".sentry-cli-metadata.txt"],
    );
    expect(metadata).toContain("sentry-gradle-plugin: 4.12.0");
  });

  test("is deterministic (identical input → identical bytes)", async () => {
    const src = writeTmpFile("app.apk", fakeApk());
    const a = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, null),
    );
    const b = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, null),
    );
    expect(a.equals(b)).toBe(true);
  });
});

describe("normalizeBuildDirectory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    cleanupTmp();
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  function fakeXcarchive(): string {
    const base = mkdtempSync(join(tmpdir(), "xc-"));
    dirs.push(base);
    const xc = join(base, "MyApp.xcarchive");
    mkdirSync(join(xc, "Products", "Applications", "MyApp.app"), {
      recursive: true,
    });
    writeFileSync(join(xc, "Info.plist"), "<plist/>");
    writeFileSync(
      join(xc, "Products", "Applications", "MyApp.app", "MyApp"),
      "binary",
    );
    return xc;
  }

  test("zips files under the directory basename plus a root metadata file", async () => {
    const zip = await normalizeToBuffer((out) =>
      normalizeBuildDirectory(fakeXcarchive(), out, null),
    );
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      ".sentry-cli-metadata.txt",
      "MyApp.xcarchive/Info.plist",
      "MyApp.xcarchive/Products/Applications/MyApp.app/MyApp",
    ]);
    expect(entries["MyApp.xcarchive/Info.plist"]).toEqual(strToU8("<plist/>"));
  });

  test("is deterministic (identical tree → identical bytes)", async () => {
    const xc = fakeXcarchive();
    const a = await normalizeToBuffer((out) =>
      normalizeBuildDirectory(xc, out, null),
    );
    const b = await normalizeToBuffer((out) =>
      normalizeBuildDirectory(xc, out, null),
    );
    expect(a.equals(b)).toBe(true);
  });

  // Symlinks require privileges on Windows; the unit suite runs on Linux.
  test.skipIf(process.platform === "win32")(
    "preserves symlinks as entries (stores the target path, not followed content)",
    async () => {
      const base = mkdtempSync(join(tmpdir(), "xc-sym-"));
      dirs.push(base);
      const xc = join(base, "App.xcarchive");
      mkdirSync(xc, { recursive: true });
      writeFileSync(join(xc, "real.txt"), "REAL");
      symlinkSync("real.txt", join(xc, "link.txt"));

      const entries = unzipSync(
        await normalizeToBuffer((out) =>
          normalizeBuildDirectory(xc, out, null),
        ),
      );
      // The symlink entry stores its target path — proof it was NOT followed
      // (following would store "REAL", the target's file content).
      expect(new TextDecoder().decode(entries["App.xcarchive/link.txt"])).toBe(
        "real.txt",
      );
      expect(new TextDecoder().decode(entries["App.xcarchive/real.txt"])).toBe(
        "REAL",
      );
    },
  );
});

describe("validateXcarchiveDirectory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  function makeArchive(build: (xc: string) => void): string {
    const base = mkdtempSync(join(tmpdir(), "xc-val-"));
    dirs.push(base);
    const xc = join(base, "MyApp.xcarchive");
    mkdirSync(xc, { recursive: true });
    build(xc);
    return xc;
  }

  test("accepts a valid XCArchive", () => {
    const xc = makeArchive((dir) => {
      const app = join(dir, "Products", "Applications", "MyApp.app");
      mkdirSync(app, { recursive: true });
      writeFileSync(join(dir, "Info.plist"), "<plist/>");
      writeFileSync(join(app, "Info.plist"), "<app/>");
    });
    expect(() => validateXcarchiveDirectory(xc)).not.toThrow();
  });

  test("rejects a directory missing the root Info.plist", () => {
    const xc = makeArchive((dir) => {
      mkdirSync(join(dir, "Products"), { recursive: true });
    });
    expect(() => validateXcarchiveDirectory(xc)).toThrow("Info.plist");
  });

  test("rejects a directory missing Products/", () => {
    const xc = makeArchive((dir) => {
      writeFileSync(join(dir, "Info.plist"), "<plist/>");
    });
    expect(() => validateXcarchiveDirectory(xc)).toThrow("Products/");
  });

  test("rejects when a .app bundle has no Info.plist", () => {
    const xc = makeArchive((dir) => {
      writeFileSync(join(dir, "Info.plist"), "<plist/>");
      mkdirSync(join(dir, "Products", "Applications", "MyApp.app"), {
        recursive: true,
      });
    });
    expect(() => validateXcarchiveDirectory(xc)).toThrow(".app bundle");
  });
});

describe("extractIpaAppName", () => {
  test("returns the single app name", () => {
    expect(
      extractIpaAppName([
        "Payload/MyApp.app/Info.plist",
        "Payload/MyApp.app/MyApp",
      ]),
    ).toBe("MyApp");
  });

  test("throws when there is no .app", () => {
    expect(() => extractIpaAppName(["readme.txt"])).toThrow("exactly one");
  });

  test("throws when there are multiple .apps", () => {
    expect(() =>
      extractIpaAppName([
        "Payload/A.app/Info.plist",
        "Payload/B.app/Info.plist",
      ]),
    ).toThrow("exactly one");
  });
});

describe("normalizeIpa", () => {
  afterEach(cleanupTmp);

  function fakeIpaBytes(): Uint8Array {
    return zipSync({
      "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
      "Payload/MyApp.app/MyApp": strToU8("binary"),
      "Payload/MyApp.app/Assets.car": strToU8("carbytes"),
    });
  }

  /** Write IPA bytes to a temp file and normalize it, returning the wrapper. */
  async function normalizeIpaBytes(ipa: Uint8Array): Promise<Buffer> {
    const src = writeTmpFile("app.ipa", ipa);
    return await normalizeToBuffer((out) => normalizeIpa(src, out, null));
  }

  /** Where the wrapper stores the files of `Payload/MyApp.app`. */
  const APP = "archive.xcarchive/Products/Applications/MyApp.app";

  /** Map each wrapper entry name to its `[host OS, external attributes]`. */
  async function wrapperAttributes(
    wrapperBytes: Buffer,
  ): Promise<Map<string, number[]>> {
    const wrapper = await fromBufferPromise(wrapperBytes);
    const attributes = new Map<string, number[]>();
    try {
      for await (const entry of wrapper.eachEntry()) {
        attributes.set(entry.fileName, [
          Math.floor(entry.versionMadeBy / 0x100),
          entry.externalFileAttributes,
        ]);
      }
    } finally {
      wrapper.close();
    }
    return attributes;
  }

  /**
   * Offsets of the central directory records of a ZIP without an archive
   * comment (as fflate writes it), for tests that patch a record in place.
   */
  function centralRecordOffsets(bytes: Buffer): number[] {
    const offsets: number[] = [];
    let offset = bytes.readUInt32LE(bytes.length - 6);
    for (let i = 0; i < bytes.readUInt16LE(bytes.length - 12); i++) {
      offsets.push(offset);
      offset +=
        46 +
        bytes.readUInt16LE(offset + 28) +
        bytes.readUInt16LE(offset + 30) +
        bytes.readUInt16LE(offset + 32);
    }
    return offsets;
  }

  test("remaps Payload into an XCArchive layout with a generated Info.plist", async () => {
    const zip = await normalizeIpaBytes(fakeIpaBytes());
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      ".sentry-cli-metadata.txt",
      "archive.xcarchive/Info.plist",
      "archive.xcarchive/Products/Applications/MyApp.app/Assets.car",
      "archive.xcarchive/Products/Applications/MyApp.app/Info.plist",
      "archive.xcarchive/Products/Applications/MyApp.app/MyApp",
    ]);
    const plist = new TextDecoder().decode(
      entries["archive.xcarchive/Info.plist"],
    );
    expect(plist).toContain("<string>Applications/MyApp.app</string>");
    // Assets.car is carried through verbatim (not parsed).
    expect(
      entries["archive.xcarchive/Products/Applications/MyApp.app/Assets.car"],
    ).toEqual(strToU8("carbytes"));
  });

  test("remaps nested framework entries under the app", async () => {
    const entries = unzipSync(
      await normalizeIpaBytes(
        zipSync({
          "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
          "Payload/MyApp.app/Frameworks/X.framework/X": strToU8("fw"),
        }),
      ),
    );
    expect(
      entries[
        "archive.xcarchive/Products/Applications/MyApp.app/Frameworks/X.framework/X"
      ],
    ).toEqual(strToU8("fw"));
  });

  test("preserves Unix permissions when remapping IPA files", async () => {
    const modes = {
      "Info.plist": 0o100644,
      MyApp: 0o100755,
      "Frameworks/X.framework/X": 0o100750,
    };
    const files: Zippable = {};
    for (const [name, mode] of Object.entries(modes)) {
      files[`Payload/MyApp.app/${name}`] = [
        strToU8(name),
        { os: 3, attrs: mode * 0x10000 },
      ];
    }
    const actual = await wrapperAttributes(
      await normalizeIpaBytes(zipSync(files)),
    );
    for (const [name, mode] of Object.entries(modes)) {
      expect(actual.get(`${APP}/${name}`)).toEqual([3, mode * 0x10000]);
    }
  });

  test("forwards only regular-file and symlink modes from IPA entries", async () => {
    // [host OS, mode] stored in the IPA → [host OS, mode] expected in the wrapper.
    const cases: Record<string, [number, number, number, number]> = {
      "Info.plist": [3, 0o100644, 3, 0o100644],
      setuid: [3, 0o104755, 3, 0o100755],
      symlink: [3, 0o120777, 3, 0o120777],
      typeless: [3, 0o755, 3, 0o100755],
      fifo: [3, 0o010644, 0, 0],
      "no-permissions": [3, 0o100000, 0, 0],
      "no-mode": [3, 0, 0, 0],
      "not-unix": [0, 0o100755, 0, 0],
    };
    const files: Zippable = {};
    for (const [name, [os, mode]] of Object.entries(cases)) {
      files[`Payload/MyApp.app/${name}`] = [
        strToU8(name),
        { os, attrs: mode * 0x10000 },
      ];
    }
    const actual = await wrapperAttributes(
      await normalizeIpaBytes(zipSync(files)),
    );
    for (const [name, [, , os, mode]] of Object.entries(cases)) {
      expect([name, actual.get(`${APP}/${name}`)]).toEqual([
        name,
        [os, mode * 0x10000],
      ]);
    }
  });

  test("includes only the identified app's entries", async () => {
    const names = Object.keys(
      unzipSync(
        await normalizeIpaBytes(
          zipSync({
            "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
            "Payload/MyApp.app/MyApp": strToU8("bin"),
            // A stray second .app (no Info.plist so extractIpaAppName still
            // sees one) must not be bundled.
            "Payload/Stray.app/junk": strToU8("junk"),
          }),
        ),
      ),
    );
    expect(names.some((n) => n.includes("Stray"))).toBe(false);
    expect(
      names.includes("archive.xcarchive/Products/Applications/MyApp.app/MyApp"),
    ).toBe(true);
  });

  test("skips path-traversal entries", async () => {
    const names = Object.keys(
      unzipSync(
        await normalizeIpaBytes(
          zipSync({
            "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
            "Payload/MyApp.app/../../evil": strToU8("x"),
            "Payload/MyApp.app/..\\..\\evil": strToU8("x"),
          }),
        ),
      ),
    );
    expect(names.some((n) => n.includes("evil"))).toBe(false);
  });

  test("keeps a file whose name contains a backslash", async () => {
    const entries = unzipSync(
      await normalizeIpaBytes(
        zipSync({
          "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
          "Payload/MyApp.app/Assets/a\\b.dat": strToU8("data"),
        }),
      ),
    );
    expect(entries[`${APP}/Assets/a\\b.dat`]).toEqual(strToU8("data"));
  });

  test("decodes a name without the UTF-8 flag as UTF-8 when valid, else as CP437", async () => {
    const bytes = Buffer.from(
      zipSync({
        "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
        "Payload/MyApp.app/utf8-café.png": strToU8("utf8"),
        "Payload/MyApp.app/cp437-caf_.png": strToU8("cp437"),
      }),
    );
    const [, utf8, cp437] = centralRecordOffsets(bytes) as [
      number,
      number,
      number,
    ];
    // macOS ditto, Archive Utility and zip write UTF-8 names without the flag.
    expect(bytes.readUInt16LE(utf8 + 8)).toBe(0x08_00);
    bytes.writeUInt16LE(0, utf8 + 8);
    // 0x82 is "é" in CP437 and is not valid UTF-8 on its own.
    bytes[bytes.indexOf("_", cp437)] = 0x82;

    const entries = unzipSync(await normalizeIpaBytes(bytes));
    expect(entries[`${APP}/utf8-café.png`]).toEqual(strToU8("utf8"));
    expect(entries[`${APP}/cp437-café.png`]).toEqual(strToU8("cp437"));
  });

  test("rejects an IPA whose entry count wrapped instead of uploading part of it", async () => {
    const bytes = Buffer.from(fakeIpaBytes());
    // Without ZIP64 records, an archive over 65,535 entries declares its count
    // modulo 65,536. Declaring two of the three entries gives the same shape.
    bytes.writeUInt16LE(2, bytes.length - 14);
    bytes.writeUInt16LE(2, bytes.length - 12);
    await expect(normalizeIpaBytes(bytes)).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("does not match its declared size"),
    });
  });

  test("rejects corrupted stored bytes instead of masking them with a new checksum", async () => {
    const bytes = Buffer.from(
      zipSync(
        { "Payload/MyApp.app/Info.plist": strToU8("<app/>") },
        { level: 0 },
      ),
    );
    // Change one payload byte without changing its length or either ZIP checksum.
    const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes[dataOffset] = 0x58;
    await expect(normalizeIpaBytes(bytes)).rejects.toThrow(
      "Invalid checksum in IPA",
    );
  });

  test("reports an archive the ZIP parser rejects as a validation error", async () => {
    const bytes = Buffer.concat([fakeIpaBytes(), Buffer.from("stray")]);
    await expect(normalizeIpaBytes(bytes)).rejects.toMatchObject({
      name: "ValidationError",
      message: "Invalid or unsupported IPA archive",
    });
  });

  test("is deterministic (identical IPA → identical bytes)", async () => {
    const src = writeTmpFile("app.ipa", fakeIpaBytes());
    const a = await normalizeToBuffer((out) => normalizeIpa(src, out, null));
    const b = await normalizeToBuffer((out) => normalizeIpa(src, out, null));
    expect(a.equals(b)).toBe(true);
  });

  test("embeds streamed dSYMs deterministically regardless of input and ZIP order", async () => {
    const src = writeTmpFile("app.ipa", fakeIpaBytes());
    const bundle = makeTmpDir("dsym-bundles-");
    const dsym = join(bundle, "App.dSYM");
    mkdirSync(dsym);
    writeFileSync(join(dsym, "symbols"), "app symbols");
    const firstZip = writeTmpFile(
      "first.zip",
      zipSync({
        "Framework.dSYM/z": strToU8("z"),
        "Framework.dSYM/a": strToU8("a"),
      }),
    );
    const secondZip = writeTmpFile(
      "second.zip",
      zipSync({
        "Framework.dSYM/a": strToU8("a"),
        "Framework.dSYM/z": strToU8("z"),
      }),
    );
    const first = await normalizeToBuffer((out) =>
      normalizeIpa(src, out, null, [dsym, firstZip]),
    );
    const second = await normalizeToBuffer((out) =>
      normalizeIpa(src, out, null, [secondZip, `${dsym}/`]),
    );
    expect(first.equals(second)).toBe(true);
    const entries = unzipSync(first);
    expect(entries["archive.xcarchive/dSYMs/App.dSYM/symbols"]).toEqual(
      strToU8("app symbols"),
    );
    expect(entries["archive.xcarchive/dSYMs/Framework.dSYM/a"]).toEqual(
      strToU8("a"),
    );
    expect(
      entries["archive.xcarchive/Products/Applications/MyApp.app/MyApp"],
    ).toEqual(strToU8("binary"));
  });

  test.each(["valid", "traversal", "checksum"])(
    "cleans up staging after dSYM extraction: %s",
    async (scenario) => {
      const src = writeTmpFile("app.ipa", fakeIpaBytes());
      const bytes = Buffer.from(
        zipSync({
          "App.dSYM/symbols": strToU8("symbols"),
          ...(scenario === "traversal"
            ? { "../escape": strToU8("unsafe") }
            : {}),
        }),
      );
      if (scenario === "checksum") {
        const directoryOffset = bytes.readUInt32LE(bytes.length - 6);
        bytes.writeUInt32LE(0, directoryOffset + 16);
      }
      const dsym = writeTmpFile("dsyms.zip", bytes);
      const stagingRoot = makeTmpDir("build-staging-");
      vi.stubEnv("TMPDIR", stagingRoot);
      try {
        const output = join(stagingRoot, "normalized.zip");
        if (scenario !== "valid") {
          await expect(normalizeIpa(src, output, null, [dsym])).rejects.toThrow(
            scenario === "checksum" ? /checksum/i : /unsafe/i,
          );
        } else {
          await normalizeIpa(src, output, null, [dsym]);
          expect(
            unzipSync(readFileSync(output))[
              "archive.xcarchive/dSYMs/App.dSYM/symbols"
            ],
          ).toEqual(strToU8("symbols"));
        }
        expect(readdirSync(stagingRoot)).toEqual(
          scenario === "valid" ? ["normalized.zip"] : [],
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  test("throws when the IPA has no single .app", async () => {
    const src = writeTmpFile(
      "bad.ipa",
      zipSync({ "readme.txt": strToU8("x") }),
    );
    await expect(
      normalizeToBuffer((out) => normalizeIpa(src, out, null)),
    ).rejects.toThrow("exactly one");
  });
});

describe("detectBuildFormatFromFile", () => {
  afterEach(cleanupTmp);

  test("detects an APK from a file on disk", async () => {
    const src = writeTmpFile("app.apk", fakeApk());
    expect(await detectBuildFormatFromFile(src)).toBe("apk");
  });

  test("detects an AAB from a file on disk", async () => {
    const src = writeTmpFile("app.aab", fakeAab());
    expect(await detectBuildFormatFromFile(src)).toBe("aab");
  });

  test("detects an IPA from a file on disk", async () => {
    const src = writeTmpFile("app.ipa", fakeIpa());
    expect(await detectBuildFormatFromFile(src)).toBe("ipa");
  });

  test("returns null for a ZIP without build markers", async () => {
    const src = writeTmpFile("x.zip", zipSync({ "readme.txt": strToU8("hi") }));
    expect(await detectBuildFormatFromFile(src)).toBe(null);
  });

  test("returns null for a non-ZIP file", async () => {
    const src = writeTmpFile("x.bin", strToU8("not a zip"));
    expect(await detectBuildFormatFromFile(src)).toBe(null);
  });
});
