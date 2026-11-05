/**
 * Formatting functions for profile analysis output.
 *
 * This module provides markdown formatting for get_profile_details responses
 * (transaction, legacy, and continuous profiles).
 */

import type {
  LegacySpeedscopeProfile,
  ProfileChunk,
  TransactionProfile,
} from "../../../api-client/types";
import { formatDuration } from "./analyzer";

/**
 * Truncates a file location string for table display.
 */
function truncateLocation(location: string, maxLength = 30): string {
  if (location.length <= maxLength) return location;
  return `...${location.slice(-(maxLength - 3))}`;
}

/**
 * Options for profile chunk formatting.
 */
export interface ProfileChunkAnalysisOptions {
  focusOnUserCode: boolean;
}

export interface TransactionProfileAnalysisOptions {
  focusOnUserCode: boolean;
  profileUrl: string;
  projectSlug: string;
  traceUrl?: string;
}

/**
 * Shape consumed by the sample-based formatters. Using a narrow structural
 * type lets us accept both V2 continuous profile chunk samples and V1
 * transaction profile samples without forcing one side's timing fields onto
 * the other — the formatters here only care about `stack_id` and `thread_id`.
 */
interface ProfileSampleData {
  frames: ProfileChunk["profile"]["frames"];
  samples: Array<{ stack_id: number; thread_id: string }>;
  stacks: ProfileChunk["profile"]["stacks"];
  threadMetadata: ProfileChunk["profile"]["thread_metadata"];
}

/**
 * Formats raw profile chunk analysis.
 *
 * Produces markdown output with:
 * - Chunk metadata
 * - Sample summary
 * - Frame breakdown
 * - Thread information
 *
 * @param chunk Profile chunk data from API
 * @param options Formatting options
 * @returns Markdown-formatted analysis
 */
export function formatProfileChunkAnalysis(
  chunk: ProfileChunk,
  options: ProfileChunkAnalysisOptions,
): string {
  const sections: string[] = [];

  sections.push("# Profile Chunk Details");
  sections.push("");
  sections.push("## Metadata");
  sections.push(`- **Chunk ID**: ${chunk.chunk_id}`);
  sections.push(`- **Profiler ID**: ${chunk.profiler_id}`);
  sections.push(`- **Platform**: ${chunk.platform}`);
  sections.push(`- **Release**: ${chunk.release}`);
  if (chunk.environment) {
    sections.push(`- **Environment**: ${chunk.environment}`);
  }
  sections.push("");

  sections.push(
    ...formatProfileSampleSections(
      {
        frames: chunk.profile.frames,
        samples: chunk.profile.samples,
        stacks: chunk.profile.stacks,
        threadMetadata: chunk.profile.thread_metadata,
      },
      options,
    ),
  );

  return sections.join("\n");
}

/**
 * Formats a legacy transaction profile returned in speedscope format.
 *
 * Legacy profiles (e.g. Android) do not expose sample-format data through the
 * profile details API, so only summary metadata can be reported here.
 */
export function formatLegacyProfileSummary(
  profile: LegacySpeedscopeProfile,
  options: Omit<TransactionProfileAnalysisOptions, "focusOnUserCode">,
): string {
  const metadata: NonNullable<LegacySpeedscopeProfile["metadata"]> =
    profile.metadata ?? {};
  const profileId = profile.profileID ?? "Unknown";
  const transactionName =
    profile.transactionName ?? metadata.transactionName ?? "Unknown";
  const device = [metadata.deviceManufacturer, metadata.deviceModel]
    .filter(Boolean)
    .join(" ");
  const os = [metadata.deviceOSName, metadata.deviceOSVersion]
    .filter(Boolean)
    .join(" ");

  const sections: string[] = [
    `# Profile ${profileId}`,
    "",
    "## Summary",
    `- **Profile URL**: ${options.profileUrl}`,
    `- **Project**: ${options.projectSlug}`,
    `- **Profile ID**: ${profileId}`,
    `- **Transaction**: ${transactionName}`,
  ];
  if (metadata.traceID) {
    sections.push(`- **Trace ID**: ${metadata.traceID}`);
  }
  if (options.traceUrl) {
    sections.push(`- **Trace URL**: ${options.traceUrl}`);
  }
  if (profile.durationNS != null && Number.isFinite(profile.durationNS)) {
    sections.push(`- **Duration**: ${formatDuration(profile.durationNS)}`);
  }
  sections.push(`- **Platform**: ${profile.platform}`);
  sections.push("- **Format**: legacy (speedscope)");
  if (metadata.environment) {
    sections.push(`- **Environment**: ${metadata.environment}`);
  }
  if (device) {
    sections.push(`- **Device**: ${device}`);
  }
  if (os) {
    sections.push(`- **OS**: ${os}`);
  }
  sections.push("");
  sections.push("## Sample Analysis Unavailable");
  sections.push(
    "This is a legacy transaction profile (for example from an Android or React Native app). Sentry returns it in speedscope format, which does not include the sample-level frames, stacks, and samples this tool analyzes.",
  );
  sections.push(
    "Open the Profile URL above to inspect the flamegraph in Sentry, or use `get_profile` to analyze aggregated flamegraph data for this transaction.",
  );

  return sections.join("\n");
}

export function formatTransactionProfileAnalysis(
  profile: TransactionProfile,
  options: TransactionProfileAnalysisOptions,
): string {
  const sections: string[] = [];
  const profileId = profile.profile_id ?? profile.event_id ?? "Unknown";
  const transactionName = profile.transaction?.name ?? "Unknown";
  const release = formatProfileRelease(profile.release);
  const durationNs = getTransactionProfileDurationNs(profile);
  const device = formatDeviceSummary(profile);
  const os = formatOsSummary(profile);
  const sdk = formatSdkSummary(profile);

  sections.push(`# Profile ${profileId}`);
  sections.push("");
  sections.push("## Summary");
  sections.push(`- **Profile URL**: ${options.profileUrl}`);
  sections.push(`- **Project**: ${options.projectSlug}`);
  sections.push(`- **Profile ID**: ${profileId}`);
  sections.push(`- **Transaction**: ${transactionName}`);
  if (profile.transaction?.trace_id) {
    sections.push(`- **Trace ID**: ${profile.transaction.trace_id}`);
  }
  if (options.traceUrl) {
    sections.push(`- **Trace URL**: ${options.traceUrl}`);
  }
  if (durationNs != null) {
    sections.push(`- **Duration**: ${formatDuration(durationNs)}`);
  }
  sections.push(`- **Platform**: ${profile.platform}`);
  sections.push(`- **Release**: ${release}`);
  if (profile.environment) {
    sections.push(`- **Environment**: ${profile.environment}`);
  }
  if (device) {
    sections.push(`- **Device**: ${device}`);
  }
  if (os) {
    sections.push(`- **OS**: ${os}`);
  }
  if (sdk) {
    sections.push(`- **SDK**: ${sdk}`);
  }
  if (profile.transaction?.active_thread_id) {
    sections.push(
      `- **Active Thread**: ${profile.transaction.active_thread_id}`,
    );
  }
  sections.push("");

  sections.push(
    ...formatProfileSampleSections(
      {
        frames: profile.profile.frames,
        samples: profile.profile.samples,
        stacks: profile.profile.stacks,
        threadMetadata: profile.profile.thread_metadata,
      },
      options,
    ),
  );

  sections.push("");
  sections.push("## Next Steps");
  sections.push("");
  sections.push(
    "- Open the profile URL above in Sentry for the full flamegraph",
  );
  if (options.traceUrl) {
    sections.push(
      "- Open the related trace URL to inspect the end-to-end request",
    );
  }
  sections.push("- Use `search_profiles` to find similar profiles");

  return sections.join("\n");
}

function formatProfileSampleSections(
  profile: ProfileSampleData,
  options: { focusOnUserCode: boolean },
): string[] {
  const sections: string[] = [];

  sections.push("## Sample Summary");
  sections.push(`- **Total Frames**: ${profile.frames.length}`);
  sections.push(`- **Total Samples**: ${profile.samples.length}`);
  sections.push(`- **Total Stacks**: ${profile.stacks.length}`);
  sections.push(`- **Threads**: ${Object.keys(profile.threadMetadata).length}`);
  sections.push("");
  sections.push("## Thread Information");
  sections.push("");

  for (const [threadId, metadata] of Object.entries(profile.threadMetadata)) {
    const threadSamples = profile.samples.filter(
      (s) => s.thread_id === threadId,
    );
    sections.push(
      `- **Thread ${threadId}**: ${metadata.name || "unnamed"} (${threadSamples.length} samples)`,
    );
  }
  sections.push("");

  const frameSection = formatTopFramesByOccurrence(profile, options);
  if (frameSection) {
    sections.push(frameSection);
  }

  return sections;
}

function formatTopFramesByOccurrence(
  profile: ProfileSampleData,
  options: { focusOnUserCode: boolean },
): string | null {
  const frameCounts = new Map<number, number>();

  for (const sample of profile.samples) {
    const stack = profile.stacks[sample.stack_id];
    if (!stack) {
      continue;
    }

    for (const frameIdx of stack) {
      frameCounts.set(frameIdx, (frameCounts.get(frameIdx) || 0) + 1);
    }
  }

  const sortedFrames = [...frameCounts.entries()]
    .filter(([frameIdx]) => {
      const frame = profile.frames[frameIdx];
      return frame !== undefined && (!options.focusOnUserCode || frame.in_app);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sortedFrames.length === 0) {
    return null;
  }

  const rows = sortedFrames.map(([frameIdx, count]) => {
    const frame = profile.frames[frameIdx]!;
    const functionName = frame.function ?? frame.raw_function ?? "unknown";
    const funcName = frame.class_name
      ? `${frame.class_name}.${functionName}`
      : functionName;

    const rawLocation =
      frame.filename && frame.lineno
        ? `${frame.filename}:${frame.lineno}`
        : frame.module || frame.abs_path || "unknown";
    const location = truncateLocation(rawLocation, 40);
    const type = frame.in_app ? "User Code" : "Library";

    return `| \`${funcName}\` | ${location} | ${count} | ${type} |`;
  });

  return [
    "## Top Frames by Occurrence",
    "",
    "| Function | File:Line | Count | Type |",
    "|----------|-----------|-------|------|",
    ...rows,
  ].join("\n");
}

function formatProfileRelease(release: TransactionProfile["release"]): string {
  if (typeof release === "string") {
    return release;
  }
  if (release && typeof release === "object" && "version" in release) {
    return String(release.version);
  }
  return "Unknown";
}

function getTransactionProfileDurationNs(
  profile: TransactionProfile,
): number | null {
  const relativeStart = profile.transaction?.relative_start_ns;
  const relativeEnd = profile.transaction?.relative_end_ns;
  if (
    typeof relativeStart === "number" &&
    Number.isFinite(relativeStart) &&
    typeof relativeEnd === "number" &&
    Number.isFinite(relativeEnd) &&
    relativeEnd >= relativeStart
  ) {
    return relativeEnd - relativeStart;
  }

  // V1 transaction profile samples always carry elapsed_since_start_ns in
  // nanoseconds — there's no timestamp field on the wire — so we can derive
  // duration from them directly without scale inference.
  const elapsed = profile.profile.samples
    .map((sample) => sample.elapsed_since_start_ns)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (elapsed.length < 2) {
    return null;
  }

  const duration = elapsed[elapsed.length - 1]! - elapsed[0]!;
  return duration > 0 ? Math.round(duration) : null;
}

function formatDeviceSummary(profile: TransactionProfile): string | null {
  const parts = [
    profile.device?.model,
    profile.device?.classification,
    profile.device?.arch,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatOsSummary(profile: TransactionProfile): string | null {
  const parts = [
    profile.os?.name,
    profile.os?.version,
    profile.os?.build_number,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function formatSdkSummary(profile: TransactionProfile): string | null {
  const parts = [profile.client_sdk?.name, profile.client_sdk?.version].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}
