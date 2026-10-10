/**
 * Replay → rrweb conversion
 *
 * Turns Sentry's recording-segments response into the flat event array that
 * rrweb-player and rrvideo consume.
 */

import type { ListProjectReplayRecordingSegmentsResponse } from "@sentry/api";

type ReplayRecordingSegments = ListProjectReplayRecordingSegmentsResponse;

/** One recorded event: an rrweb event or a Sentry custom (type 5) event. */
export type RRWebEvent = ReplayRecordingSegments[number][number];

/**
 * Flatten recording segments into a single time-ordered rrweb event array.
 *
 * Events are saved as the server returned them, including Sentry's custom
 * events. The only edit is converting second-resolution timestamps to
 * milliseconds, without which the array can't be ordered.
 */
export function toRRWebEvents(segments: ReplayRecordingSegments): RRWebEvent[] {
  const events = segments.flat().map(normalizeTimestamp);

  // Segments are ordered, but Sentry's custom events are appended to each
  // segment out of order. Array.prototype.sort is stable, so rrweb events
  // sharing a timestamp keep their recorded order.
  events.sort((a, b) => timestampOf(a) - timestampOf(b));

  return events;
}

/** Whether the events include a full DOM snapshot, which playback requires. */
export function hasFullSnapshot(events: RRWebEvent[]): boolean {
  return events.some((event) => event.type === EVENT_TYPE_FULL_SNAPSHOT);
}

/** Recording length in milliseconds, from the first to the last event. */
export function rrwebDurationMs(events: RRWebEvent[]): number {
  const first = events[0];
  const last = events.at(-1);
  return first && last ? timestampOf(last) - timestampOf(first) : 0;
}

/**
 * Sentry's `performanceSpan` custom events carry timestamps in seconds, rrweb
 * events in milliseconds. A seconds value mixed in makes the player think the
 * recording starts in 1970.
 */
function normalizeTimestamp(event: RRWebEvent): RRWebEvent {
  const { timestamp } = event;
  return typeof timestamp === "number" && timestamp < SECONDS_THRESHOLD
    ? { ...event, timestamp: Math.round(timestamp * 1000) }
    : event;
}

function timestampOf(event: RRWebEvent): number {
  return typeof event.timestamp === "number" ? event.timestamp : 0;
}

const EVENT_TYPE_FULL_SNAPSHOT = 2;
/** Anything below this is seconds-since-epoch, not milliseconds (1e11 ms = 1973). */
const SECONDS_THRESHOLD = 1e11;
