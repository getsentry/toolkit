import type { LocalFeedItem } from "./spotlight.ts";
import type { TraceGroup } from "./trace-model.ts";
import { record, finite, text } from "./inspection.ts";
import {
  mergeProfileChunks,
  profileSampleEndMs,
  profileSampleTimeMs,
  profileThreadId,
} from "./profile-session.ts";
export type ProfileNode = {
  id: string;
  name: string;
  location: string;
  inApp: boolean;
  samples: number;
  selfSamples: number;
  totalMs: number;
  selfMs: number;
  children: ProfileNode[];
};
export type ProfileFunction = Omit<ProfileNode, "children">;
export type ParsedProfile = {
  root: ProfileNode;
  functions: ProfileFunction[];
  sampleCount: number;
  durationMs?: number;
  threads: { id: string; name: string }[];
  threadId?: string;
};
function node(
  id: string,
  name: string,
  location = "",
  inApp = false,
): ProfileNode {
  return {
    id,
    name,
    location,
    inApp,
    samples: 0,
    selfSamples: 0,
    totalMs: 0,
    selfMs: 0,
    children: [],
  };
}
function sampleTime(sample: Record<string, unknown>): number | undefined {
  return profileSampleTimeMs(sample);
}
function sampleThread(value: unknown): string {
  return profileThreadId(value) ?? "main";
}
/** SDK stacks are leaf-first; sample intervals are calculated independently per thread. */
export function parseProfile(
  item: LocalFeedItem,
  selectedThread?: string,
  retainedItems?: readonly LocalFeedItem[],
): ParsedProfile {
  if (retainedItems) item = mergeProfileChunks(item, retainedItems);
  const payload = record(item.payload),
    profile = Object.keys(record(payload["profile"])).length
      ? record(payload["profile"])
      : payload;
  const samples = (
    Array.isArray(profile["samples"]) ? profile["samples"] : []
  ).map(record);
  const frames = Array.isArray(profile["frames"]) ? profile["frames"] : [];
  const stacks = Array.isArray(profile["stacks"]) ? profile["stacks"] : [];
  const metadata = record(profile["thread_metadata"]);
  const threads = [
    ...new Set(samples.map((sample) => sampleThread(sample["thread_id"]))),
  ].map((id) => ({ id, name: text(record(metadata[id])["name"]) ?? id }));
  const transaction = record(payload["transaction"]);
  const preferredThread =
    selectedThread ??
    profileThreadId(profile["active_thread_id"]) ??
    profileThreadId(transaction["active_thread_id"]);
  const threadId = threads.some((thread) => thread.id === preferredThread)
    ? preferredThread
    : threads[0]?.id;
  const selected = samples
    .filter((sample) => sampleThread(sample["thread_id"]) === threadId)
    .sort((a, b) => (sampleTime(a) ?? Infinity) - (sampleTime(b) ?? Infinity));
  const root = node("root", "All samples"),
    functions = new Map<string, ProfileFunction>();
  const children = new Map<ProfileNode, Map<number, ProfileNode>>();
  let hasTiming = false;
  for (const [index, sample] of selected.entries()) {
    const stackId = finite(sample["stack_id"]),
      rawStack: unknown = stackId === undefined ? undefined : stacks[stackId];
    const stack = Array.isArray(rawStack)
      ? rawStack
          .filter(
            (id): id is number =>
              typeof id === "number" && Number.isInteger(id) && id >= 0,
          )
          .toReversed()
      : [];
    const time = sampleTime(sample),
      following = selected[index + 1],
      next = following ? sampleTime(following) : undefined;
    const capturedEnd = profileSampleEndMs(sample);
    const end =
      capturedEnd === undefined
        ? next
        : next === undefined
          ? capturedEnd
          : Math.min(next, capturedEnd);
    const weight =
      time !== undefined && end !== undefined ? Math.max(0, end - time) : 0;
    if (
      time !== undefined &&
      end !== undefined &&
      (weight > 0 || (capturedEnd === undefined && next !== undefined))
    )
      hasTiming = true;
    root.samples++;
    root.totalMs += weight;
    let parent = root;
    const seenFunctions = new Set<string>();
    // Bound pathological stack depth to protect the UI; raw data remains inspectable.
    for (const frameId of stack.slice(0, 256)) {
      if (!frames[frameId] || typeof frames[frameId] !== "object") continue;
      const frame = record(frames[frameId]);
      const name =
        text(frame["function"]) ??
        text(frame["module"]) ??
        text(frame["instruction_addr"]) ??
        "Anonymous";
      const location = [
        text(frame["abs_path"]) ?? text(frame["filename"]),
        finite(frame["lineno"]),
      ]
        .filter((value) => value !== undefined)
        .join(":");
      const childMap = children.get(parent) ?? new Map<number, ProfileNode>();
      children.set(parent, childMap);
      let child = childMap.get(frameId);
      if (!child) {
        child = node(
          `${parent.id}/${frameId}`,
          name,
          location,
          frame["in_app"] === true,
        );
        childMap.set(frameId, child);
        parent.children.push(child);
      }
      child.samples++;
      child.totalMs += weight;
      parent = child;
      const key = `${name}:${location}`;
      const fn = functions.get(key) ?? {
        ...node(key, name, location, frame["in_app"] === true),
      };
      if (!seenFunctions.has(key)) {
        fn.samples++;
        fn.totalMs += weight;
        seenFunctions.add(key);
      }
      functions.set(key, fn);
    }
    parent.selfSamples++;
    parent.selfMs += weight;
    if (parent !== root) {
      const fn = functions.get(`${parent.name}:${parent.location}`);
      if (fn) {
        fn.selfSamples++;
        fn.selfMs += weight;
      }
    }
  }
  return {
    root,
    functions: [...functions.values()].sort(
      (a, b) => b.totalMs - a.totalMs || b.samples - a.samples,
    ),
    sampleCount: selected.length,
    ...(hasTiming && { durationMs: root.totalMs }),
    threads,
    ...(threadId !== undefined && { threadId }),
  };
}
type ProfileBounds = { start: number; end: number };
// Captured items are immutable. Reuse bounds across trace rows and inspectors,
// and let retention release the cache together with its captured item.
const profileBoundsCache = new WeakMap<LocalFeedItem, ProfileBounds | null>();
function profileBounds(item: LocalFeedItem): ProfileBounds | null {
  const cached = profileBoundsCache.get(item);
  if (cached !== undefined) return cached;
  const payload = record(item.payload);
  const samples = record(payload["profile"])["samples"] ?? payload["samples"];
  let start = Infinity,
    end = -Infinity;
  if (Array.isArray(samples)) {
    for (const sample of samples) {
      const timestamp = finite(record(sample)["timestamp"]);
      if (timestamp === undefined) continue;
      start = Math.min(start, timestamp);
      end = Math.max(end, timestamp);
    }
  }
  const bounds = start === Infinity ? null : { start, end };
  profileBoundsCache.set(item, bounds);
  return bounds;
}
export function profileMatchesTrace(
  item: LocalFeedItem,
  trace: TraceGroup,
): boolean {
  const p = record(item.payload);
  const transactions = Array.isArray(p["transactions"])
    ? p["transactions"].map(record)
    : [record(p["transaction"])];
  if (
    transactions.some((transaction) => {
      const traceId = text(transaction["trace_id"]);
      const eventId = text(transaction["id"]);
      return (
        (traceId !== undefined && traceId === trace.id) ||
        (eventId !== undefined &&
          trace.items.some(
            (entry) => text(record(entry.payload)["event_id"]) === eventId,
          ))
      );
    })
  )
    return true;
  const profileId = text(p["event_id"]);
  const profilerId = text(p["profiler_id"]);
  return trace.items.some((entry) => {
    const captured = record(
      record(record(entry.payload)["contexts"])["profile"],
    );
    if (profileId !== undefined && captured["profile_id"] === profileId)
      return true;
    // Most traces have no matching profiler. Reject them before touching samples.
    if (profilerId === undefined || captured["profiler_id"] !== profilerId)
      return false;
    if (trace.startTimestamp === undefined || trace.endTimestamp === undefined)
      return true;
    const bounds = profileBounds(item);
    return (
      bounds === null ||
      (bounds.start <= trace.endTimestamp && bounds.end >= trace.startTimestamp)
    );
  });
}
