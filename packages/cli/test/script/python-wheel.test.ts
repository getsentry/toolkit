import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  buildWheel,
  toPep440Version,
  WHEEL_TARGETS,
} from "../../script/lib/python-wheel.js";

const decoder = new TextDecoder();
const binary = new TextEncoder().encode("\x7fELF fake binary");

function build(target: string, version = "4.0.0") {
  return buildWheel({
    target,
    version,
    binary,
    summary: "Sentry CLI",
    readme: "# sentry-cli\n",
    license: "FSL",
  });
}

/** External attributes of each entry, read from the zip central directory. */
function externalAttrs(zip: Uint8Array): Map<string, number> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const attrs = new Map<string, number>();
  let offset = view.getUint32(zip.byteLength - 6, true);
  while (view.getUint32(offset, true) === 0x02_01_4b_50) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(
      zip.subarray(offset + 46, offset + 46 + nameLength),
    );
    attrs.set(name, view.getUint32(offset + 38, true));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return attrs;
}

describe("toPep440Version", () => {
  test.each([
    ["4.0.0", "4.0.0"],
    ["4.0.0-rc.1", "4.0.0rc1"],
    ["4.1.0-alpha.0", "4.1.0a0"],
    ["4.1.0-beta.2", "4.1.0b2"],
    ["4.1.0-dev.1764150000", "4.1.0.dev1764150000"],
  ])("%s → %s", (version, expected) => {
    expect(toPep440Version(version)).toBe(expected);
  });

  test("rejects versions it cannot convert", () => {
    expect(() => toPep440Version("4.0.0-preview")).toThrow(/PEP 440/);
  });
});

describe("buildWheel", () => {
  test("names the wheel after the sentry-cli distribution and platform", () => {
    expect(build("linux-x64").filename).toBe(
      "sentry_cli-4.0.0-py3-none-manylinux_2_28_x86_64.whl",
    );
    expect(build("darwin-arm64", "4.1.0-rc.1").filename).toBe(
      "sentry_cli-4.1.0rc1-py3-none-macosx_13_0_arm64.whl",
    );
  });

  test("has a wheel for every standalone binary", () => {
    expect(Object.keys(WHEEL_TARGETS).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "windows-x64",
    ]);
  });

  test("installs the binary as the sentry command", () => {
    const files = unzipSync(build("linux-x64").contents);
    expect(Object.keys(files).sort()).toEqual([
      "sentry_cli-4.0.0.data/scripts/sentry",
      "sentry_cli-4.0.0.dist-info/LICENSE.md",
      "sentry_cli-4.0.0.dist-info/METADATA",
      "sentry_cli-4.0.0.dist-info/RECORD",
      "sentry_cli-4.0.0.dist-info/WHEEL",
    ]);
    expect(files["sentry_cli-4.0.0.data/scripts/sentry"]).toEqual(binary);

    const windows = unzipSync(build("windows-x64").contents);
    expect(windows["sentry_cli-4.0.0.data/scripts/sentry.exe"]).toEqual(binary);
  });

  test("marks only the command executable", () => {
    const attrs = externalAttrs(build("linux-x64").contents);
    expect(attrs.get("sentry_cli-4.0.0.data/scripts/sentry")).toBe(
      0o100_755 * 0x1_00_00,
    );
    expect(attrs.get("sentry_cli-4.0.0.dist-info/METADATA")).toBe(
      0o100_644 * 0x1_00_00,
    );
  });

  test("writes platform-specific WHEEL and METADATA", () => {
    const files = unzipSync(build("linux-arm64").contents);
    const wheel = decoder.decode(files["sentry_cli-4.0.0.dist-info/WHEEL"]);
    expect(wheel).toContain("Root-Is-Purelib: false\n");
    expect(wheel).toContain("Tag: py3-none-manylinux_2_28_aarch64\n");

    const metadata = decoder.decode(
      files["sentry_cli-4.0.0.dist-info/METADATA"],
    );
    expect(metadata).toMatch(/^Metadata-Version: 2\.1\nName: sentry-cli\n/);
    expect(metadata).toContain("Version: 4.0.0\n");
    expect(metadata.endsWith("\n\n# sentry-cli\n")).toBe(true);
  });

  test("records the hash and size of every other file", () => {
    const files = unzipSync(build("darwin-x64").contents);
    const record = decoder
      .decode(files["sentry_cli-4.0.0.dist-info/RECORD"])
      .trimEnd()
      .split("\n");
    expect(record.at(-1)).toBe("sentry_cli-4.0.0.dist-info/RECORD,,");
    for (const line of record.slice(0, -1)) {
      const [path, hash, size] = line.split(",");
      const data = files[path as string] as Uint8Array;
      const digest = createHash("sha256").update(data).digest("base64url");
      expect(hash).toBe(`sha256=${digest}`);
      expect(Number(size)).toBe(data.byteLength);
    }
    expect(record).toHaveLength(Object.keys(files).length);
  });

  test("rejects unknown targets", () => {
    expect(() => build("linux-riscv64")).toThrow(/No wheel platform/);
  });
});
