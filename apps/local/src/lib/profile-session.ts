import { finite, record, text } from "./inspection.ts";
import type { LocalFeedItem } from "./spotlight.ts";

const sampleSources = new WeakMap<object, LocalFeedItem>();
/** Wire object property order does not change frame or sample identity. */
export function profileValueKey(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(record(nested)).sort(([a], [b]) => a.localeCompare(b)),
        )
      : nested,
  );
}
export function profileThreadId(value: unknown): string | undefined {
  const numeric = finite(value);
  return text(value) ?? (numeric === undefined ? undefined : String(numeric));
}
const sampleEnds = new WeakMap<object, number>();
export function profileSampleEndMs(sample: object): number | undefined {
  return sampleEnds.get(sample);
}
export function profileSampleTimeMs(
  sample: Record<string, unknown>,
): number | undefined {
  const ns = sample.elapsed_since_start_ns;
  if (
    (typeof ns === "number" || (typeof ns === "string" && ns.trim())) &&
    Number.isFinite(Number(ns))
  )
    return Number(ns) / 1e6;
  const seconds = finite(sample.timestamp);
  return seconds === undefined ? undefined : seconds * 1000;
}
const mergedSessions = new WeakMap<
  LocalFeedItem,
  { chunks: LocalFeedItem[]; item: LocalFeedItem }
>();
const firstTimestamps = new WeakMap<LocalFeedItem, number>();
export function profileSampleSource(
  sample: object,
  fallback: LocalFeedItem,
): LocalFeedItem {
  return sampleSources.get(sample) ?? fallback;
}

export function profileData(item: LocalFeedItem): Record<string, unknown> {
  const payload = record(item.payload);
  return Object.keys(record(payload.profile)).length
    ? record(payload.profile)
    : payload;
}

/** Retained chunks from one captured profiler, independent of the current list filter. */
export function profileSessionItems(
  item: LocalFeedItem,
  items: readonly LocalFeedItem[],
): LocalFeedItem[] {
  const id = text(record(item.payload).profiler_id);
  if (item.type !== "profile_chunk" || !id) return [item];
  const chunks = new Map<string, LocalFeedItem>();
  for (const chunk of items) {
    if (
      chunk.type !== "profile_chunk" ||
      record(chunk.payload).profiler_id !== id
    )
      continue;
    chunks.set(text(record(chunk.payload).chunk_id) ?? chunk.id, chunk);
  }
  if (!chunks.size) return [item];
  return [...chunks.values()].sort(
    (a, b) => firstTimestamp(a) - firstTimestamp(b) || a.id.localeCompare(b.id),
  );
}

function firstTimestamp(item: LocalFeedItem): number {
  const cached = firstTimestamps.get(item);
  if (cached !== undefined) return cached;
  const samples = profileData(item).samples;
  let first = Infinity;
  if (Array.isArray(samples))
    for (const sample of samples) {
      const timestamp = finite(record(sample).timestamp);
      if (timestamp !== undefined) first = Math.min(first, timestamp);
    }
  const result = first === Infinity ? 0 : first;
  firstTimestamps.set(item, result);
  return result;
}

/** Rebase each chunk's private frame/stack indexes before combining samples. */
export function mergeProfileChunks(
  item: LocalFeedItem,
  items: readonly LocalFeedItem[],
): LocalFeedItem {
  const chunks = profileSessionItems(item, items);
  if (chunks.length === 1) {
    const survivor = chunks[0]!;
    const cached = mergedSessions.get(survivor);
    if (cached) {
      cached.chunks = chunks;
      cached.item = survivor;
    }
    return survivor;
  }
  const first = chunks[0]!;
  const cached = chunks
    .map((chunk) => mergedSessions.get(chunk))
    .find((entry) => entry !== undefined);
  if (
    cached &&
    cached.chunks.length === chunks.length &&
    chunks.every((chunk, index) => chunk === cached.chunks[index])
  )
    return cached.item;
  const frames: unknown[] = [],
    stacks: number[][] = [],
    samples: Record<string, unknown>[] = [];
  const frameIds = new Map<string, number>(),
    stackIds = new Map<string, number>(),
    sampleIds = new Map<string, Record<string, unknown>>();
  const threadMetadata: Record<string, unknown> = {};
  for (const chunk of chunks) {
    const profile = profileData(chunk);
    Object.assign(threadMetadata, record(profile.thread_metadata));
    const frameMap = new Map<number, number>(),
      stackMap = new Map<number, number>();
    if (Array.isArray(profile.frames))
      profile.frames.forEach((frame, index) => {
        if (!Object.keys(record(frame)).length) return;
        const key = profileValueKey(frame);
        let id = frameIds.get(key);
        if (id === undefined) {
          id = frames.length;
          frames.push(frame);
          frameIds.set(key, id);
        }
        frameMap.set(index, id);
      });
    if (Array.isArray(profile.stacks))
      profile.stacks.forEach((stack, index) => {
        if (!Array.isArray(stack)) return;
        const mapped: number[] = [];
        for (const frame of stack) {
          const id =
            typeof frame === "number" ? frameMap.get(frame) : undefined;
          if (id === undefined) return; // Broken indexes cannot silently describe another frame.
          mapped.push(id);
        }
        const key = JSON.stringify(mapped);
        let id = stackIds.get(key);
        if (id === undefined) {
          id = stacks.length;
          stacks.push(mapped);
          stackIds.set(key, id);
        }
        stackMap.set(index, id);
      });
    const chunkThreads = new Map<string, Record<string, unknown>[]>();
    if (Array.isArray(profile.samples))
      for (const value of profile.samples) {
        const sample = record(value),
          stack = finite(sample.stack_id);
        const mapped = {
          ...sample,
          stack_id: stack === undefined ? undefined : stackMap.get(stack),
        };
        const key = profileValueKey(mapped);
        const existing = sampleIds.get(key);
        const retained = existing ?? mapped;
        if (!existing) {
          sampleIds.set(key, mapped);
          sampleSources.set(mapped, chunk);
          samples.push(mapped);
        }
        const thread = profileThreadId(sample.thread_id) ?? "main";
        const list = chunkThreads.get(thread) ?? [];
        list.push(retained);
        chunkThreads.set(thread, list);
      }
    for (const thread of chunkThreads.values()) {
      thread.sort(
        (a, b) =>
          (profileSampleTimeMs(a) ?? Infinity) -
          (profileSampleTimeMs(b) ?? Infinity),
      );
      for (let index = 0; index < thread.length; index++) {
        const sample = thread[index]!,
          start = profileSampleTimeMs(sample);
        if (start === undefined) continue;
        const next = thread[index + 1]
          ? profileSampleTimeMs(thread[index + 1]!)
          : undefined;
        const end = next ?? start;
        if (
          sampleEnds.get(sample) === undefined ||
          sampleEnds.get(sample)! < end
        ) {
          sampleEnds.set(sample, end);
          sampleSources.set(sample, chunk);
        }
      }
    }
  }
  const payload = record(first.payload);
  const merged = {
    ...first,
    payload: {
      ...payload,
      profile: {
        ...profileData(first),
        frames,
        stacks,
        samples,
        thread_metadata: threadMetadata,
      },
    },
  };
  // All members share one replaceable cache entry, including reverse arrivals.
  // Older merged values can then be collected while their source chunks remain.
  const entry = cached ?? { chunks, item: merged };
  entry.chunks = chunks;
  entry.item = merged;
  for (const chunk of chunks) mergedSessions.set(chunk, entry);
  return merged;
}
