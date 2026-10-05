/**
 * Tests for Xcode build-environment helpers.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  discoverInfoPlist,
  expandXcodeVars,
  findHermesc,
  findNode,
  parseInfoPlistStrings,
  resolveReleaseAndDist,
} from "../../../src/lib/react-native/xcode-env.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(() => "") };
});
const execMock = vi.mocked(execFileSync);

/** A complete four-key Info.plist XML body. */
const PLIST_XML = `<plist><dict>
  <key>CFBundleName</key><string>NAME</string>
  <key>CFBundleIdentifier</key><string>BUNDLE</string>
  <key>CFBundleShortVersionString</key><string>VERSION</string>
  <key>CFBundleVersion</key><string>BUILD</string>
</dict></plist>`;

const dirs: string[] = [];
beforeEach(() => {
  execMock.mockReset();
  execMock.mockReturnValue("");
});
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

describe("findNode / findHermesc", () => {
  test("prefer env overrides", () => {
    expect(findNode({ NODE_BINARY: "/usr/bin/node" })).toBe("/usr/bin/node");
    expect(findNode({})).toBe("node");
    expect(findHermesc({ HERMES_CLI_PATH: "/h" })).toBe("/h");
    expect(findHermesc({ PODS_ROOT: "/pods" })).toBe(
      "/pods/hermes-engine/destroot/bin/hermesc"
    );
  });
});

describe("expandXcodeVars", () => {
  test("expands parenthesized and braced references", () => {
    const vars = { FOO: "hello world" };
    expect(expandXcodeVars("A$(FOO)B", vars)).toBe("Ahello worldB");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Xcode ${VAR} syntax under test
    expect(expandXcodeVars("A${FOO}B", vars)).toBe("Ahello worldB");
    expect(expandXcodeVars("$(MISSING)", vars)).toBe("");
  });

  test("applies rfc1034identifier and identifier modifiers", () => {
    const vars = { FOO_BAR: "a b/c" };
    expect(expandXcodeVars("$(FOO_BAR:rfc1034identifier)", vars)).toBe("a-b-c");
    expect(expandXcodeVars("$(FOO_BAR:identifier)", vars)).toBe("a_b_c");
  });
});

describe("parseInfoPlistStrings", () => {
  test("extracts key/string pairs and decodes entities", () => {
    const xml = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.app</string>
  <key>CFBundleShortVersionString</key>
  <string>1.2.3</string>
  <key>CFBundleName</key><string>A &amp; B</string>
</dict></plist>`;
    const parsed = parseInfoPlistStrings(xml);
    expect(parsed.CFBundleIdentifier).toBe("com.example.app");
    expect(parsed.CFBundleShortVersionString).toBe("1.2.3");
    expect(parsed.CFBundleName).toBe("A & B");
  });
});

describe("discoverInfoPlist", () => {
  test("returns null when not running inside Xcode", async () => {
    expect(await discoverInfoPlist({}, "/tmp")).toBeNull();
  });

  test("reads and expands the Info.plist file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-plist-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "Info.plist"),
      `<plist><dict>
        <key>CFBundleName</key><string>MyApp</string>
        <key>CFBundleIdentifier</key><string>com.example.$(SUFFIX)</string>
        <key>CFBundleShortVersionString</key><string>2.0.0</string>
        <key>CFBundleVersion</key><string>42</string>
      </dict></plist>`
    );
    const plist = await discoverInfoPlist(
      {
        XCODE_VERSION_ACTUAL: "1500",
        INFOPLIST_FILE: "Info.plist",
        SUFFIX: "app",
      },
      dir
    );
    expect(plist).toEqual({
      name: "MyApp",
      bundleId: "com.example.app",
      version: "2.0.0",
      build: "42",
    });
  });

  test("falls back to build-setting env vars", async () => {
    const plist = await discoverInfoPlist(
      {
        XCODE_VERSION_ACTUAL: "1500",
        PRODUCT_NAME: "MyApp",
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
        MARKETING_VERSION: "1.0.0",
        CURRENT_PROJECT_VERSION: "7",
      },
      "/tmp"
    );
    expect(plist).toMatchObject({ bundleId: "com.example.app", build: "7" });
  });
});

describe("resolveReleaseAndDist", () => {
  test("prefers SENTRY_RELEASE/SENTRY_DIST env vars", async () => {
    const result = await resolveReleaseAndDist(
      { SENTRY_RELEASE: "app@1.0", SENTRY_DIST: "100" },
      "/tmp",
      false
    );
    expect(result).toEqual({ release: "app@1.0", dist: "100" });
  });

  test("returns empty when no-auto-release and no env vars", async () => {
    expect(await resolveReleaseAndDist({}, "/tmp", true)).toEqual({});
  });

  test("derives release from Info.plist", async () => {
    const result = await resolveReleaseAndDist(
      {
        XCODE_VERSION_ACTUAL: "1500",
        PRODUCT_NAME: "MyApp",
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
        MARKETING_VERSION: "3.1.0",
        CURRENT_PROJECT_VERSION: "55",
      },
      "/tmp",
      false
    );
    expect(result).toEqual({
      dist: "55",
      release: "com.example.app@3.1.0+55",
    });
  });

  test("throws when the identity cannot be determined", async () => {
    await expect(resolveReleaseAndDist({}, "/tmp", false)).rejects.toThrow(
      /Could not determine release/
    );
  });
});

describe("discoverInfoPlist: INFOPLIST_PREPROCESS", () => {
  test("runs cc when preprocessing is allowed and requested", async () => {
    execMock.mockReturnValue(
      PLIST_XML.replace("NAME", "Pre")
        .replace("BUNDLE", "com.pre.app")
        .replace("VERSION", "9.9")
        .replace("BUILD", "99")
    );
    const plist = await discoverInfoPlist(
      {
        XCODE_VERSION_ACTUAL: "1500",
        INFOPLIST_FILE: "Info.plist",
        INFOPLIST_PREPROCESS: "YES",
        INFOPLIST_PREPROCESSOR_DEFINITIONS: "DEBUG=1",
      },
      "/tmp",
      true
    );
    expect(plist).toEqual({
      name: "Pre",
      bundleId: "com.pre.app",
      version: "9.9",
      build: "99",
    });
    expect(execMock).toHaveBeenCalledWith(
      "cc",
      expect.arrayContaining(["-xc", "-P", "-E", "-DDEBUG=1"]),
      expect.anything()
    );
  });

  test("does not run cc when preprocessing is not allowed", async () => {
    const plist = await discoverInfoPlist(
      {
        XCODE_VERSION_ACTUAL: "1500",
        INFOPLIST_FILE: "Info.plist",
        INFOPLIST_PREPROCESS: "YES",
        // Fallback env vars so discovery still succeeds.
        PRODUCT_NAME: "Fallback",
        PRODUCT_BUNDLE_IDENTIFIER: "com.fallback.app",
        MARKETING_VERSION: "1.0",
        CURRENT_PROJECT_VERSION: "1",
      },
      "/does-not-exist",
      false
    );
    expect(execMock).not.toHaveBeenCalled();
    expect(plist).toMatchObject({ bundleId: "com.fallback.app" });
  });
});

describe("discoverInfoPlist: xcodebuild discovery (outside Xcode)", () => {
  test("resolves the release via xcodebuild when not in an Xcode build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-xcodeproj-"));
    dirs.push(dir);
    mkdirSync(join(dir, "MyApp.xcodeproj"));
    mkdirSync(join(dir, "MyApp"));
    writeFileSync(
      join(dir, "MyApp", "Info.plist"),
      PLIST_XML.replace("NAME", "MyApp")
        .replace("BUNDLE", "com.xcbuild.app")
        .replace("VERSION", "4.2.0")
        .replace("BUILD", "7")
    );

    execMock.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args?.includes("-list")) {
        return JSON.stringify({
          project: { targets: ["MyApp"], configurations: ["Debug", "Release"] },
        });
      }
      if (args?.includes("-showBuildSettings")) {
        // CRLF endings must not leak a trailing \r into the parsed values.
        return `    INFOPLIST_FILE = MyApp/Info.plist\r\n    PROJECT_DIR = ${dir}\r\n`;
      }
      return "";
    });

    const plist = await discoverInfoPlist({}, dir);
    expect(plist).toEqual({
      name: "MyApp",
      bundleId: "com.xcbuild.app",
      version: "4.2.0",
      build: "7",
    });
    // Used the Release configuration.
    expect(execMock).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-configuration", "Release"]),
      expect.anything()
    );
  });

  test("returns null when there is no .xcodeproj", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-empty-"));
    dirs.push(dir);
    expect(await discoverInfoPlist({}, dir)).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });
});
