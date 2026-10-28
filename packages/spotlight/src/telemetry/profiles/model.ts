import { record, finite, text } from "../internal/wireValues.ts";
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
  const ns = sample.elapsed_since_start_ns;
  if (typeof ns === "string" && ns.trim() && Number.isFinite(Number(ns)))
    return Number(ns) / 1e6;
  if (finite(ns) !== undefined) return Number(ns) / 1e6;
  const seconds = finite(sample.timestamp);
  return seconds === undefined ? undefined : seconds * 1000;
}
function sampleThread(value: unknown): string {
  const number = finite(value);
  return text(value) ?? (number === undefined ? "main" : String(number));
}
/** SDK stacks are leaf-first; sample intervals are calculated independently per thread. */
export function buildProfileModel(
  input: unknown,
  selectedThread?: string,
): ParsedProfile {
  const payload = record(input),
    profile = Object.keys(record(payload.profile)).length
      ? record(payload.profile)
      : payload;
  const samples = (Array.isArray(profile.samples) ? profile.samples : []).map(
    record,
  );
  const frames = Array.isArray(profile.frames) ? profile.frames : [];
  const stacks = Array.isArray(profile.stacks) ? profile.stacks : [];
  const metadata = record(profile.thread_metadata);
  const threads = [
    ...new Set(samples.map((sample) => sampleThread(sample.thread_id))),
  ].map((id) => ({ id, name: text(record(metadata[id]).name) ?? id }));
  const threadId = threads.some((thread) => thread.id === selectedThread)
    ? selectedThread
    : threads[0]?.id;
  const selected = samples
    .filter((sample) => sampleThread(sample.thread_id) === threadId)
    .sort((a, b) => (sampleTime(a) ?? Infinity) - (sampleTime(b) ?? Infinity));
  const root = node("root", "All samples"),
    functions = new Map<string, ProfileFunction>();
  const children = new Map<ProfileNode, Map<number, ProfileNode>>();
  let hasTiming = false;
  for (let index = 0; index < selected.length; index++) {
    const sample = selected[index]!,
      stackId = finite(sample.stack_id),
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
      next = selected[index + 1] ? sampleTime(selected[index + 1]!) : undefined;
    const weight =
      time !== undefined && next !== undefined ? Math.max(0, next - time) : 0;
    if (time !== undefined && next !== undefined) hasTiming = true;
    root.samples++;
    root.totalMs += weight;
    let parent = root;
    const seenFunctions = new Set<string>();
    // Bound pathological stack depth to protect the UI; raw data remains inspectable.
    for (const frameId of stack.slice(0, 256)) {
      if (!frames[frameId] || typeof frames[frameId] !== "object") continue;
      const frame = record(frames[frameId]);
      const name =
        text(frame.function) ??
        text(frame.module) ??
        text(frame.instruction_addr) ??
        "Anonymous";
      const location = [
        text(frame.abs_path) ?? text(frame.filename),
        finite(frame.lineno),
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
          frame.in_app === true,
        );
        childMap.set(frameId, child);
        parent.children.push(child);
      }
      child.samples++;
      child.totalMs += weight;
      parent = child;
      const key = `${name}:${location}`;
      const fn = functions.get(key) ?? {
        ...node(key, name, location, frame.in_app === true),
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
    durationMs: hasTiming ? root.totalMs : undefined,
    threads,
    threadId,
  };
}
