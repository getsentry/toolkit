import type { SentryProcessedProfile, TraceId } from "../types.ts";
import { getFunctionNameFromFrame } from "../utils/profileUtils.ts";
import type { SpanFilter } from "./spans.ts";

export type ProfileFunctionSummary = {
  name: string;
  totalDurationMs: number;
  sampleCount: number;
  traceIds: Set<TraceId>;
};

/** Inclusive frame durations in milliseconds, using intervals between samples of the same thread. */
export function getProfileFunctionSummaries(
  profilesByTraceId: ReadonlyMap<string, SentryProcessedProfile>,
  filter: SpanFilter = {},
): ProfileFunctionSummary[] {
  const aggregateCalls = new Map<string, ProfileFunctionSummary>();
  for (const [traceId, profile] of profilesByTraceId) {
    if (filter.traceId !== undefined && traceId !== filter.traceId) continue;
    const durations: Array<number | undefined> = [];
    const nextTimestampByThread = new Map<string, number>();
    for (
      let sampleIdx = profile.samples.length - 1;
      sampleIdx >= 0;
      sampleIdx--
    ) {
      const sample = profile.samples[sampleIdx];
      const nextTimestamp = nextTimestampByThread.get(sample.thread_id);
      if (nextTimestamp !== undefined) {
        durations[sampleIdx] = nextTimestamp - sample.start_timestamp;
      }
      nextTimestampByThread.set(sample.thread_id, sample.start_timestamp);
    }
    // Each thread's final sample has no known duration and is not included.
    for (let sampleIdx = 0; sampleIdx < profile.samples.length; sampleIdx++) {
      const sample = profile.samples[sampleIdx];
      const duration = durations[sampleIdx];
      if (duration === undefined) continue;
      for (const frameIdx of profile.stacks[sample.stack_id]) {
        const name = getFunctionNameFromFrame(profile.frames[frameIdx]);
        const callData = aggregateCalls.get(name);
        if (callData) {
          callData.totalDurationMs += duration;
          callData.sampleCount += 1;
          callData.traceIds.add(traceId);
        } else {
          aggregateCalls.set(name, {
            name,
            totalDurationMs: duration,
            sampleCount: 1,
            traceIds: new Set<TraceId>([traceId]),
          });
        }
      }
    }
  }
  return Array.from(aggregateCalls.values());
}
