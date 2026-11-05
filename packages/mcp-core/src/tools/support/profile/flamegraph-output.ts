/**
 * Structured output for `get_profile` (aggregated transaction flamegraph).
 *
 * Frames are bucketed once in `frames` and referenced by index from
 * `topFunctions`, hot path stacks, and leaves, so deep shared parents are not
 * repeated for every hot path.
 */

import { z } from "zod";
import type {
  Flamegraph,
  FlamegraphFrame,
  FlamegraphFrameInfo,
} from "../../../api-client/types";
import {
  type FrameComparison,
  analyzeHotPathsFromFlamegraph,
  compareFrameStats,
  generatePerformanceInsights,
  identifyHotspotFramesFromFlamegraph,
} from "./analyzer";

const MAX_TOP_FUNCTIONS = 10;
const MAX_COMPARISON_CHANGES = 10;

const changeTypeSchema = z.enum([
  "major_regression",
  "minor_regression",
  "improvement",
  "no_change",
]);

const flamegraphFrameSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  isApplication: z.boolean(),
  sampleCount: z.number(),
  percentOfSamples: z
    .number()
    .describe("Share of all samples whose stack includes this frame."),
  p75Ms: z.number(),
  p95Ms: z.number(),
  p99Ms: z.number(),
  insights: z.array(
    z.enum([
      "high_variance",
      "consistently_slow",
      "hot_function",
      "consistent",
    ]),
  ),
});

const analysisSchema = z.object({
  platform: z.string().nullable(),
  profileCount: z.number(),
  sampleCount: z.number(),
  estimatedTotalMs: z.number(),
  userCodeMs: z.number(),
  libraryMs: z.number(),
  userCodePercent: z.number(),
  frames: z
    .array(flamegraphFrameSchema)
    .describe(
      "Frames referenced by topFunctions and hotPaths. Other fields refer to frames by index into this array.",
    ),
  topFunctions: z
    .array(z.number())
    .describe("Frame indexes of the slowest functions, by CPU weight."),
  hotPaths: z.array(
    z.object({
      percentOfSamples: z.number(),
      sampleCount: z.number(),
      stack: z
        .array(z.number())
        .describe(
          "Frame indexes from root to leaf. Library frames are omitted when focusOnUserCode is true. The last frame is the primary bottleneck.",
        ),
      leaf: z
        .number()
        .describe(
          "Frame index of the sampled leaf, which can be library code omitted from stack.",
        ),
    }),
  ),
});

const comparisonSchema = z.object({
  status: changeTypeSchema.describe(
    "Most severe change among compared frames.",
  ),
  changes: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      line: z.number(),
      isApplication: z.boolean(),
      baselineMs: z.number(),
      currentMs: z.number(),
      percentChange: z.number(),
      changeType: changeTypeSchema,
    }),
  ),
});

export const getProfileOutputSchema = z.object({
  transactionName: z.string(),
  projectId: z.string(),
  period: z.string(),
  baselinePeriod: z
    .string()
    .nullable()
    .describe("Null unless compareAgainstPeriod was set."),
  focusOnUserCode: z.boolean(),
  hasCurrentData: z.boolean(),
  hasBaselineData: z
    .boolean()
    .nullable()
    .describe("Null unless compareAgainstPeriod was set."),
  analysis: analysisSchema
    .nullable()
    .describe("Single-period analysis. Null when comparing or without data."),
  comparison: comparisonSchema
    .nullable()
    .describe("Baseline comparison. Null unless both periods have data."),
});

type FlamegraphAnalysis = z.infer<typeof analysisSchema>;
type FlamegraphComparison = z.infer<typeof comparisonSchema>;

function toMs(ns: number): number {
  return Math.round(ns / 10_000) / 100;
}

function roundPercent(value: number): number {
  const digits = Math.abs(value) < 1 ? 100 : 10;
  return Math.round(value * digits) / digits;
}

function sumOf(values: number[] | undefined): number {
  return values?.reduce((a, b) => a + b, 0) ?? 0;
}

/**
 * Builds the single-period analysis. Mirrors the previous markdown sections:
 * transaction summary, user/library breakdown, top functions, and hot paths.
 */
export function buildFlamegraphAnalysis(
  flamegraph: Flamegraph,
  options: { focusOnUserCode: boolean; maxHotPaths: number },
): FlamegraphAnalysis {
  const mainProfile = flamegraph.profiles[0];
  const sampleCount = sumOf(mainProfile?.sample_counts);
  const totalSamples = flamegraph.profiles.reduce(
    (sum, profile) => sum + sumOf(profile.sample_counts),
    0,
  );

  // User/library breakdown over the top hotspots across both kinds of code.
  let userCodeNs = 0;
  let libraryNs = 0;
  for (const hotspot of identifyHotspotFramesFromFlamegraph(flamegraph, {
    focusOnUserCode: false,
  })) {
    if (hotspot.frame.is_application) {
      userCodeNs += hotspot.frameInfo.sumDuration;
    } else {
      libraryNs += hotspot.frameInfo.sumDuration;
    }
  }
  const breakdownTotal = userCodeNs + libraryNs;

  const outputFrames: FlamegraphAnalysis["frames"] = [];
  const outputIndexBySource = new Map<number, number>();
  const refFrame = (
    sourceIndex: number,
    frame: FlamegraphFrame,
    frameInfo: FlamegraphFrameInfo,
  ): number => {
    const existing = outputIndexBySource.get(sourceIndex);
    if (existing !== undefined) {
      return existing;
    }
    outputFrames.push({
      name: frame.name,
      file: frame.file,
      line: frame.line,
      isApplication: frame.is_application,
      sampleCount: frameInfo.count,
      percentOfSamples: roundPercent(
        totalSamples > 0 ? (frameInfo.count / totalSamples) * 100 : 0,
      ),
      p75Ms: toMs(frameInfo.p75Duration),
      p95Ms: toMs(frameInfo.p95Duration),
      p99Ms: toMs(frameInfo.p99Duration),
      insights: generatePerformanceInsights(frameInfo).map(
        (insight) => insight.type,
      ),
    });
    const index = outputFrames.length - 1;
    outputIndexBySource.set(sourceIndex, index);
    return index;
  };

  const topFunctions = identifyHotspotFramesFromFlamegraph(flamegraph, options)
    .slice(0, MAX_TOP_FUNCTIONS)
    .map((hotspot) =>
      refFrame(hotspot.frameIndex, hotspot.frame, hotspot.frameInfo),
    );

  const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, options).flatMap(
    (path) => {
      // callStack is leaf-to-root; output stacks read root-to-leaf.
      const leaf = path.callStack[0];
      if (!leaf) {
        return [];
      }
      const shown = options.focusOnUserCode
        ? path.userCodeFrames
        : path.callStack;
      return [
        {
          percentOfSamples: roundPercent(path.percentOfTotal),
          sampleCount: path.sampleCount,
          stack: [...shown]
            .reverse()
            .map((entry) =>
              refFrame(entry.frameIndex, entry.frame, entry.frameInfo),
            ),
          leaf: refFrame(leaf.frameIndex, leaf.frame, leaf.frameInfo),
        },
      ];
    },
  );

  return {
    platform: flamegraph.platform || null,
    profileCount:
      flamegraph.shared.profiles.length || flamegraph.profiles.length,
    sampleCount,
    estimatedTotalMs: toMs(sumOf(mainProfile?.sample_durations_ns)),
    userCodeMs: toMs(userCodeNs),
    libraryMs: toMs(libraryNs),
    userCodePercent: roundPercent(
      breakdownTotal > 0 ? (userCodeNs / breakdownTotal) * 100 : 0,
    ),
    frames: outputFrames,
    topFunctions,
    hotPaths,
  };
}

function comparisonStatus(
  comparisons: FrameComparison[],
): FrameComparison["changeType"] {
  for (const changeType of [
    "major_regression",
    "minor_regression",
    "improvement",
  ] as const) {
    if (comparisons.some((c) => c.changeType === changeType)) {
      return changeType;
    }
  }
  return "no_change";
}

/** Builds the baseline-vs-current comparison for frames present in both. */
export function buildFlamegraphComparison(
  baseline: Flamegraph,
  current: Flamegraph,
  options: { focusOnUserCode: boolean },
): FlamegraphComparison {
  const comparisons = compareFrameStats(baseline, current, options);
  return {
    status: comparisonStatus(comparisons),
    changes: comparisons.slice(0, MAX_COMPARISON_CHANGES).map((comparison) => ({
      name: comparison.frame.name,
      file: comparison.frame.file,
      line: comparison.frame.line,
      isApplication: comparison.frame.is_application,
      baselineMs: toMs(comparison.baseline.sumDuration),
      currentMs: toMs(comparison.current.sumDuration),
      percentChange: roundPercent(comparison.percentChange),
      changeType: comparison.changeType,
    })),
  };
}
