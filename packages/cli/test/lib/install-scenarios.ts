/**
 * Shared behavior table for the bash (`install`) and PowerShell
 * (`install.ps1`) installers. Both suites run every scenario against their own
 * HTTP mocks, which follow the same contract, so any behavioral drift between
 * the two scripts fails CI.
 *
 * Mock contract (environment variables read by both mocks):
 * - SENTRY_TEST_REGISTRY_STATUS: HTTP status for release registry requests
 * - SENTRY_TEST_REGISTRY_BODY: path to a registry response template; every
 *   `__VERSION__` is replaced by the requested version (or
 *   SENTRY_TEST_LATEST_VERSION for `latest`)
 * - SENTRY_TEST_RELEASES_PAGE_<n>: path to GitHub releases page n (else `[]`)
 * - SENTRY_TEST_GZ_MISSING=1: gzip asset downloads fail
 * - SENTRY_TEST_GZ_FILE / SENTRY_TEST_RAW_FILE: bytes served for downloads
 * Every requested URL is recorded, in order, for `requests` assertions.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const LATEST_VERSION = "0.47.0";
const REGISTRY = "https://release-registry.services.sentry.io/apps/sentry";
const RELEASES_PAGE =
  "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=";

export function toolkitDownload(version: string, asset: string): string {
  return `https://github.com/getsentry/toolkit/releases/download/cli@${version}/${asset}`;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Bytes a runner serves for the gzip and raw downloads of its asset. */
export interface ServedAsset {
  name: string;
  gz: Buffer;
  raw: string | Buffer;
}

type RegistryResponse =
  | {
      status: 200;
      /** Advertise checksums that do not match the served bytes. */
      tamper?: boolean;
      /** Omit this platform's files from the release. */
      missingAsset?: boolean;
    }
  | { status: 404 | 503 };

export interface InstallScenario {
  name: string;
  /** Value of SENTRY_VERSION, if any. */
  version?: string;
  registry: RegistryResponse;
  /** GitHub releases pages served during a registry outage. */
  releases?: { tag_name: string; prerelease: boolean }[][];
  gzMissing?: boolean;
  ok: boolean;
  /** Every URL the installer requests, in order. */
  requests: (asset: string) => string[];
  /** Substrings expected in combined stdout and stderr. */
  output?: string[];
}

/** Build a registry response template in the release registry's shape. */
export function registryTemplate(
  served: ServedAsset,
  options: { tamper?: boolean; missing?: boolean },
): string {
  const entries: [string, string | Buffer][] = options.missing
    ? [["sentry-other-platform", "other"]]
    : [
        [`${served.name}.gz`, served.gz],
        [served.name, served.raw],
      ];
  const fileUrls: Record<string, string> = {};
  const files: Record<string, unknown> = {};
  for (const [name, bytes] of entries) {
    const url = toolkitDownload("__VERSION__", name);
    fileUrls[name] = url;
    files[name] = {
      checksums: {
        "sha256-hex": options.tamper ? sha256("tampered") : sha256(bytes),
      },
      url,
    };
  }
  return JSON.stringify(
    {
      canonical: "app:sentry",
      file_urls: fileUrls,
      files,
      name: "Sentry CLI",
      version: "__VERSION__",
    },
    null,
    2,
  );
}

/** Write a scenario's fixtures to `dir` and point the mock env at them. */
export function applyScenario(
  scenario: InstallScenario,
  served: ServedAsset,
  dir: string,
  env: NodeJS.ProcessEnv,
): void {
  const gzFile = join(dir, "served-asset.gz");
  const rawFile = join(dir, "served-asset");
  writeFileSync(gzFile, served.gz);
  writeFileSync(rawFile, served.raw);
  env.SENTRY_TEST_GZ_FILE = gzFile;
  env.SENTRY_TEST_RAW_FILE = rawFile;
  env.SENTRY_TEST_LATEST_VERSION = LATEST_VERSION;
  env.SENTRY_TEST_REGISTRY_STATUS = String(scenario.registry.status);
  const body = join(dir, "registry.json");
  writeFileSync(
    body,
    scenario.registry.status === 200
      ? registryTemplate(served, {
          tamper: scenario.registry.tamper,
          missing: scenario.registry.missingAsset,
        })
      : "",
  );
  env.SENTRY_TEST_REGISTRY_BODY = body;
  for (const [index, page] of (scenario.releases ?? []).entries()) {
    const file = join(dir, `releases-${index + 1}.json`);
    writeFileSync(file, JSON.stringify(page, null, 2));
    env[`SENTRY_TEST_RELEASES_PAGE_${index + 1}`] = file;
  }
  if (scenario.gzMissing) {
    env.SENTRY_TEST_GZ_MISSING = "1";
  }
  if (scenario.version !== undefined) {
    env.SENTRY_VERSION = scenario.version;
  }
}

export const INSTALL_SCENARIOS: InstallScenario[] = [
  {
    name: "installs the latest release from the registry",
    registry: { status: 200 },
    ok: true,
    requests: (asset) => [
      `${REGISTRY}/latest`,
      toolkitDownload(LATEST_VERSION, `${asset}.gz`),
    ],
  },
  {
    name: "strips a cli@ prefix from pinned versions",
    version: "cli@0.46.0",
    registry: { status: 200 },
    ok: true,
    requests: (asset) => [
      `${REGISTRY}/0.46.0`,
      toolkitDownload("0.46.0", `${asset}.gz`),
    ],
  },
  {
    name: "falls back to the raw binary when the gzip asset is missing",
    registry: { status: 200 },
    gzMissing: true,
    ok: true,
    requests: (asset) => [
      `${REGISTRY}/latest`,
      toolkitDownload(LATEST_VERSION, `${asset}.gz`),
      toolkitDownload(LATEST_VERSION, asset),
    ],
  },
  {
    name: "rejects a download whose checksum does not match the registry",
    registry: { status: 200, tamper: true },
    ok: false,
    output: ["Checksum mismatch"],
    requests: (asset) => [
      `${REGISTRY}/latest`,
      toolkitDownload(LATEST_VERSION, `${asset}.gz`),
    ],
  },
  {
    name: "stops when the release has no build for this platform",
    registry: { status: 200, missingAsset: true },
    ok: false,
    output: [`Sentry CLI ${LATEST_VERSION} has no`],
    requests: () => [`${REGISTRY}/latest`],
  },
  {
    name: "stops on an unknown pinned version",
    version: "9.9.9",
    registry: { status: 404 },
    ok: false,
    output: ["Unknown Sentry CLI version: 9.9.9"],
    requests: () => [`${REGISTRY}/9.9.9`],
  },
  {
    name: "rejects an invalid pinned version before any request",
    version: "1.2",
    registry: { status: 200 },
    ok: false,
    output: ["Invalid release version: 1.2"],
    requests: () => [],
  },
  {
    name: "falls back to the newest stable Toolkit CLI release when the registry is down",
    registry: { status: 503 },
    releases: [
      [
        { tag_name: "mcp@1.2.3", prerelease: false },
        { tag_name: "cli@0.48.0", prerelease: true },
      ],
      [{ tag_name: "cli@0.46.0", prerelease: false }],
    ],
    ok: true,
    output: ["Trying GitHub", "not checksum-verified"],
    requests: (asset) => [
      `${REGISTRY}/latest`,
      `${RELEASES_PAGE}1`,
      `${RELEASES_PAGE}2`,
      toolkitDownload("0.46.0", `${asset}.gz`),
    ],
  },
  {
    name: "uses the pinned Toolkit release when the registry is down",
    version: "0.46.0",
    registry: { status: 503 },
    ok: true,
    output: ["Trying GitHub", "not checksum-verified"],
    requests: (asset) => [
      `${REGISTRY}/0.46.0`,
      toolkitDownload("0.46.0", `${asset}.gz`),
    ],
  },
  {
    name: "stops when neither the registry nor GitHub has a stable release",
    registry: { status: 503 },
    ok: false,
    output: ["Failed to fetch latest stable version"],
    requests: () => [`${REGISTRY}/latest`, `${RELEASES_PAGE}1`],
  },
];
