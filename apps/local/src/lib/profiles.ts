import { buildProfileModel, type ParsedProfile } from "@sentry/telemetry";
import type { LocalFeedItem } from "./spotlight.ts";
import type { TraceGroup } from "./trace-model.ts";
import { record, finite, text } from "./inspection.ts";
export type {
  ProfileNode,
  ProfileFunction,
  ParsedProfile,
} from "@sentry/telemetry";

export function parseProfile(
  item: LocalFeedItem,
  selectedThread?: string,
): ParsedProfile {
  return buildProfileModel(item.payload, selectedThread);
}

type ProfileBounds = { start: number; end: number };
// Captured items are immutable. Reuse bounds across trace rows and inspectors,
// and let retention release the cache together with its captured item.
const profileBoundsCache = new WeakMap<LocalFeedItem, ProfileBounds | null>();
function profileBounds(item: LocalFeedItem): ProfileBounds | null {
  const cached = profileBoundsCache.get(item);
  if (cached !== undefined) return cached;
  const payload = record(item.payload);
  const samples = record(payload.profile).samples ?? payload.samples;
  let start = Infinity,
    end = -Infinity;
  if (Array.isArray(samples)) {
    for (const sample of samples) {
      const timestamp = finite(record(sample).timestamp);
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
  const transactions = Array.isArray(p.transactions)
    ? p.transactions.map(record)
    : [record(p.transaction)];
  if (
    transactions.some((transaction) => {
      const traceId = text(transaction.trace_id);
      const eventId = text(transaction.id);
      return (
        (traceId !== undefined && traceId === trace.id) ||
        (eventId !== undefined &&
          trace.items.some(
            (entry) => text(record(entry.payload).event_id) === eventId,
          ))
      );
    })
  )
    return true;
  const profileId = text(p.event_id);
  const profilerId = text(p.profiler_id);
  return trace.items.some((entry) => {
    const captured = record(record(record(entry.payload).contexts).profile);
    if (profileId !== undefined && captured.profile_id === profileId)
      return true;
    // Most traces have no matching profiler. Reject them before touching samples.
    if (profilerId === undefined || captured.profiler_id !== profilerId)
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
