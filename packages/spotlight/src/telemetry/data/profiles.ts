import { log } from "../logger.ts";
import type { SentryProfileWithTraceMeta } from "../store/types.ts";
import type { Span, Trace } from "../types.ts";
import { getFunctionNameFromFrame } from "../utils/profileUtils.ts";
import { compareSpans, groupSpans } from "../utils/traces.ts";

/** Non-cryptographic FNV-1a identity for a derived profile frame, stable across replays. */
function profileSpanId(parts: unknown[]): string {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(JSON.stringify(parts))) {
    hash = BigInt.asUintN(
      128,
      (hash ^ BigInt(byte)) * 0x1000000000000000000013bn,
    );
  }
  return hash.toString(16).padStart(32, "0");
}

/**
 * Groups consequent spans with the same description and op into a single span per each level.
 * Essentially a BFS traversal of the spans tree.
 * @param spans Span[] A list of spans to consolidate, sorted by their start_timestamp
 * @returns Span[] A list of spans with the same description and op consolidated into a single span
 */
function consolidateSpans(trace: Trace, spans: Span[]): Span[] {
  type Level = {
    spans: Span[];
    result: Span[];
    lastSpan?: Span;
    index: number;
    owner?: Span;
    pendingSpan?: Span;
  };
  const result: Span[] = [];
  const levels: Level[] = [{ spans, result, lastSpan: spans[0], index: 1 }];
  while (levels.length) {
    const level = levels[levels.length - 1];
    if (level.pendingSpan) {
      // Match recursive postorder: children enter the lookup before their parent.
      level.result.push(level.pendingSpan);
      trace.spans.set(level.pendingSpan.span_id, level.pendingSpan);
      level.pendingSpan = undefined;
      continue;
    }
    if (level.index > level.spans.length) {
      if (level.owner) level.owner.children = level.result;
      levels.pop();
      continue;
    }
    const lastSpan = level.lastSpan!;
    const span = level.spans[level.index++];
    if (
      span &&
      span.description === lastSpan.description &&
      span.op === lastSpan.op &&
      (span.op !== "Thread" ||
        span.data?.thread_id === lastSpan.data?.thread_id)
    ) {
      // Require the spans are sorted by start_timestamp
      lastSpan.timestamp = span.timestamp;
      if (span.children) {
        if (lastSpan.children) {
          for (const child of span.children) {
            lastSpan.children.push(child);
          }
          lastSpan.children.sort(compareSpans);
        } else {
          lastSpan.children = span.children;
        }
      }
    } else {
      level.lastSpan = span;
      // Discard very short spans.
      if (lastSpan.timestamp - lastSpan.start_timestamp > 0) {
        if (lastSpan.children) {
          level.pendingSpan = lastSpan;
          levels.push({
            spans: lastSpan.children,
            result: [],
            lastSpan: lastSpan.children[0],
            index: 1,
            owner: lastSpan,
          });
        } else {
          level.result.push(lastSpan);
          trace.spans.set(lastSpan.span_id, lastSpan);
        }
      }
    }
  }
  return result;
}

// This is done per platform right now but we may want to make it use
// SDK or something more specific, especially for JS as `javascript` may
// mean browser, node, etc.
const SENTRY_FRAME_FILTER_PER_PLATFORM: Record<
  string,
  (
    this: SentryProfileWithTraceMeta["frames"],
    frameIdx: number,
  ) => boolean | undefined
> = {
  python: function (frameIdx) {
    return this[frameIdx].module?.startsWith("sentry_sdk.");
  },
  javascript: function (frameIdx) {
    const frame = this[frameIdx];
    const module = frame.module;
    if (module) {
      return (
        module.startsWith("@sentry") ||
        module.startsWith("@opentelemetry.instrumentation") ||
        /^@opentelemetry\/instrumentation(?:$|[-/])/.test(module)
      );
    }
    // This one below is to match things like `http://localhost:3000/node_modules/.vite/deps/@sentry_react.js?v=6942e78f` etc.
    return frame.abs_path
      ? /\/node_modules\/.*\/@(sentry|opentelemetry)[^a-z0-9]/.test(
          frame.abs_path,
        )
      : false;
  },
};

export function getSpansFromProfile(
  trace: Trace,
  profile: SentryProfileWithTraceMeta,
  parent_span_id: string | undefined,
  startTs: number,
  endTs: number,
  threadIds: Set<string>,
): Span[] {
  threadIds.add(profile.active_thread_id);

  const sentryFrameFilter =
    profile.platform &&
    Object.hasOwn(SENTRY_FRAME_FILTER_PER_PLATFORM, profile.platform)
      ? SENTRY_FRAME_FILTER_PER_PLATFORM[profile.platform]
      : undefined;
  const nextSampleTimestamps: Array<number | undefined> = [];
  const nextTimestampByThread = new Map<string, number>();
  for (
    let sampleIdx = profile.samples.length - 1;
    sampleIdx >= 0;
    sampleIdx--
  ) {
    const sample = profile.samples[sampleIdx];
    nextSampleTimestamps[sampleIdx] = nextTimestampByThread.get(
      sample.thread_id,
    );
    nextTimestampByThread.set(sample.thread_id, sample.start_timestamp);
  }
  // Try to fill in the gaps from profile data
  const fillerSpans: Span[] = [];
  for (let sampleIdx = 0; sampleIdx < profile.samples.length; sampleIdx++) {
    const sample = profile.samples[sampleIdx];
    if (sample.thread_id && !threadIds.has(sample.thread_id)) {
      continue;
    }
    const sampleTs = sample.start_timestamp;
    if (sampleTs < startTs || sampleTs > endTs) {
      continue;
    }
    const timestamp = Math.min(nextSampleTimestamps[sampleIdx] ?? endTs, endTs);
    const commonAttributes = {
      start_timestamp: sampleTs,
      timestamp,
      trace_id: trace.trace_id,
      status: "ok",
      tags: { source: "profile" },
      data: {
        "thread.id": sample.thread_id,
        "thread.name":
          profile.thread_metadata?.[
            sample.thread_id as keyof typeof profile.thread_metadata
          ]?.name,
      },
    };
    const identity = [
      trace.trace_id,
      profile.timestamp,
      parent_span_id,
      startTs,
      endTs,
      sampleIdx,
      sample.thread_id,
    ];
    const sampleSpan: Span = {
      span_id: profileSpanId([...identity, "thread"]),
      parent_span_id,
      ...commonAttributes,
      op: "Thread",
      description:
        profile.thread_metadata?.[
          sample.thread_id as keyof typeof profile.thread_metadata
        ]?.name || `Thread ${sample.thread_id}`,
      data: {
        thread_id: sample.thread_id,
      },
    };
    let currentSpan = sampleSpan;
    const currentStack = profile.stacks[sample.stack_id];
    const lastSentryFrameIdx = sentryFrameFilter
      ? currentStack.findLastIndex(sentryFrameFilter, profile.frames)
      : -1;
    for (
      let frameIdxIdx = lastSentryFrameIdx + 1;
      frameIdxIdx < currentStack.length;
      frameIdxIdx++
    ) {
      const frame = profile.frames[currentStack[frameIdxIdx]];
      // XXX: We may wanna skip frames that doesn't have `in_app` set to true
      //      that said it's better to have this as a dynamic filter
      const description =
        frame.module || frame.filename || frame.abs_path || "<unknown>";
      // The separator follows the complete module; either component may contain @.
      const op = getFunctionNameFromFrame(frame).slice(description.length + 1);
      const spanFromFrame: Span = {
        span_id: profileSpanId([...identity, "frame", frameIdxIdx]),
        parent_span_id: currentSpan.span_id,
        ...commonAttributes,
        op,
        description,
        data: {
          ...frame,
        },
      };
      currentSpan.children = [spanFromFrame];
      currentSpan = spanFromFrame;
    }
    fillerSpans.push(sampleSpan);
  }

  if (!fillerSpans.length) {
    return [];
  }
  const consolidated = consolidateSpans(trace, fillerSpans);
  // Remove the extra layer of nesting if there is only one span which should be the "Thread" span
  return (
    consolidated.length === 1 ? consolidated[0].children || [] : consolidated
  ).filter(
    (span) =>
      span.timestamp - span.start_timestamp > 0 && span.timestamp <= endTs,
  );
}

function getThreadId(span: Span | Trace | undefined): string | undefined {
  const threadId = span?.data?.["thread.id"] ?? span?.data?.threadId;
  return typeof threadId === "string" || typeof threadId === "number"
    ? String(threadId)
    : undefined;
}

/**
 * Rebuilds derived profile spans from the latest samples and real span topology.
 * Real spans retain their transaction references; stale derived children and
 * missing-parent wrappers are reconstructed rather than grafted a second time.
 */
export function graftProfileSpans(
  trace: Trace,
  profile: SentryProfileWithTraceMeta,
) {
  trace.spans = new Map(
    Array.from(trace.spans)
      .filter(
        ([, span]) => span.tags?.source !== "profile" && span.op !== "orphan",
      )
      .map(([id, span]) => [id, { ...span, children: undefined }]),
  );
  trace.spanTree = groupSpans(trace.spans);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of trace.spans.values()) {
    if (span.op === "orphan") continue;
    if (
      Number.isFinite(span.start_timestamp) &&
      Number.isFinite(span.timestamp)
    ) {
      start = Math.min(start, span.start_timestamp);
      end = Math.max(end, span.timestamp);
    }
  }
  // Trace timestamps include context-only errors and logs. Profile gaps must
  // instead follow captured work, including real spans beyond a transaction.
  if (start < end) {
    graftProfileSpansIntoTree(trace, profile, trace.spanTree, {
      ...trace,
      start_timestamp: start,
      timestamp: end,
    });
  }
  trace.profileGrafted = true;
}

function graftProfileSpansIntoTree(
  trace: Trace,
  profile: SentryProfileWithTraceMeta,
  spanTree: Span[] = trace.spanTree,
  parent: Span | Trace = trace,
) {
  log(`Grafting profile spans into trace ${trace.trace_id}`);
  const levels: { spanTree: Span[]; parent: Span | Trace; index: number }[] = [
    { spanTree, parent, index: -1 },
  ];
  while (levels.length) {
    const level = levels[levels.length - 1];
    if (level.index >= level.spanTree.length) {
      levels.pop();
      continue;
    }
    const span = level.spanTree[level.index] as Span | undefined;
    if (span?.tags?.source === "profile") {
      level.index++;
      continue;
    }
    const nextSpan = level.spanTree[level.index + 1];
    if (nextSpan?.tags?.source === "profile") {
      level.index++;
      continue;
    }

    const startTs = span ? span.timestamp : level.parent.start_timestamp;
    const endTs = nextSpan ? nextSpan.start_timestamp : level.parent.timestamp;
    const threadIds = new Set([
      getThreadId(span),
      getThreadId(nextSpan),
      getThreadId(level.parent),
    ]);
    threadIds.delete(undefined);
    if (endTs - startTs > 0) {
      const fillers = getSpansFromProfile(
        trace,
        profile,
        level.parent.span_id,
        startTs,
        endTs,
        threadIds as Set<string>,
      );
      if (fillers.length) {
        level.spanTree.splice(level.index + 1, 0, ...fillers);
        level.index += fillers.length;
      }
    }
    level.index++;
    if (span) {
      span.children ??= [];
      // Resume the current sibling level only after its child's gaps are grafted.
      levels.push({ spanTree: span.children, parent: span, index: -1 });
    }
  }
}
