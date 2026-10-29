/**
 * Profile analysis functions for extracting insights from flamegraph data.
 *
 * This module provides shared analysis logic for profiling tools:
 * - Hot path extraction (most CPU-intensive call stacks)
 * - Hotspot identification (functions consuming most time)
 * - Performance insights (based on percentile analysis)
 * - Regression comparison (baseline vs current)
 */

import type {
  Flamegraph,
  FlamegraphFrame,
  FlamegraphFrameInfo,
} from "../../../api-client/types";

/**
 * Represents a single frame within a call stack with its metadata.
 */
export interface CallStackFrame {
  frame: FlamegraphFrame;
  frameInfo: FlamegraphFrameInfo;
  depth: number;
  isRoot: boolean;
  isLeaf: boolean;
  frameIndex: number;
}

/**
 * Represents a hot path (call stack consuming significant CPU time).
 */
export interface HotPath {
  stackIndices: number[];
  sampleCount: number;
  duration: number;
  weight: number;
  percentOfTotal: number;
  callStack: CallStackFrame[];
  userCodeFrames: CallStackFrame[];
}

/**
 * Represents a hotspot frame (function consuming significant CPU time).
 */
export interface HotspotFrame {
  frame: FlamegraphFrame;
  frameInfo: FlamegraphFrameInfo;
  percentOfTotal: number;
  frameIndex: number;
}

/**
 * Performance insights based on percentile analysis.
 */
export interface PerformanceInsight {
  type: "high_variance" | "consistently_slow" | "hot_function" | "consistent";
  icon: string;
  message: string;
}

/**
 * Frame comparison for regression detection.
 */
export interface FrameComparison {
  frame: FlamegraphFrame;
  baseline: FlamegraphFrameInfo;
  current: FlamegraphFrameInfo;
  percentChange: number;
  changeType:
    | "major_regression"
    | "minor_regression"
    | "improvement"
    | "no_change";
}

/**
 * Analyzes flamegraph data to extract hot paths (most CPU-intensive call stacks).
 *
 * Hot paths are merged when duplicate stacks appear, sorted by total duration
 * (most time spent), and limited to maxHotPaths. Each path includes the full
 * call stack with depth tracking.
 *
 * Note: Call stacks are stored leaf-to-root (main frame at end) for efficient
 * flamegraph/call tree merging. User code filtering is done during formatting.
 *
 * @param flamegraph Flamegraph data from API
 * @param options Analysis options
 * @returns Array of hot paths sorted by duration (descending)
 */
export function analyzeHotPathsFromFlamegraph(
  flamegraph: Flamegraph,
  options: { focusOnUserCode: boolean; maxHotPaths: number },
): HotPath[] {
  const profile = flamegraph.profiles[0]; // Main thread
  if (!profile) {
    return [];
  }

  const frames = flamegraph.shared.frames;
  const frameInfos = flamegraph.shared.frame_infos;

  // Calculate total samples for percentage calculation
  const totalSamples = profile.sample_counts.reduce((a, b) => a + b, 0);

  // Merge duplicate stacks: same stack can appear multiple times in samples
  // Key is the stack signature (sorted frame indices joined)
  const mergedStacks = new Map<
    string,
    {
      stackIndices: number[];
      sampleCount: number;
      duration: number;
      weight: number;
    }
  >();

  for (let idx = 0; idx < profile.samples.length; idx++) {
    const stackIndices = profile.samples[idx];
    const sampleCount = profile.sample_counts[idx] || 0;
    const duration = profile.sample_durations_ns[idx] || 0;
    const weight = profile.weights[idx] || 0;

    // Create a unique key for this stack (order matters for stack identity)
    const stackKey = stackIndices.join(",");

    const existing = mergedStacks.get(stackKey);
    if (existing) {
      existing.sampleCount += sampleCount;
      existing.duration += duration;
      existing.weight += weight;
    } else {
      mergedStacks.set(stackKey, {
        stackIndices,
        sampleCount,
        duration,
        weight,
      });
    }
  }

  // Convert merged stacks to hot paths
  const hotPaths = [...mergedStacks.values()].map((merged) => {
    // Reconstruct call stack - keep all frames, filter during formatting
    // Store leaf-to-root for efficient merging (reverse the API order)
    const callStack = reconstructCallStack(
      [...merged.stackIndices].reverse(),
      frames,
      frameInfos,
    );

    // User code frames computed but filtering done in formatter
    const userCodeFrames = callStack.filter((f) => f.frame.is_application);

    return {
      stackIndices: merged.stackIndices,
      sampleCount: merged.sampleCount,
      duration: merged.duration,
      weight: merged.weight,
      percentOfTotal:
        totalSamples > 0 ? (merged.sampleCount / totalSamples) * 100 : 0,
      callStack,
      userCodeFrames,
    };
  });

  // Sort by duration (most time spent) and return top N
  return hotPaths
    .sort((a, b) => b.duration - a.duration)
    .slice(0, options.maxHotPaths);
}

/** Default frame info for missing data */
const DEFAULT_FRAME_INFO: FlamegraphFrameInfo = {
  count: 0,
  weight: 0,
  sumDuration: 0,
  sumSelfTime: 0,
  p75Duration: 0,
  p95Duration: 0,
  p99Duration: 0,
};

/** Default frame for missing data */
const DEFAULT_FRAME: FlamegraphFrame = {
  file: "unknown",
  name: "unknown",
  line: 0,
  is_application: false,
  fingerprint: 0,
};

/**
 * Reconstructs a call stack from frame indices with depth tracking.
 *
 * Frames are ordered leaf-to-root (leaf at index 0, root at end) for efficient
 * flamegraph/call tree merging. This allows top-down traversal and early
 * termination when merging stacks.
 *
 * @param stackIndices Array of frame indices forming the call stack (leaf to root)
 * @param frames All frames from flamegraph
 * @param frameInfos Performance stats for each frame
 * @returns Reconstructed call stack with metadata (leaf first, root last)
 */
export function reconstructCallStack(
  stackIndices: number[],
  frames: FlamegraphFrame[],
  frameInfos: FlamegraphFrameInfo[],
): CallStackFrame[] {
  const stackLength = stackIndices.length;
  return stackIndices.map((frameIdx, idx) => ({
    frame: frames[frameIdx] || DEFAULT_FRAME,
    frameInfo: frameInfos[frameIdx] || DEFAULT_FRAME_INFO,
    depth: idx,
    isLeaf: idx === 0,
    isRoot: idx === stackLength - 1,
    frameIndex: frameIdx,
  }));
}

/**
 * Identifies hotspot frames (functions consuming the most CPU time).
 *
 * Hotspots are individual functions that appear frequently in profiles,
 * sorted by total weight (time spent in that function across all samples).
 *
 * @param flamegraph Flamegraph data from API
 * @param options Analysis options
 * @returns Array of hotspot frames sorted by weight (descending)
 */
export function identifyHotspotFramesFromFlamegraph(
  flamegraph: Flamegraph,
  options: { focusOnUserCode: boolean },
): HotspotFrame[] {
  const frames = flamegraph.shared.frames;
  const frameInfos = flamegraph.shared.frame_infos;

  // Calculate total samples from profile sample_counts (not frame_infos.count which overcounts due to overlapping stacks)
  const totalSamples = flamegraph.profiles.reduce(
    (sum, profile) => sum + profile.sample_counts.reduce((a, b) => a + b, 0),
    0,
  );

  // Map frames to hotspots with stats
  const hotspots = frames
    .map((frame, idx) => {
      const frameInfo = frameInfos[idx] || DEFAULT_FRAME_INFO;
      return {
        frame,
        frameInfo,
        percentOfTotal:
          totalSamples > 0 ? (frameInfo.count / totalSamples) * 100 : 0,
        frameIndex: idx,
      };
    })
    .filter((h) => !options.focusOnUserCode || h.frame.is_application)
    .sort((a, b) => b.frameInfo.weight - a.frameInfo.weight)
    .slice(0, 20); // Top 20 hotspots

  return hotspots;
}

/**
 * Generates performance insights based on percentile analysis.
 *
 * Analyzes p75, p95, and p99 latencies to identify:
 * - High variance (inconsistent performance)
 * - Consistently slow functions (high median)
 * - Hot functions (called very frequently)
 * - Consistent functions (low variance)
 *
 * @param frameInfo Performance statistics for a frame
 * @returns Array of insights
 */
export function generatePerformanceInsights(
  frameInfo: FlamegraphFrameInfo,
): PerformanceInsight[] {
  const insights: PerformanceInsight[] = [];

  // High variance (p99 >> p75) indicates inconsistent performance
  if (frameInfo.p99Duration > frameInfo.p75Duration * 3) {
    insights.push({
      type: "high_variance",
      icon: "⚠️",
      message: "High variance: Performance varies significantly across calls",
    });
  }

  // Consistently slow (p75 is high)
  if (frameInfo.p75Duration > 100_000_000) {
    // >100ms
    insights.push({
      type: "consistently_slow",
      icon: "🐌",
      message: "Consistently slow: Median execution time is high",
    });
  }

  // Hot function (many samples)
  if (frameInfo.count > 1000) {
    insights.push({
      type: "hot_function",
      icon: "🔥",
      message: "Hot function: Called very frequently",
    });
  }

  // Consistent performance (low variance)
  if (
    insights.length === 0 &&
    frameInfo.p99Duration <= frameInfo.p75Duration * 1.5
  ) {
    insights.push({
      type: "consistent",
      icon: "✅",
      message: "Consistent: Low performance variance",
    });
  }

  return insights;
}

/**
 * Compares frame statistics between baseline and current to detect regressions.
 *
 * Analyzes percentage change in weight (total CPU time) and classifies changes:
 * - Major regression: >20% slower
 * - Minor regression: 10-20% slower
 * - Improvement: Faster
 * - No change: <10% change
 *
 * @param baseline Baseline flamegraph data
 * @param current Current flamegraph data
 * @param options Comparison options
 * @returns Array of frame comparisons sorted by regression severity
 */
export function compareFrameStats(
  baseline: Flamegraph,
  current: Flamegraph,
  options: { focusOnUserCode: boolean },
): FrameComparison[] {
  const baselineFrames = baseline.shared.frames;
  const currentFrames = current.shared.frames;
  const baselineInfos = baseline.shared.frame_infos;
  const currentInfos = current.shared.frame_infos;

  // Build a map of frame fingerprint -> (baseline index, current index)
  const frameMap = new Map<
    number,
    { baselineIdx?: number; currentIdx?: number }
  >();

  baselineFrames.forEach((frame, idx) => {
    const existing = frameMap.get(frame.fingerprint) || {};
    frameMap.set(frame.fingerprint, { ...existing, baselineIdx: idx });
  });

  currentFrames.forEach((frame, idx) => {
    const existing = frameMap.get(frame.fingerprint) || {};
    frameMap.set(frame.fingerprint, { ...existing, currentIdx: idx });
  });

  // Compare frames that exist in both
  const comparisons: FrameComparison[] = [];

  for (const [fingerprint, indices] of frameMap.entries()) {
    if (indices.baselineIdx === undefined || indices.currentIdx === undefined) {
      continue; // Frame only in one dataset
    }

    const baselineFrame = baselineFrames[indices.baselineIdx];
    const currentFrame = currentFrames[indices.currentIdx];
    const baselineInfo =
      baselineInfos[indices.baselineIdx] || DEFAULT_FRAME_INFO;
    const currentInfo = currentInfos[indices.currentIdx] || DEFAULT_FRAME_INFO;

    // Skip if not user code and we're filtering
    if (options.focusOnUserCode && !currentFrame.is_application) {
      continue;
    }

    // Calculate percentage change in sumDuration (total CPU time in nanoseconds)
    // Note: weight is a relative value, sumDuration is the actual time
    const percentChange =
      baselineInfo.sumDuration > 0
        ? ((currentInfo.sumDuration - baselineInfo.sumDuration) /
            baselineInfo.sumDuration) *
          100
        : 0;

    // Classify change
    let changeType: FrameComparison["changeType"];
    if (percentChange > 20) {
      changeType = "major_regression";
    } else if (percentChange > 10) {
      changeType = "minor_regression";
    } else if (percentChange < -10) {
      changeType = "improvement";
    } else {
      changeType = "no_change";
    }

    comparisons.push({
      frame: currentFrame,
      baseline: baselineInfo,
      current: currentInfo,
      percentChange,
      changeType,
    });
  }

  // Sort by severity: major regressions first, then minor, then improvements
  const severityOrder = {
    major_regression: 0,
    minor_regression: 1,
    no_change: 2,
    improvement: 3,
  };

  return comparisons.sort(
    (a, b) =>
      severityOrder[a.changeType] - severityOrder[b.changeType] ||
      b.percentChange - a.percentChange,
  );
}

const MICROSECOND = 1_000;
const MILLISECOND = 1_000_000;
const SECOND = 1_000_000_000;

/**
 * Formats duration from nanoseconds to human-readable string.
 *
 * @param ns Duration in nanoseconds
 * @returns Formatted duration string (e.g., "157ms", "1.2s")
 */
export function formatDuration(ns: number): string {
  if (ns < MILLISECOND) {
    return `${(ns / MICROSECOND).toFixed(0)}µs`;
  }
  if (ns < SECOND) {
    return `${(ns / MILLISECOND).toFixed(0)}ms`;
  }
  return `${(ns / SECOND).toFixed(1)}s`;
}

/**
 * Formats a percentage value for display.
 *
 * @param value Percentage value (0-100)
 * @returns Formatted percentage string (e.g., "45.2%", "0.1%")
 */
export function formatPercentage(value: number): string {
  if (value < 1) {
    return `${value.toFixed(2)}%`;
  }
  return `${value.toFixed(1)}%`;
}

/**
 * Checks if a flamegraph has valid profile data.
 *
 * Validates that the flamegraph contains at least one profile with frames.
 * Used to determine if analysis can proceed.
 *
 * @param flamegraph Flamegraph data from API
 * @returns True if the flamegraph has valid profile data
 */
export function hasProfileData(flamegraph: Flamegraph): boolean {
  return flamegraph.profiles.length > 0 && flamegraph.shared.frames.length > 0;
}
