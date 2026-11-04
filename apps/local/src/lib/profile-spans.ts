import { finite, record, text } from "./inspection.ts";
import { profileMatchesTrace } from "./profiles.ts";
import {
  mergeProfileChunks,
  profileData,
  profileSampleSource,
  profileSampleEndMs,
  profileThreadId,
  profileValueKey,
} from "./profile-session.ts";
import type { LocalFeedItem } from "./spotlight.ts";
import type { TraceGroup, TraceSpan } from "./trace-model.ts";

const MAX_SAMPLED_SPANS = 5000;
type Interval = { start: number; end: number; parent: TraceSpan };
type TimedSample = { sample: Record<string, unknown>; timestamp: number };
const timedSamples = new WeakMap<LocalFeedItem, Map<string, TimedSample[]>>();
const profileTables = new WeakMap<
  LocalFeedItem,
  {
    profile: Record<string, unknown>;
    frames: unknown[];
    stacks: unknown[];
    samples: Record<string, unknown>[];
    threads: Set<string>;
  }
>();
function tables(item: LocalFeedItem) {
  const cached = profileTables.get(item);
  if (cached) return cached;
  const profile = profileData(item);
  const samples = (Array.isArray(profile.samples) ? profile.samples : []).map(
    record,
  );
  const result = {
    profile,
    samples,
    frames: Array.isArray(profile.frames) ? profile.frames : [],
    stacks: Array.isArray(profile.stacks) ? profile.stacks : [],
    threads: new Set(
      samples.map((sample) => profileThreadId(sample.thread_id) ?? "main"),
    ),
  };
  profileTables.set(item, result);
  return result;
}

export function profileSources(
  items: readonly LocalFeedItem[],
): LocalFeedItem[] {
  const profiles = new Map<string, LocalFeedItem>();
  for (const item of items) {
    if (item.type !== "profile" && item.type !== "profile_chunk") continue;
    const payload = record(item.payload);
    const profilerId = text(payload.profiler_id);
    const key =
      item.type === "profile_chunk" && profilerId
        ? `chunk:${profilerId}`
        : `legacy:${text(payload.event_id) ?? item.id}`;
    const previous = profiles.get(key);
    if (!previous || item.id < previous.id) profiles.set(key, item);
  }
  return [...profiles]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) =>
      item.type === "profile_chunk" ? mergeProfileChunks(item, items) : item,
    );
}

function samplesForThread(
  item: LocalFeedItem,
  samples: Record<string, unknown>[],
  thread: string,
  base: number | undefined,
): TimedSample[] {
  let cache = timedSamples.get(item);
  if (!cache) {
    cache = new Map();
    timedSamples.set(item, cache);
  }
  const key = JSON.stringify([thread, base]);
  const cached = cache.get(key);
  if (cached) return cached;
  const selected = samples
    .filter(
      (sample) => (profileThreadId(sample.thread_id) ?? "main") === thread,
    )
    .flatMap((sample) => {
      const timestamp = time(sample, base);
      return timestamp === undefined ? [] : [{ sample, timestamp }];
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  cache.set(key, selected);
  return selected;
}

/** Disjoint intervals with an unambiguous innermost captured span. */
function traceIntervals(trace: TraceGroup): Interval[] {
  const events: {
    time: number;
    span: TraceSpan;
    depth: number;
    entering: boolean;
  }[] = [];
  const seen = new Set<string>(),
    positions = new Map<string, { start: number; end: number }>();
  const pending = trace.roots.map((span) => ({
    span,
    depth: 0,
    exiting: false,
  }));
  let position = 0;
  while (pending.length) {
    const { span, depth, exiting } = pending.pop()!;
    if (exiting) {
      positions.get(span.id)!.end = position;
      continue;
    }
    if (seen.has(span.id)) continue;
    seen.add(span.id);
    positions.set(span.id, { start: position++, end: 0 });
    pending.push({ span, depth, exiting: true });
    pending.push(
      ...span.children.map((child) => ({
        span: child,
        depth: depth + 1,
        exiting: false,
      })),
    );
    if (
      span.startTimestamp === undefined ||
      span.endTimestamp === undefined ||
      span.endTimestamp <= span.startTimestamp
    )
      continue;
    events.push(
      { time: span.startTimestamp, span, depth, entering: true },
      { time: span.endTimestamp, span, depth, entering: false },
    );
  }
  events.sort((a, b) => a.time - b.time);
  const active = new Map<number, Set<TraceSpan>>(),
    heap: number[] = [];
  // Each active operation marks its subtree. The innermost candidate is
  // unambiguous only when every active operation is one of its ancestors.
  const ancestry = new Int32Array(position + 2);
  let activeCount = 0;
  function mark(index: number, delta: number) {
    for (index++; index < ancestry.length; index += index & -index)
      ancestry[index]! += delta;
  }
  function covering(index: number) {
    let count = 0;
    for (index++; index > 0; index -= index & -index) count += ancestry[index]!;
    return count;
  }
  function addDepth(depth: number) {
    heap.push(depth);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent]! >= depth) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = depth;
  }
  function highest(): Set<TraceSpan> | undefined {
    while (heap.length && !active.get(heap[0]!)?.size) {
      const last = heap.pop()!;
      if (!heap.length) break;
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1,
          right = left + 1;
        if (left >= heap.length) break;
        const child =
          right < heap.length && heap[right]! > heap[left]! ? right : left;
        if (heap[index]! >= heap[child]!) break;
        [heap[index], heap[child]] = [heap[child]!, heap[index]!];
        index = child;
      }
    }
    return active.get(heap[0]!);
  }
  const intervals: Interval[] = [];
  let previous: number | undefined;
  for (let index = 0; index < events.length;) {
    const time = events[index]!.time,
      candidates = highest();
    // Parallel sibling operations do not identify which one owns a CPU sample.
    const candidate =
      candidates?.size === 1 ? candidates.values().next().value : undefined;
    if (
      previous !== undefined &&
      time > previous &&
      candidate &&
      covering(positions.get(candidate.id)!.start) === activeCount
    ) {
      const parent = candidate;
      const last = intervals.at(-1);
      if (last?.parent === parent && last.end === previous) last.end = time;
      else intervals.push({ start: previous, end: time, parent });
    }
    while (index < events.length && events[index]!.time === time) {
      const event = events[index++]!;
      const range = positions.get(event.span.id)!;
      const delta = event.entering ? 1 : -1;
      activeCount += delta;
      mark(range.start, delta);
      mark(range.end, -delta);
      let set = active.get(event.depth);
      if (event.entering) {
        if (!set?.size) {
          set = new Set();
          active.set(event.depth, set);
          addDepth(event.depth);
        }
        set.add(event.span);
      } else set?.delete(event.span);
    }
    previous = time;
  }
  return intervals;
}

function number(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) return finite(Number(value));
  return finite(value);
}
function absoluteTimestamp(value: unknown): number | undefined {
  const numeric = number(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
}
function matchingTransaction(
  item: LocalFeedItem,
  trace: TraceGroup,
): Record<string, unknown> {
  const payload = record(item.payload);
  const transactions = Array.isArray(payload.transactions)
    ? payload.transactions.map(record)
    : [record(payload.transaction)];
  return (
    transactions.find(
      (transaction) =>
        transaction.trace_id === trace.id ||
        trace.items.some(
          (entry) =>
            transaction.id !== undefined &&
            record(entry.payload).event_id === transaction.id,
        ),
    ) ?? {}
  );
}
function time(
  sample: Record<string, unknown>,
  base: number | undefined,
): number | undefined {
  const absolute = finite(sample.timestamp);
  if (absolute !== undefined) return absolute;
  const ns = number(sample.elapsed_since_start_ns);
  return ns === undefined || base === undefined ? undefined : base + ns / 1e9;
}
function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}

/** Project observed CPU samples into a freshly built Local trace; captured spans stay intact. */
export function addProfileSpans(
  trace: TraceGroup,
  items: readonly LocalFeedItem[],
): TraceGroup {
  const linked = items.filter((item) => profileMatchesTrace(item, trace));
  if (!linked.length) return trace;
  const intervals = traceIntervals(trace);
  if (!intervals.length) return trace;
  const claimedIds = new Set(trace.spans.map((span) => span.id));
  let count = 0;
  profileLoop: for (const item of linked) {
    const sourceId = `${item.type}:${text(record(item.payload).profiler_id) ?? text(record(item.payload).event_id) ?? item.id}`;
    const { profile, frames, stacks, samples, threads } = tables(item);
    const payload = record(item.payload),
      transaction = matchingTransaction(item, trace);
    const capturedThread =
      profileThreadId(profile.active_thread_id) ??
      profileThreadId(transaction.active_thread_id);
    const thread =
      capturedThread === undefined
        ? threads.size === 1
          ? threads.values().next().value
          : undefined
        : capturedThread;
    if (thread === undefined) continue;
    const relativeStart = number(transaction.relative_start_ns);
    const matched = trace.items.find((entry) => {
      const captured = record(entry.payload);
      const profileContext = record(record(captured.contexts).profile);
      return (
        (transaction.id !== undefined &&
          captured.event_id === transaction.id) ||
        (payload.event_id !== undefined &&
          profileContext.profile_id === payload.event_id)
      );
    });
    const transactionStart =
      number(record(matched?.payload).start_timestamp) ??
      number(transaction.start_timestamp);
    // relative_start_ns is the transaction's offset from profile start.
    // Prefer the captured profile clock; derive it from the matched event only
    // when that clock is absent.
    const base =
      item.type === "profile_chunk"
        ? undefined
        : (absoluteTimestamp(payload.timestamp) ??
          (transactionStart === undefined
            ? undefined
            : transactionStart - (relativeStart ?? 0) / 1e9));
    const selected = samplesForThread(item, samples, thread, base);
    let cursor = 0;
    let low = 0,
      high = selected.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (selected[mid]!.timestamp < intervals[0]!.start) low = mid + 1;
      else high = mid;
    }
    const firstSample = Math.max(0, low - 1);
    let tail: { key: string; end: number; nodes: TraceSpan[] } | undefined;
    for (
      let index = firstSample;
      index + 1 < selected.length &&
      selected[index]!.timestamp < intervals.at(-1)!.end;
      index++
    ) {
      const current = selected[index]!;
      const observedEnd = profileSampleEndMs(current.sample);
      const end = Math.min(
        selected[index + 1]!.timestamp,
        observedEnd === undefined ? Infinity : observedEnd / 1000,
      );
      if (end <= current.timestamp) continue;
      const stackId = finite(current.sample.stack_id),
        stack = stackId === undefined ? undefined : stacks[stackId];
      if (!Array.isArray(stack)) continue;
      const path = [...stack]
        .reverse()
        .slice(0, 256)
        .map((id) =>
          record(
            typeof id === "number" && Number.isSafeInteger(id) && id >= 0
              ? frames[id]
              : undefined,
          ),
        );
      if (!path.length || path.some((frame) => !Object.keys(frame).length))
        continue;
      while (
        cursor < intervals.length &&
        intervals[cursor]!.end <= current.timestamp
      )
        cursor++;
      for (
        let position = cursor;
        position < intervals.length && intervals[position]!.start < end;
        position++
      ) {
        const interval = intervals[position]!,
          start = Math.max(current.timestamp, interval.start),
          stop = Math.min(end, interval.end);
        if (stop <= start) continue;
        const sampleSource = profileSampleSource(current.sample, item);
        const key = profileValueKey([
          sourceId,
          sampleSource.id,
          interval.parent.id,
          path,
        ]);
        if (tail?.key === key && Math.abs(tail.end - start) < 1e-9) {
          for (const node of tail.nodes) {
            node.endTimestamp = stop;
            node.durationMs =
              Math.round((stop - node.startTimestamp!) * 100_000) / 100;
          }
          tail.end = stop;
          continue;
        }
        const nodes: TraceSpan[] = [];
        let parent = interval.parent;
        for (let depth = 0; depth < path.length; depth++) {
          if (count >= MAX_SAMPLED_SPANS) {
            trace.profileSpansTruncated = true;
            break profileLoop;
          }
          const frame = path[depth]!,
            name =
              text(frame.function) ??
              text(frame.module) ??
              text(frame.instruction_addr) ??
              "Anonymous";
          const baseId = `profile:${hash(profileValueKey([sourceId, parent.id, start, path.slice(0, depth + 1)]))}`;
          let id = baseId,
            suffix = 0;
          while (claimedIds.has(id)) id = `${baseId}:${++suffix}`;
          claimedIds.add(id);
          const durationMs = Math.round((stop - start) * 100_000) / 100;
          const node: TraceSpan = {
            id,
            parentId: parent.id,
            operation: "function",
            description: name,
            startTimestamp: start,
            endTimestamp: stop,
            durationMs,
            item: sampleSource,
            sampled: true,
            payload: {
              ...frame,
              sampled: true,
              thread_id: thread,
              start_timestamp: start,
              timestamp: stop,
            },
            metadata: {
              title: name,
              operation: "function",
              traceId: trace.id,
              spanId: id,
              durationMs,
            },
            children: [],
          };
          parent.children.push(node);
          trace.spans.push(node);
          nodes.push(node);
          parent = node;
          count++;
        }
        tail = { key, end: stop, nodes };
      }
    }
  }
  for (const span of trace.spans)
    span.children.sort(
      (a, b) => (a.startTimestamp ?? Infinity) - (b.startTimestamp ?? Infinity),
    );
  trace.spans.sort(
    (a, b) => (a.startTimestamp ?? Infinity) - (b.startTimestamp ?? Infinity),
  );
  return trace;
}
