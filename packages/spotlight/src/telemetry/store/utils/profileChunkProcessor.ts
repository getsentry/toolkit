import type {
  ProcessedProfileSample,
  SentryProfileV2ChunkEvent,
} from "../../types.ts";
import type { SentryProfileWithTraceMeta } from "../types.ts";

/**
 * Represents a processed V2 profile chunk ready for storage and visualization.
 * V2 chunks use absolute timestamps and are keyed by profiler_id.
 */
export type ProcessedProfileChunk = {
  profiler_id: string;
  chunk_id: string;
  platform: string;
  release?: string;
  environment?: string;
  samples: ProcessedProfileSample[];
  stacks: number[][];
  frames: SentryProfileV2ChunkEvent["profile"]["frames"];
  thread_metadata: SentryProfileV2ChunkEvent["profile"]["thread_metadata"];
  // Timestamps derived from samples
  start_timestamp: number;
  end_timestamp: number;
};

export interface ProfileChunkProcessingResult {
  chunk: ProcessedProfileChunk;
}

/**
 * Processes a V2 profile chunk event (continuous profiling).
 * V2 samples use absolute Unix timestamps, so no relative-to-start conversion needed.
 */
export function processProfileChunkEvent(
  event: SentryProfileV2ChunkEvent,
): ProfileChunkProcessingResult {
  const { profile, profiler_id, chunk_id, platform, release, environment } =
    event;

  // Convert V2 samples to processed format
  // V2 uses absolute Unix timestamps in seconds with microsecond precision
  const processedSamples: ProcessedProfileSample[] = profile.samples.map(
    (sample) => ({
      stack_id: sample.stack_id,
      thread_id: sample.thread_id,
      start_timestamp: sample.timestamp * 1000, // Convert to milliseconds for internal use
    }),
  );

  // Sort samples by timestamp
  processedSamples.sort((a, b) => a.start_timestamp - b.start_timestamp);

  // Calculate chunk time boundaries from samples
  const start_timestamp =
    processedSamples.length > 0
      ? processedSamples[0].start_timestamp
      : Date.now();
  const end_timestamp =
    processedSamples.length > 0
      ? processedSamples[processedSamples.length - 1].start_timestamp
      : start_timestamp;

  // Reverse stacks to match the order expected by visualization (leaf first)
  const reversedStacks = profile.stacks.map((s: number[]) =>
    Array.from(s).reverse(),
  );

  const chunk: ProcessedProfileChunk = {
    profiler_id,
    chunk_id,
    platform,
    release,
    environment,
    samples: processedSamples,
    stacks: reversedStacks,
    frames: profile.frames,
    thread_metadata: profile.thread_metadata,
    start_timestamp,
    end_timestamp,
  };

  return { chunk };
}

/**
 * Merges multiple profile chunks from the same profiler session into a single profile
 * that can be used with existing profile visualization components.
 */
export function mergeChunksToProfile(
  chunks: ProcessedProfileChunk[],
  activeThreadId?: string,
): SentryProfileWithTraceMeta | null {
  if (chunks.length === 0) return null;

  // Sort chunks by start timestamp
  const sortedChunks = [...chunks].sort(
    (a, b) => a.start_timestamp - b.start_timestamp,
  );

  // Merge frames and build frame index mapping
  const mergedFrames: ProcessedProfileChunk["frames"] = [];
  const frameIndexMaps: Map<number, number>[] = [];

  for (const chunk of sortedChunks) {
    const frameMap = new Map<number, number>();
    for (let i = 0; i < chunk.frames.length; i++) {
      // For simplicity, we add all frames and dedupe by reference
      // A more sophisticated approach would dedupe by frame content
      const newIndex = mergedFrames.length;
      mergedFrames.push(chunk.frames[i]);
      frameMap.set(i, newIndex);
    }
    frameIndexMaps.push(frameMap);
  }

  // Merge stacks with remapped frame indices
  const mergedStacks: number[][] = [];
  const stackIndexMaps: Map<number, number>[] = [];

  for (let chunkIdx = 0; chunkIdx < sortedChunks.length; chunkIdx++) {
    const chunk = sortedChunks[chunkIdx];
    const frameMap = frameIndexMaps[chunkIdx];
    const stackMap = new Map<number, number>();

    for (let i = 0; i < chunk.stacks.length; i++) {
      const remappedStack = chunk.stacks[i].map(
        (frameIdx) => frameMap.get(frameIdx) ?? frameIdx,
      );
      const newIndex = mergedStacks.length;
      mergedStacks.push(remappedStack);
      stackMap.set(i, newIndex);
    }
    stackIndexMaps.push(stackMap);
  }

  // Merge samples with remapped stack indices
  const mergedSamples: ProcessedProfileSample[] = [];
  for (let chunkIdx = 0; chunkIdx < sortedChunks.length; chunkIdx++) {
    const chunk = sortedChunks[chunkIdx];
    const stackMap = stackIndexMaps[chunkIdx];

    for (const sample of chunk.samples) {
      mergedSamples.push({
        ...sample,
        stack_id: stackMap.get(sample.stack_id) ?? sample.stack_id,
      });
    }
  }

  // Sort all samples by timestamp
  mergedSamples.sort((a, b) => a.start_timestamp - b.start_timestamp);

  // Merge thread metadata
  const mergedThreadMetadata: ProcessedProfileChunk["thread_metadata"] = {};
  for (const chunk of sortedChunks) {
    Object.assign(mergedThreadMetadata, chunk.thread_metadata);
  }

  // Determine active thread ID - use provided or first thread with samples
  const resolvedActiveThreadId =
    activeThreadId ||
    (mergedSamples.length > 0
      ? mergedSamples[0].thread_id
      : Object.keys(mergedThreadMetadata)[0] || "0");

  // Calculate overall timestamp from first chunk
  const timestamp = sortedChunks[0].start_timestamp;

  return {
    platform: sortedChunks[0].platform,
    thread_metadata: mergedThreadMetadata,
    samples: mergedSamples,
    frames: mergedFrames,
    stacks: mergedStacks,
    timestamp,
    active_thread_id: resolvedActiveThreadId,
  };
}
