import {
  ERROR_EVENT_TYPES,
  FEEDBACK_EVENT_TYPES,
  LOG_EVENT_TYPES,
  PROFILE_EVENT_TYPES,
  TRACE_EVENT_TYPES,
} from "../constants/sentry.ts";
import type {
  SentryErrorEvent,
  SentryEvent,
  SentryFeedbackEvent,
  SentryLogEvent,
  SentryProfileV1Event,
  SentryProfileV2ChunkEvent,
  SentryTransactionEvent,
} from "../types.ts";

export function isErrorEvent(event: SentryEvent): event is SentryErrorEvent {
  return (
    (!event.type || ERROR_EVENT_TYPES.has(event.type)) &&
    Boolean((event as SentryErrorEvent).exception)
  );
}

export function isProfileEvent(
  event: SentryEvent,
): event is SentryProfileV1Event {
  return (
    !!event.type &&
    PROFILE_EVENT_TYPES.has(event.type) &&
    (event as SentryProfileV1Event).version === "1"
  );
}

export function isProfileChunkEvent(
  event: SentryEvent,
): event is SentryProfileV2ChunkEvent {
  return (
    event.type === "profile_chunk" &&
    (event as SentryProfileV2ChunkEvent).version === "2"
  );
}

export function isTraceEvent(
  event: SentryEvent,
): event is SentryTransactionEvent {
  return !!event.type && TRACE_EVENT_TYPES.has(event.type);
}

export function isLogEvent(event: SentryEvent): event is SentryLogEvent {
  return !!event.type && LOG_EVENT_TYPES.has(event.type);
}

export function isFeedbackEvent(
  event: SentryEvent,
): event is SentryFeedbackEvent {
  return (
    !!event.type &&
    FEEDBACK_EVENT_TYPES.has(event.type) &&
    Boolean((event as SentryFeedbackEvent).contexts?.feedback)
  );
}
