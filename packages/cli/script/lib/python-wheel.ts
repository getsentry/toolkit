/**
 * Python wheels for the standalone binaries.
 *
 * The CLI is published on PyPI under the v3 name, `sentry-cli`. Each wheel
 * holds one platform's binary as a data script, so pip puts a `sentry` (or
 * `sentry.exe`) command on PATH and needs no Python code to run it.
 * See https://packaging.python.org/en/latest/specifications/binary-distribution-format/
 */

import { createHash } from "node:crypto";
import { type Zippable, zipSync } from "fflate";

/** Distribution name, normalized for wheel file names. */
const DISTRIBUTION = "sentry_cli";

type WheelTarget = {
  /** Wheel platform tag. */
  platform: string;
  /** File name of the command in the scripts directory. */
  exe: string;
};

/**
 * One wheel per binary target. The binaries embed Node's official builds:
 * Linux ones need glibc 2.28, so there are no musllinux wheels. macOS ones need
 * 13.5, but pip only matches `_0` tags from macOS 11 on, so 13.0 is the closest
 * tag it installs.
 */
export const WHEEL_TARGETS: Record<string, WheelTarget> = {
  "darwin-arm64": { platform: "macosx_13_0_arm64", exe: "sentry" },
  "darwin-x64": { platform: "macosx_13_0_x86_64", exe: "sentry" },
  "linux-arm64": { platform: "manylinux_2_28_aarch64", exe: "sentry" },
  "linux-x64": { platform: "manylinux_2_28_x86_64", exe: "sentry" },
  "windows-x64": { platform: "win_amd64", exe: "sentry.exe" },
};

const SEMVER_RE = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc|dev)\.(\d+))?$/;
const PEP440_PRERELEASE: Record<string, string> = {
  alpha: "a",
  beta: "b",
  rc: "rc",
  dev: ".dev",
};

/**
 * Convert a CLI version to its normalized PEP 440 form: `1.2.3-rc.1` becomes
 * `1.2.3rc1`, and the nightly `1.2.3-dev.<timestamp>` becomes
 * `1.2.3.dev<timestamp>`.
 */
export function toPep440Version(version: string): string {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Cannot convert CLI version ${version} to PEP 440`);
  }
  const [, release, prerelease, number] = match;
  return prerelease
    ? `${release}${PEP440_PRERELEASE[prerelease]}${number}`
    : (release as string);
}

/** Zip external attributes of a regular Unix file, as an unsigned 32-bit int. */
function unixAttrs(mode: number): number {
  return ((0o100000 | mode) << 16) >>> 0;
}

/** RECORD hash: unpadded URL-safe base64 of the SHA-256 digest. */
function recordHash(data: Uint8Array): string {
  return `sha256=${createHash("sha256").update(data).digest("base64url")}`;
}

export type WheelInput = {
  /** Binary target, a key of {@link WHEEL_TARGETS}. */
  target: string;
  /** CLI version, as in package.json. */
  version: string;
  binary: Uint8Array;
  summary: string;
  /** Markdown shown on the PyPI project page. */
  readme: string;
  license: string;
};

/** Build the wheel for one binary target. */
export function buildWheel(input: WheelInput): {
  filename: string;
  contents: Uint8Array;
} {
  const target = WHEEL_TARGETS[input.target];
  if (!target) {
    throw new Error(`No wheel platform for binary target ${input.target}`);
  }
  const version = toPep440Version(input.version);
  const tag = `py3-none-${target.platform}`;
  const prefix = `${DISTRIBUTION}-${version}`;
  const distInfo = `${prefix}.dist-info`;
  const encoder = new TextEncoder();

  const metadata = [
    "Metadata-Version: 2.1",
    "Name: sentry-cli",
    `Version: ${version}`,
    `Summary: ${input.summary}`,
    "Home-page: https://cli.sentry.dev",
    "Author: Sentry",
    "Author-email: oss@sentry.io",
    "License: FSL-1.1-Apache-2.0",
    "Project-URL: Source, https://github.com/getsentry/toolkit",
    "Description-Content-Type: text/markdown",
    "",
    input.readme,
  ].join("\n");
  const wheel = [
    "Wheel-Version: 1.0",
    "Generator: getsentry/toolkit packages/cli/script/build-wheel.ts",
    "Root-Is-Purelib: false",
    `Tag: ${tag}`,
    "",
  ].join("\n");

  const files: [path: string, data: Uint8Array][] = [
    [`${prefix}.data/scripts/${target.exe}`, input.binary],
    [`${distInfo}/METADATA`, encoder.encode(metadata)],
    [`${distInfo}/WHEEL`, encoder.encode(wheel)],
    [`${distInfo}/LICENSE.md`, encoder.encode(input.license)],
  ];
  const recordPath = `${distInfo}/RECORD`;
  const record = [
    ...files.map(
      ([path, data]) => `${path},${recordHash(data)},${data.byteLength}`,
    ),
    `${recordPath},,`,
    "",
  ].join("\n");
  files.push([recordPath, encoder.encode(record)]);

  const zippable: Zippable = {};
  for (const [path, data] of files) {
    const executable = path.includes(".data/scripts/");
    zippable[path] = [
      data,
      { os: 3, attrs: unixAttrs(executable ? 0o755 : 0o644) },
    ];
  }
  return { filename: `${prefix}-${tag}.whl`, contents: zipSync(zippable) };
}
