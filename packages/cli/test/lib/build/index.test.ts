/**
 * Tests for mobile build detection + normalization.
 *
 * Fixtures are built in-memory with fflate (no committed binaries): a "fake
 * APK/AAB" is just a ZIP carrying the marker entry names the detector keys on.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
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
  run: (outPath: string) => Promise<void>
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
      null
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
      normalizeBuildFile(src, out, null)
    );

    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      ".sentry-cli-metadata.txt",
      "app-release.apk",
    ]);
    // The build bytes are stored verbatim.
    expect(entries["app-release.apk"]).toEqual(apk);
    const metadata = new TextDecoder().decode(entries[".sentry-cli-metadata.txt"]);
    expect(metadata).toContain("sentry-cli-version:");
  });

  test("records a recognized plugin in the metadata file", async () => {
    const src = writeTmpFile("app.aab", fakeAab());
    const zip = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, {
        name: "sentry-gradle-plugin",
        version: "4.12.0",
      })
    );
    const metadata = new TextDecoder().decode(
      unzipSync(zip)[".sentry-cli-metadata.txt"]
    );
    expect(metadata).toContain("sentry-gradle-plugin: 4.12.0");
  });

  test("is deterministic (identical input → identical bytes)", async () => {
    const src = writeTmpFile("app.apk", fakeApk());
    const a = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, null)
    );
    const b = await normalizeToBuffer((out) =>
      normalizeBuildFile(src, out, null)
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
      "binary"
    );
    return xc;
  }

  test("zips files under the directory basename plus a root metadata file", async () => {
    const zip = await normalizeToBuffer((out) =>
      normalizeBuildDirectory(fakeXcarchive(), out, null)
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
      normalizeBuildDirectory(xc, out, null)
    );
    const b = await normalizeToBuffer((out) =>
      normalizeBuildDirectory(xc, out, null)
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
        await normalizeToBuffer((out) => normalizeBuildDirectory(xc, out, null))
      );
      // The symlink entry stores its target path — proof it was NOT followed
      // (following would store "REAL", the target's file content).
      expect(new TextDecoder().decode(entries["App.xcarchive/link.txt"])).toBe(
        "real.txt"
      );
      expect(new TextDecoder().decode(entries["App.xcarchive/real.txt"])).toBe(
        "REAL"
      );
    }
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
      ])
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
      ])
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
    return normalizeToBuffer((out) => normalizeIpa(src, out, null));
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
      entries["archive.xcarchive/Info.plist"]
    );
    expect(plist).toContain("<string>Applications/MyApp.app</string>");
    // Assets.car is carried through verbatim (not parsed).
    expect(
      entries["archive.xcarchive/Products/Applications/MyApp.app/Assets.car"]
    ).toEqual(strToU8("carbytes"));
  });

  test("remaps nested framework entries under the app", async () => {
    const entries = unzipSync(
      await normalizeIpaBytes(
        zipSync({
          "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
          "Payload/MyApp.app/Frameworks/X.framework/X": strToU8("fw"),
        })
      )
    );
    expect(
      entries[
        "archive.xcarchive/Products/Applications/MyApp.app/Frameworks/X.framework/X"
      ]
    ).toEqual(strToU8("fw"));
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
          })
        )
      )
    );
    expect(names.some((n) => n.includes("Stray"))).toBe(false);
    expect(
      names.includes(
        "archive.xcarchive/Products/Applications/MyApp.app/MyApp"
      )
    ).toBe(true);
  });

  test("skips path-traversal entries", async () => {
    const names = Object.keys(
      unzipSync(
        await normalizeIpaBytes(
          zipSync({
            "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
            "Payload/MyApp.app/../../evil": strToU8("x"),
          })
        )
      )
    );
    expect(names.some((n) => n.includes("evil"))).toBe(false);
  });

  test("is deterministic (identical IPA → identical bytes)", async () => {
    const src = writeTmpFile("app.ipa", fakeIpaBytes());
    const a = await normalizeToBuffer((out) => normalizeIpa(src, out, null));
    const b = await normalizeToBuffer((out) => normalizeIpa(src, out, null));
    expect(a.equals(b)).toBe(true);
  });

  test("throws when the IPA has no single .app", async () => {
    const src = writeTmpFile("bad.ipa", zipSync({ "readme.txt": strToU8("x") }));
    await expect(
      normalizeToBuffer((out) => normalizeIpa(src, out, null))
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
