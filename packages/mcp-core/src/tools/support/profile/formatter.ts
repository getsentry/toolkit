/**
 * Formatting functions for profile analysis output.
 *
 * This module provides markdown formatting for profiling tool responses:
 * - Single transaction analysis (get_transaction_profile)
 * - Performance comparison (compare_transaction_profiles)
 * - Raw profile chunk analysis (get_profile_details)
 */

import type {
  Flamegraph,
  ProfileChunk,
  TransactionProfile,
} from "../../../api-client/types";
import {
  type FrameComparison,
  type HotPath,
  analyzeHotPathsFromFlamegraph,
  compareFrameStats,
  formatDuration,
  formatPercentage,
  generatePerformanceInsights,
  identifyHotspotFramesFromFlamegraph,
} from "./analyzer";

/**
 * Maps a change type to its corresponding status icon.
 */
const CHANGE_TYPE_ICONS: Record<FrameComparison["changeType"], string> = {
  major_regression: "🚨",
  minor_regression: "⚠️",
  improvement: "✅",
  no_change: "➖",
};

/**
 * Determines the overall comparison status based on regression/improvement counts.
 */
function determineComparisonStatus(
  majorCount: number,
  minorCount: number,
  improvementCount: number,
): string {
  if (majorCount > 0) return "⚠️ Performance Regression Detected";
  if (minorCount > 0) return "⚠️ Minor Performance Changes Detected";
  if (improvementCount > 0) return "✅ Performance Improvements Detected";
  return "✅ No Significant Changes";
}

/**
 * Truncates a file location string for table display.
 */
function truncateLocation(location: string, maxLength = 30): string {
  if (location.length <= maxLength) return location;
  return `...${location.slice(-(maxLength - 3))}`;
}

/**
 * Options for flamegraph analysis formatting.
 */
export interface FlamegraphAnalysisOptions {
  focusOnUserCode: boolean;
  maxHotPaths: number;
}

/**
 * Options for flamegraph comparison formatting.
 */
export interface FlamegraphComparisonOptions {
  focusOnUserCode: boolean;
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
 * Formats flamegraph analysis for a single transaction.
 *
 * Produces markdown output with:
 * - Transaction information
 * - Performance summary (user code vs library)
 * - Top slow functions table
 * - Hot paths with recommendations
 * - Actionable next steps
 *
 * @param flamegraph Flamegraph data from API
 * @param options Formatting options
 * @returns Markdown-formatted analysis
 */
export function formatFlamegraphAnalysis(
  flamegraph: Flamegraph,
  options: FlamegraphAnalysisOptions,
): string {
  const sections: string[] = [];

  // Transaction information
  sections.push(formatTransactionInfo(flamegraph));

  // Performance summary
  sections.push(formatPerformanceSummary(flamegraph, options));

  // Hot paths
  const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, options);
  sections.push(formatHotPaths(hotPaths, flamegraph, options));

  // Actionable next steps
  sections.push(formatActionableSteps(hotPaths, options));

  return sections.join("\n\n");
}

function getFlamegraphProfileCount(flamegraph: Flamegraph): number {
  return flamegraph.shared.profiles.length || flamegraph.profiles.length;
}

/**
 * Formats transaction information section.
 */
function formatTransactionInfo(flamegraph: Flamegraph): string {
  const profile = flamegraph.profiles[0];
  const profileCount = getFlamegraphProfileCount(flamegraph);
  const totalSamples = profile?.sample_counts.reduce((a, b) => a + b, 0) || 0;
  const totalDuration =
    profile?.sample_durations_ns.reduce((a, b) => a + b, 0) || 0;

  return [
    `# Profile Analysis: ${flamegraph.transactionName || "Unknown Transaction"}`,
    "",
    "## Transaction Information",
    `- **Transaction**: ${flamegraph.transactionName || "Unknown"}`,
    `- **Project ID**: ${flamegraph.projectID}`,
    `- **Platform**: ${flamegraph.platform || "Unknown"}`,
    `- **Total Profiles**: ${profileCount}`,
    `- **Total Samples**: ${totalSamples.toLocaleString()}`,
    `- **Estimated Total Time**: ${formatDuration(totalDuration)}`,
  ].join("\n");
}

/**
 * Formats performance summary section.
 */
function formatPerformanceSummary(
  flamegraph: Flamegraph,
  options: FlamegraphAnalysisOptions,
): string {
  const hotspots = identifyHotspotFramesFromFlamegraph(flamegraph, {
    focusOnUserCode: false, // Get both user and library for breakdown
  });

  // Calculate time breakdown in a single pass
  let userCodeTime = 0;
  let libraryTime = 0;
  for (const h of hotspots) {
    if (h.frame.is_application) {
      userCodeTime += h.frameInfo.sumDuration;
    } else {
      libraryTime += h.frameInfo.sumDuration;
    }
  }

  const totalTime = userCodeTime + libraryTime;
  const userPercent = totalTime > 0 ? (userCodeTime / totalTime) * 100 : 0;
  const libraryPercent = totalTime > 0 ? (libraryTime / totalTime) * 100 : 0;

  const sections = [
    "## Performance Summary",
    "",
    "### Code Breakdown",
    `- **Total User Code Time**: ${formatDuration(userCodeTime)} (${formatPercentage(userPercent)})`,
    `- **Total Library Time**: ${formatDuration(libraryTime)} (${formatPercentage(libraryPercent)})`,
  ];

  // Top slow functions table
  const topFunctions = identifyHotspotFramesFromFlamegraph(
    flamegraph,
    options,
  ).slice(0, 10);

  if (topFunctions.length > 0) {
    sections.push("", "### Top Slow Functions");
    sections.push("");
    sections.push(
      "| Function | File:Line | Samples | % Time | p75 | p95 | p99 | Insights |",
    );
    sections.push(
      "|----------|-----------|---------|--------|-----|-----|-----|----------|",
    );

    for (const func of topFunctions) {
      const insights = generatePerformanceInsights(func.frameInfo);
      const insightText = insights.map((i) => i.icon).join(" ");
      const location = truncateLocation(
        `${func.frame.file}:${func.frame.line}`,
      );

      sections.push(
        `| \`${func.frame.name}\` | ${location} | ${func.frameInfo.count.toLocaleString()} | ${formatPercentage(func.percentOfTotal)} | ${formatDuration(func.frameInfo.p75Duration)} | ${formatDuration(func.frameInfo.p95Duration)} | ${formatDuration(func.frameInfo.p99Duration)} | ${insightText} |`,
      );
    }
  }

  return sections.join("\n");
}

/**
 * Formats hot paths section.
 */
function formatHotPaths(
  hotPaths: HotPath[],
  flamegraph: Flamegraph,
  options: FlamegraphAnalysisOptions,
): string {
  if (hotPaths.length === 0) {
    return "## Hot Paths\n\nNo significant hot paths found.";
  }

  const sections = ["## Top Hot Paths", ""];
  const profileCount = getFlamegraphProfileCount(flamegraph);

  hotPaths.forEach((path, idx) => {
    if (idx > 0) sections.push("---", "");

    sections.push(
      `### Path #${idx + 1}: ${formatPercentage(path.percentOfTotal)} of execution time`,
    );
    sections.push("");
    sections.push(
      `**${path.sampleCount.toLocaleString()} samples** across ${profileCount} profiles`,
    );
    sections.push("");

    // Display call stack - filter to user code during formatting if requested
    // Call stack is stored leaf-to-root, so we reverse for display (root-to-leaf)
    const framesToShow = options.focusOnUserCode
      ? path.userCodeFrames
      : path.callStack;

    if (framesToShow.length > 0) {
      sections.push("```");
      // Display root-to-leaf (reverse the stored order for readability)
      const displayFrames = [...framesToShow].reverse();
      displayFrames.forEach((frame, i) => {
        const indent = "  ".repeat(i);
        const marker = frame.frame.is_application ? "[YOUR CODE]" : "[library]";
        // The last displayed frame (original leaf) is the primary bottleneck
        const isLeaf = i === displayFrames.length - 1;
        const suffix =
          isLeaf && options.focusOnUserCode ? " ← PRIMARY BOTTLENECK" : "";
        sections.push(
          `${indent}${frame.frame.file}:${frame.frame.name}:${frame.frame.line} ${marker}${suffix}`,
        );
      });
      sections.push("```");
      sections.push("");
    }

    // Performance characteristics - leaf frame is at index 0 (leaf-to-root order)
    const leafFrame = path.callStack[0];
    if (leafFrame) {
      const insights = generatePerformanceInsights(leafFrame.frameInfo);
      sections.push("**Performance Characteristics:**");
      sections.push(
        `- **p75**: ${formatDuration(leafFrame.frameInfo.p75Duration)}`,
      );
      sections.push(
        `- **p95**: ${formatDuration(leafFrame.frameInfo.p95Duration)}`,
      );
      sections.push(
        `- **p99**: ${formatDuration(leafFrame.frameInfo.p99Duration)}${insights.some((i) => i.type === "high_variance") ? " (⚠️ High variance - some calls are very slow)" : ""}`,
      );
      sections.push("");

      // Recommendations
      sections.push("**💡 Recommendation:**");
      sections.push(
        `This path accounts for ${formatPercentage(path.percentOfTotal)} of CPU time.${insights.some((i) => i.type === "high_variance") ? " The high p99 indicates some operations are very slow." : ""}`,
      );
      sections.push("");
    }
  });

  return sections.join("\n");
}

/**
 * Formats actionable next steps section.
 */
function formatActionableSteps(
  hotPaths: HotPath[],
  options: FlamegraphAnalysisOptions,
): string {
  const sections = [
    "## Actionable Next Steps",
    "",
    "### Immediate Actions (High Impact)",
  ];

  // Suggest optimization for top path
  const topPath = hotPaths[0];
  if (topPath) {
    // When focusOnUserCode is true, recommend the deepest user code frame (closest to bottleneck)
    // callStack is in leaf-to-root order, so userCodeFrames[0] is the deepest user code frame
    const frameToRecommend = options.focusOnUserCode
      ? topPath.userCodeFrames[0]
      : topPath.callStack[0];
    if (frameToRecommend) {
      sections.push(
        `1. **Optimize \`${frameToRecommend.frame.name}\` function** - Accounts for ${formatPercentage(topPath.percentOfTotal)} of CPU time`,
      );
    }
  }

  sections.push(
    "2. **Add caching layer** - Consider caching frequently accessed data",
    "3. **Review query patterns** - Look for N+1 queries or inefficient data access",
    "",
    "### Investigation Actions",
    "1. **Compare with baseline**: Use get_profile with compareAgainstPeriod to check for regressions",
  );

  return sections.join("\n");
}

/**
 * Formats flamegraph comparison for regression detection.
 *
 * Produces markdown output with:
 * - Comparison summary
 * - Key changes table
 * - Regressions detected
 * - Suggested investigation steps
 *
 * @param baseline Baseline flamegraph data
 * @param current Current flamegraph data
 * @param options Formatting options
 * @returns Markdown-formatted comparison
 */
export function formatFlamegraphComparison(
  baseline: Flamegraph,
  current: Flamegraph,
  options: FlamegraphComparisonOptions,
): string {
  const sections: string[] = [];

  // Comparison summary
  sections.push(
    `# Profile Comparison: ${current.transactionName || "Unknown Transaction"}`,
  );
  sections.push("");
  sections.push("## Summary");

  const comparisons = compareFrameStats(baseline, current, options);
  const majorRegressions = comparisons.filter(
    (c) => c.changeType === "major_regression",
  );
  const minorRegressions = comparisons.filter(
    (c) => c.changeType === "minor_regression",
  );
  const improvements = comparisons.filter(
    (c) => c.changeType === "improvement",
  );

  const status = determineComparisonStatus(
    majorRegressions.length,
    minorRegressions.length,
    improvements.length,
  );

  sections.push(`- **Status**: ${status}`);
  sections.push("");

  // Key changes
  if (comparisons.length > 0) {
    sections.push("## Key Changes");
    sections.push("");
    sections.push(
      "| Function | File:Line | Baseline | Current | Change | Status |",
    );
    sections.push(
      "|----------|-----------|----------|---------|--------|--------|",
    );

    // Show top 10 changes
    for (const comp of comparisons.slice(0, 10)) {
      const location = truncateLocation(
        `${comp.frame.file}:${comp.frame.line}`,
      );
      const statusIcon = CHANGE_TYPE_ICONS[comp.changeType];
      const change =
        comp.percentChange > 0
          ? `+${formatPercentage(comp.percentChange)}`
          : formatPercentage(comp.percentChange);

      sections.push(
        `| \`${comp.frame.name}\` | ${location} | ${formatDuration(comp.baseline.sumDuration)} | ${formatDuration(comp.current.sumDuration)} | ${change} | ${statusIcon} |`,
      );
    }
    sections.push("");
  }

  // Regressions detected
  if (majorRegressions.length > 0) {
    sections.push("## Major Regressions Detected");
    sections.push("");

    for (const reg of majorRegressions.slice(0, 5)) {
      sections.push(`### 🚨 \`${reg.frame.name}\``);
      sections.push(
        `- **Change**: +${formatPercentage(reg.percentChange)} slower`,
      );
      sections.push(
        `- **Impact**: ${formatDuration(reg.baseline.sumDuration)} → ${formatDuration(reg.current.sumDuration)}`,
      );
      sections.push(`- **Location**: ${reg.frame.file}:${reg.frame.line}`);
      sections.push("");
      sections.push(
        "**Suggested Action**: Investigate recent changes to this function",
      );
      sections.push("");
    }
  }

  return sections.join("\n");
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

  const sortedFrames = Array.from(frameCounts.entries())
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
