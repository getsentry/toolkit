/** Delta upgrade discovery and application backed by binpatch. */

import { join } from "node:path";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import {
  applyPatchChainInMemory,
  extractStableChain as binpatchExtractStableChain,
  filterAndSortChainTags as binpatchFilterAndSortChainTags,
  validateChainStep as binpatchValidateChainStep,
  type DeltaTelemetry,
  type DeltaUnavailableReason,
  type ExtractStableChainOpts,
  type GitHubRelease,
  getPatchFromVersion,
  getPatchTargetSha256,
  ghcrSource,
  githubReleaseSource,
  type InstrumentHook,
  MAX_NIGHTLY_CHAIN_DEPTH,
  makeCache,
  OciClient,
  type OciManifest,
  PATCH_TAG_PREFIX,
  type PatchCache,
  type PatchChain,
  type ProgressHandler,
  resolveAndApply,
  SIZE_THRESHOLD_RATIO,
  type SourceStrategy,
  type StableChainInfo,
} from "binpatch";
import { prerelease as semverPrerelease, valid as semverValid } from "semver";
import {
  compareVersions,
  getGitHubReleasesUrl,
  getPlatformBinaryName,
  isDowngrade,
  isNightlyVersion,
  PRIMARY_UPGRADE_SOURCE,
  type UpgradeSource,
} from "./binary.js";
import { CLI_VERSION } from "./constants.js";
import { customFetch } from "./custom-ca.js";
import { getConfigDir } from "./db/index.js";
import { formatBytes } from "./formatters/numbers.js";
import { logger } from "./logger.js";
import { makeByteProgress, type SetMessage } from "./progress.js";
import { withTracing, withTracingSpan } from "./telemetry.js";

export type {
  ExtractStableChainOpts,
  GitHubAsset,
  GitHubRelease,
  PatchChain,
  StableChainInfo,
} from "binpatch";
// biome-ignore lint/performance/noBarrelFile: preserve the existing public API
export {
  extractSha256,
  getPatchFromVersion,
  getPatchTargetSha256,
  getStableTargetSha256,
  PATCH_TAG_PREFIX,
} from "binpatch";

export type DeltaResult = {
  sha256: string;
  patchBytes: number;
  chainLength: number;
};

const log = logger.withTag("delta-upgrade");

const NORMALIZED_RELEASE_SOURCE = Symbol("normalizedReleaseSource");

/** Stable GitHub releases normalized for one explicit upgrade source. */
export type NormalizedGitHubReleases = GitHubRelease[] & {
  /** Stable key for the source that produced these normalized tags. */
  readonly [NORMALIZED_RELEASE_SOURCE]: string;
};

function upgradeSourceKey(source: UpgradeSource): string {
  return `${source.githubRepo}\0${source.ghcrRepo}\0${source.tagPrefix}`;
}

/** Return whether a normalized release list belongs to the selected source. */
export function isNormalizedForSource(
  releases: GitHubRelease[],
  source: UpgradeSource
): boolean {
  return (
    (releases as Partial<NormalizedGitHubReleases>)[
      NORMALIZED_RELEASE_SOURCE
    ] === upgradeSourceKey(source)
  );
}

/** Filter and normalize raw stable GitHub releases for one upgrade source. */
export function normalizeStableReleases(
  releases: unknown[],
  source: UpgradeSource
): NormalizedGitHubReleases {
  const normalized = releases
    .filter(isGitHubRelease)
    .filter((release) => !(release.draft || release.prerelease))
    .filter((release) => release.tag_name.startsWith(source.tagPrefix))
    .map((release) => ({
      ...release,
      tag_name: release.tag_name.slice(source.tagPrefix.length),
    }))
    .filter(
      (release) =>
        semverValid(release.tag_name) !== null &&
        semverPrerelease(release.tag_name) === null
    ) as NormalizedGitHubReleases;
  Object.defineProperty(normalized, NORMALIZED_RELEASE_SOURCE, {
    value: upgradeSourceKey(source),
  });
  return normalized;
}

function getPrimaryUpgradeSource(): UpgradeSource {
  if (!PRIMARY_UPGRADE_SOURCE) {
    throw new Error("No primary upgrade source is configured");
  }
  return PRIMARY_UPGRADE_SOURCE;
}

const instrument: InstrumentHook = (name, fn) =>
  withTracing(name, "http.client", fn);

function patchCacheKey(fromVersion: string, toVersion: string): string {
  return `patch-chain:${fromVersion}-${toVersion}`;
}

function instrumentCache(base: PatchCache): PatchCache {
  return {
    load(currentVersion, targetVersion) {
      const key = patchCacheKey(currentVersion, targetVersion);
      return withTracingSpan(key, "cache.get", async (span) => {
        span.setAttribute("cache.key", [key]);
        const result = await base.load(currentVersion, targetVersion);
        span.setAttribute("cache.hit", result !== null);
        if (result) {
          span.setAttribute("cache.item_size", result.totalSize);
        }
        return result;
      });
    },
    save(chain, steps) {
      const first = steps.at(0);
      const last = steps.at(-1);
      if (!(first && last)) {
        return base.save(chain, steps);
      }
      const key = patchCacheKey(first.fromVersion, last.toVersion);
      return withTracingSpan(key, "cache.put", async (span) => {
        span.setAttribute("cache.key", [key]);
        span.setAttribute(
          "cache.item_size",
          chain.patches.reduce((sum, patch) => sum + patch.size, 0)
        );
        await base.save(chain, steps);
      });
    },
    cleanup: () => base.cleanup(),
    clear: () => base.clear(),
  };
}

function getPatchCache(): PatchCache {
  return instrumentCache(makeCache(join(getConfigDir(), "patch-cache")));
}

function stableSource(source: UpgradeSource): SourceStrategy {
  const releasesUrl = getGitHubReleasesUrl(source);
  const sourceFetch: typeof customFetch = async (input, init) => {
    const response = await customFetch(input, init);
    if (!(response.ok && String(input).startsWith(`${releasesUrl}?`))) {
      return response;
    }
    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      return new Response(JSON.stringify(data), response);
    }
    const releases = normalizeStableReleases(data, source);
    return new Response(JSON.stringify(releases), response);
  };

  return githubReleaseSource({
    releasesUrl,
    binaryName: getPlatformBinaryName(),
    userAgent: `sentry-cli/${CLI_VERSION}`,
    fetch: sourceFetch,
    instrument,
  });
}

function isGitHubRelease(value: unknown): value is GitHubRelease & {
  draft?: boolean;
  prerelease?: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    "assets" in value &&
    Array.isArray(value.assets)
  );
}

function nightlySource(source: UpgradeSource): SourceStrategy {
  return ghcrSource({
    registry: "https://ghcr.io",
    repo: source.ghcrRepo,
    binaryName: getPlatformBinaryName(),
    targetTag: (version) => `nightly-${version}`,
    compareVersions,
    userAgent: `sentry-cli/${CLI_VERSION}`,
    fetch: customFetch,
    instrument,
  });
}

export function canAttemptDelta(targetVersion: string): boolean {
  if (CLI_VERSION === "0.0.0-dev") {
    return false;
  }
  if (isNightlyVersion(CLI_VERSION) !== isNightlyVersion(targetVersion)) {
    return false;
  }
  return !isDowngrade(CLI_VERSION, targetVersion);
}

export async function fetchRecentReleases(
  signal?: AbortSignal,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<NormalizedGitHubReleases> {
  try {
    const response = await customFetch(
      `${getGitHubReleasesUrl(source)}?per_page=12`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": `sentry-cli/${CLI_VERSION}`,
        },
        signal,
      }
    );
    if (!response.ok) {
      return normalizeStableReleases([], source);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      log.debug("GitHub releases response is not an array", typeof data);
      return normalizeStableReleases([], source);
    }
    return normalizeStableReleases(data, source);
  } catch (error) {
    log.debug("Failed to fetch recent releases from GitHub", error);
    return normalizeStableReleases([], source);
  }
}

export async function downloadStablePatch(
  url: string,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  try {
    const response = await customFetch(url, {
      headers: { "User-Agent": `sentry-cli/${CLI_VERSION}` },
      signal,
    });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch (error) {
    log.debug("Failed to download stable patch", error);
    return null;
  }
}

export function extractStableChain(
  opts: ExtractStableChainOpts
): StableChainInfo | null {
  const result = binpatchExtractStableChain(opts);
  return "failure" in result ? null : result;
}

export function filterAndSortChainTags(
  allTags: string[],
  currentVersion: string,
  targetVersion: string
): string[] {
  return binpatchFilterAndSortChainTags(
    allTags,
    currentVersion,
    targetVersion,
    compareVersions
  );
}

type ChainStepResult =
  | { ok: true; digest: string; size: number }
  | {
      ok: false;
      failure:
        | {
            reason: "version-mismatch";
            expected: string;
            actual: string | null;
          }
        | { reason: "missing-layer"; layerName: string }
        | { reason: "size-exceeded"; layerSize: number; budget: number };
    };

export function validateChainStep(
  manifest: OciManifest,
  opts: { expectedFrom: string; patchLayerName: string; sizeLimit: number }
): ChainStepResult {
  const fromVersion = getPatchFromVersion(manifest);
  if (fromVersion !== opts.expectedFrom) {
    return {
      ok: false,
      failure: {
        reason: "version-mismatch",
        expected: opts.expectedFrom,
        actual: fromVersion,
      },
    };
  }
  const result = binpatchValidateChainStep(manifest, opts);
  if (result.ok) {
    return result;
  }
  const layer = manifest.layers.find(
    (item) =>
      item.annotations?.["org.opencontainers.image.title"] ===
      opts.patchLayerName
  );
  return layer
    ? {
        ok: false,
        failure: {
          reason: "size-exceeded",
          layerSize: layer.size,
          budget: opts.sizeLimit,
        },
      }
    : {
        ok: false,
        failure: { reason: "missing-layer", layerName: opts.patchLayerName },
      };
}

export function resolveStableChain(
  currentVersion: string,
  targetVersion: string,
  signal?: AbortSignal,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<PatchChain | null> {
  return stableSource(source).resolveChain(
    currentVersion,
    targetVersion,
    signal
  );
}

export async function resolveNightlyChain(opts: {
  token: string;
  currentVersion: string;
  targetVersion: string;
  fullGzSize: number;
  preloadedTags?: string[];
  signal?: AbortSignal;
  source?: UpgradeSource;
}): Promise<PatchChain | null> {
  const { source = getPrimaryUpgradeSource() } = opts;
  const client = new OciClient({
    registry: "https://ghcr.io",
    repo: source.ghcrRepo,
    userAgent: `sentry-cli/${CLI_VERSION}`,
    fetch: customFetch,
  });
  const tags =
    opts.preloadedTags ??
    (await client.listTags(opts.token, PATCH_TAG_PREFIX, opts.signal));
  const chainTags = filterAndSortChainTags(
    tags,
    opts.currentVersion,
    opts.targetVersion
  );
  if (chainTags.length === 0 || chainTags.length > MAX_NIGHTLY_CHAIN_DEPTH) {
    return null;
  }

  let manifests: OciManifest[];
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    manifests = await Promise.all(
      chainTags.map((tag) => client.fetchManifest(opts.token, tag, opts.signal))
    );
  } catch {
    return null;
  }
  const binaryName = getPlatformBinaryName();
  const patchLayerName = `${binaryName}.patch`;
  const digests: string[] = [];
  const steps: { fromVersion: string; toVersion: string }[] = [];
  let previousVersion = opts.currentVersion;
  let totalSize = 0;
  let expectedSha256 = "";

  for (const [index, manifest] of manifests.entries()) {
    const tag = chainTags[index];
    if (!(manifest && tag)) {
      return null;
    }
    // Use the local validateChainStep (not binpatch's) so the rich 3-reason
    // telemetry classification (version-mismatch | missing-layer |
    // size-exceeded) survives the binpatch adoption. binpatch's returns a
    // coarser {ok:false, reason: "malformed" | "over_budget"}.
    const result = validateChainStep(manifest, {
      expectedFrom: previousVersion,
      patchLayerName,
      sizeLimit: opts.fullGzSize * SIZE_THRESHOLD_RATIO - totalSize,
    });
    if (!result.ok) {
      Sentry.getActiveSpan()?.setAttribute(
        "telemetry_reason",
        result.failure.reason
      );
      return null;
    }
    const toVersion = tag.slice(PATCH_TAG_PREFIX.length);
    digests.push(result.digest);
    totalSize += result.size;
    steps.push({ fromVersion: previousVersion, toVersion });
    previousVersion = toVersion;
    if (index === manifests.length - 1) {
      expectedSha256 = getPatchTargetSha256(manifest, binaryName) ?? "";
    }
  }
  if (previousVersion !== opts.targetVersion || !expectedSha256) {
    Sentry.getActiveSpan()?.setAttribute(
      "telemetry_reason",
      "version-mismatch"
    );
    return null;
  }

  const patches = await Promise.all(
    digests.map(async (digest) => {
      const data = new Uint8Array(
        await client.downloadBlobBuffer(opts.token, digest, opts.signal)
      );
      return { data, size: data.byteLength };
    })
  );
  return {
    patches,
    totalSize: patches.reduce((sum, patch) => sum + patch.size, 0),
    expectedSha256,
    steps,
  };
}

export function applyPatchChain(
  chain: PatchChain,
  oldBinaryPath: string,
  destPath: string,
  onBytes?: (bytes: number) => void
): Promise<string> {
  return withTracingSpan(
    "apply-patches",
    "upgrade.delta.apply",
    async (span) => {
      span.setAttribute("patches.count", chain.patches.length);
      span.setAttribute("patches.total_bytes", chain.totalSize);
      const sha256 = await applyPatchChainInMemory(
        oldBinaryPath,
        chain.patches.map((patch) => patch.data),
        destPath,
        onBytes
      );
      if (sha256 !== chain.expectedSha256) {
        throw new Error(
          `SHA-256 mismatch after patching: got ${sha256}, expected ${chain.expectedSha256}`
        );
      }
      return sha256;
    }
  );
}

function makeProgressHandler(setMessage?: SetMessage): ProgressHandler {
  let progress: ReturnType<typeof makeByteProgress> | undefined;
  let phase: string | undefined;
  let previousWritten = 0;
  return (event) => {
    if (
      event.type === "bytes" &&
      (progress === undefined || phase !== event.phase)
    ) {
      // New phase: spin up a fresh bar. The apply phase totals bytes across
      // every hop's `newSize`, which for multi-hop chains far exceeds the
      // final binary (e.g. 930 MB shown for a 310 MB install). Switch to
      // percent-only rendering so users see a sane progress fraction rather
      // than a scary inflated byte count. Pre-apply ("download"/"read")
      // phases still show bytes since their totals are honest sizes.
      phase = event.phase;
      previousWritten = 0;
      const isApply = event.phase === "apply";
      progress = makeByteProgress(
        `${isApply ? "Applying" : "Processing"} patch(es)`,
        event.total,
        setMessage,
        { format: isApply ? "pct" : "bytes" }
      );
    }
    if (event.type === "bytes" && progress) {
      progress.onProgress(event.written - previousWritten);
      previousWritten = event.written;
    } else if (event.type === "done") {
      progress?.done();
    }
  };
}

function telemetry(): DeltaTelemetry & { _source: { current?: string } } {
  // Expose `current` so attemptDeltaUpgrade's catch path can stamp
  // `delta.source` on the active span even when apply fails AFTER a chain
  // was successfully resolved (the catch previously left the span without
  // this attribute, silently downgrading telemetry fidelity).
  const captured: { current?: string } = {};
  return {
    _source: captured,
    onResolved: ({ source, chain }) => {
      captured.current = source;
      const span = Sentry.getActiveSpan();
      span?.setAttribute("delta.source", source);
      log.debug(
        `Resolved patch chain from ${source}: ${chain.patches.length} patch(es), ${formatBytes(chain.totalSize)} total`
      );
    },
    onOfflineMiss: () => {
      captured.current = "offline_miss";
      Sentry.getActiveSpan()?.setAttribute("delta.source", "offline_miss");
    },
    onUnavailable: (reason: DeltaUnavailableReason) => {
      Sentry.getActiveSpan()?.setAttribute("telemetry_reason", reason);
    },
  };
}

// biome-ignore lint/nursery/useMaxParams: internal adapter mirrors the preserved public call shape
function resolveDelta(
  source: SourceStrategy,
  targetVersion: string,
  oldBinaryPath: string,
  destPath: string,
  offline?: boolean,
  setMessage?: SetMessage
): Promise<{ result: DeltaResult | null; source: string | undefined }> {
  const tel = telemetry();
  return resolveAndApply({
    source,
    currentVersion: CLI_VERSION,
    targetVersion,
    oldPath: oldBinaryPath,
    destPath,
    cache: getPatchCache(),
    offline,
    onProgress: makeProgressHandler(setMessage),
    telemetry: tel,
  }).then((result) => ({ result, source: tel._source.current }));
}

// biome-ignore lint/nursery/useMaxParams: preserve the existing public API
export function resolveStableDelta(
  targetVersion: string,
  oldBinaryPath: string,
  destPath: string,
  offline?: boolean,
  setMessage?: SetMessage,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<DeltaResult | null> {
  return resolveDelta(
    stableSource(source),
    targetVersion,
    oldBinaryPath,
    destPath,
    offline,
    setMessage
  ).then(({ result }) => result);
}

// biome-ignore lint/nursery/useMaxParams: preserve the existing public API
export function resolveNightlyDelta(
  targetVersion: string,
  oldBinaryPath: string,
  destPath: string,
  offline?: boolean,
  setMessage?: SetMessage,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<DeltaResult | null> {
  return resolveDelta(
    nightlySource(source),
    targetVersion,
    oldBinaryPath,
    destPath,
    offline,
    setMessage
  ).then(({ result }) => result);
}

// biome-ignore lint/nursery/useMaxParams: preserve the existing public API
export function attemptDeltaUpgrade(
  targetVersion: string,
  oldBinaryPath: string,
  destPath: string,
  offline?: boolean,
  setMessage?: SetMessage,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<DeltaResult | null> {
  if (!canAttemptDelta(targetVersion)) {
    return Promise.resolve(null);
  }
  const channel = isNightlyVersion(targetVersion) ? "nightly" : "stable";
  return withTracingSpan(
    "upgrade.delta",
    "upgrade.delta",
    async (span) => {
      span.setAttribute("delta.from_version", CLI_VERSION);
      span.setAttribute("delta.to_version", targetVersion);
      let chainSource: string | undefined;
      try {
        const resolved = await resolveDelta(
          channel === "nightly" ? nightlySource(source) : stableSource(source),
          targetVersion,
          oldBinaryPath,
          destPath,
          offline,
          setMessage
        );
        chainSource = resolved.source;
        const result = resolved.result;
        if (result) {
          span.setAttribute("delta.patch_bytes", result.patchBytes);
          span.setAttribute("delta.chain_length", result.chainLength);
          Sentry.metrics.distribution(
            "upgrade.delta.patch_bytes",
            result.patchBytes,
            { attributes: { channel } }
          );
          Sentry.metrics.distribution(
            "upgrade.delta.chain_length",
            result.chainLength,
            { attributes: { channel } }
          );
        } else {
          span.setAttribute("delta.result", "unavailable");
        }
        span.setStatus({ code: 1 });
        return result;
      } catch (error) {
        Sentry.captureException(error, {
          level: "warning",
          tags: {
            "delta.from_version": CLI_VERSION,
            "delta.to_version": targetVersion,
            "delta.channel": channel,
          },
        });
        // If the chain was resolved but apply threw, the source was captured
        // by telemetry().onResolved — stamp it on the span so error spans
        // don't silently lose the network/cache/offline_miss attribution.
        const errorSpan = Sentry.getActiveSpan();
        if (chainSource !== undefined && errorSpan) {
          errorSpan.setAttribute("delta.source", chainSource);
        }
        const message = error instanceof Error ? error.message : String(error);
        log.warn(
          `Delta upgrade failed (${message}), falling back to full download`
        );
        span.setStatus({ code: 2 });
        span.setAttribute("delta.result", "error");
        span.setAttribute("delta.error", message);
        return null;
      }
    },
    { "delta.channel": channel }
  );
}

async function prefetch(
  source: SourceStrategy,
  targetVersion: string,
  signal?: AbortSignal
): Promise<void> {
  if (!canAttemptDelta(targetVersion) || signal?.aborted) {
    return;
  }
  const chain = await source.resolveChain(CLI_VERSION, targetVersion, signal);
  if (!chain?.steps || signal?.aborted) {
    return;
  }
  await getPatchCache().save(chain, chain.steps);
}

export function prefetchNightlyPatches(
  targetVersion: string,
  signal?: AbortSignal,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<void> {
  return prefetch(nightlySource(source), targetVersion, signal);
}

export function prefetchStablePatches(
  targetVersion: string,
  signal?: AbortSignal,
  source: UpgradeSource = getPrimaryUpgradeSource()
): Promise<void> {
  return prefetch(stableSource(source), targetVersion, signal);
}
