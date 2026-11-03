import type { StateCreator } from "zustand/vanilla";
import { graftProfileSpans } from "../../data/profiles.ts";
import { mutableCopy } from "../../internal/readonly.ts";
import type { EngineOptions, ProcessingRuntime } from "../../internal/types.ts";
import type { SentryEvent, SentryLogEventItem, Trace } from "../../types.ts";
import {
  isErrorEvent,
  isLogEvent,
  isProfileChunkEvent,
  isProfileEvent,
  isTraceEvent,
} from "../../utils/sentry.ts";
import { generateUuidv4 } from "../../uuid.ts";
import type {
  EventsSliceActions,
  EventsSliceState,
  SentryProfileWithTraceMeta,
  SentryStore,
} from "../types.ts";
import { toTimestamp } from "../utils.ts";
import { processLogItems } from "../utils/logProcessor.ts";
import {
  mergeChunksToProfile,
  processProfileChunkEvent,
} from "../utils/profileChunkProcessor.ts";
import { processProfileEvent } from "../utils/profileProcessor.ts";
import { processSpanEvent } from "../utils/spanProcessor.ts";
import { initializeTrace } from "../utils/traceInitializer.ts";
import {
  processTransactionEvent,
  updateTraceMetadata,
} from "../utils/traceProcessor.ts";

function continuousProfileForTrace(
  trace: Trace,
  chunksByProfilerId: SentryStore["profileChunksByProfilerId"],
  profilerId?: string,
): SentryProfileWithTraceMeta | undefined {
  for (const transaction of trace.transactions) {
    const profileContext = transaction.contexts.profile as
      | { profiler_id?: string }
      | undefined;
    const id = profileContext?.profiler_id;
    if (!id || (profilerId !== undefined && profilerId !== id)) continue;
    const chunks = chunksByProfilerId.get(id);
    if (!chunks?.length) continue;
    const threadId = transaction.contexts.trace.data?.["thread.id"];
    return (
      mergeChunksToProfile(
        chunks,
        typeof threadId === "string" || typeof threadId === "number"
          ? String(threadId)
          : undefined,
      ) ?? undefined
    );
  }
  return undefined;
}

export const createEventsSlice =
  (
    options: EngineOptions,
    runtime: ProcessingRuntime,
  ): StateCreator<SentryStore, [], [], EventsSliceState & EventsSliceActions> =>
  (set, get) => {
    const pendingIds = new Map<string, number>();
    // A committed engine state can back a lazy historical snapshot. Copy each
    // touched trace graph once per envelope before the assembly helpers mutate it.
    function writableTrace(id: string): Trace | undefined {
      const trace = get().tracesById.get(id);
      const changes = runtime.changes;
      if (!changes.beforeSpans.has(id))
        changes.beforeSpans.set(id, new Set(trace?.spans.keys()));
      if (!trace || changes.mutableTraces.has(id)) return trace;
      changes.mutableTraces.add(id);
      return mutableCopy(trace);
    }
    return {
      eventsById: new Map(),

      pushEvent: async (input: SentryEvent & { event_id?: string }) => {
        const event = structuredClone(input);
        const generation = runtime.generation;
        if (!event.event_id) {
          event.event_id = generateUuidv4();
        }
        const changes = runtime.changes;
        changes.eventIds.add(event.event_id);
        if (event.contexts?.trace?.trace_id)
          changes.traceIds.add(event.contexts.trace.trace_id);
        if (isLogEvent(event))
          for (const [index, log] of (event.items ?? []).entries()) {
            changes.logIds.add(log.id || `${event.event_id}:log:${index}`);
            if (typeof log.trace_id === "string" && log.trace_id.trim())
              changes.traceIds.add(log.trace_id);
          }
        if (isProfileEvent(event) || isProfileChunkEvent(event))
          changes.hasProfiles = true;

        const { eventsById: _eventsById } = get();
        if (
          _eventsById.has(event.event_id) ||
          pendingIds.get(event.event_id) === generation
        )
          return;
        pendingIds.set(event.event_id, generation);
        let releaseError: (() => void) | undefined;
        try {
          if (isErrorEvent(event)) {
            // Enrichment stays concurrent, while error application follows wire
            // order. Cache hits and hook completion timing must not change trace
            // identity/status during replay. Synchronous non-errors still apply
            // immediately, before any enriched error resumes.
            const previousError = changes.errorCommit;
            changes.errorCommit = new Promise<void>((resolve) => {
              releaseError = resolve;
            });
            for (const exception of event.exception?.values ?? [])
              exception.stacktrace?.frames?.reverse();
            try {
              if (options.enrichStacktrace)
                await options.enrichStacktrace(event);
            } catch {
              // Source context is optional; a failed adapter must not drop captured telemetry.
            }
            await previousError;
            if (
              runtime.generation !== generation ||
              get().eventsById.has(event.event_id)
            )
              return;
          }

          event.timestamp = toTimestamp(
            event.timestamp ?? runtime.receivedAtMs / 1000,
          );
          if (event.start_timestamp) {
            event.start_timestamp = toTimestamp(event.start_timestamp);
          }

          if (event.type === "span") {
            event.span.start_timestamp = toTimestamp(
              event.span.start_timestamp,
            );
            event.span.timestamp = toTimestamp(event.span.timestamp);
          } else if (isTraceEvent(event)) {
            event.spans = event.spans?.map((span) => ({
              ...span,
              start_timestamp: toTimestamp(span.start_timestamp),
              timestamp: toTimestamp(span.timestamp),
            }));
          }

          if (isLogEvent(event) && event.items?.length) {
            const { logsById, logsByTraceId, tracesById } = get();
            const existingLogIds = new Set(logsById.keys());
            const { processedLogs } = processLogItems(event, existingLogIds);
            for (const log of processedLogs) changes.insertedLogs.add(log.id);

            // Update store with processed logs
            // Build up the Maps incrementally to avoid stale state capture
            const newLogsById = new Map(logsById);
            const newLogsByTraceId = new Map(logsByTraceId);
            const newTracesById = new Map(tracesById);

            for (const logItem of processedLogs) {
              newLogsById.set(logItem.id, logItem);

              if (
                typeof logItem.trace_id === "string" &&
                logItem.trace_id.trim()
              ) {
                const logSet = new Set(newLogsByTraceId.get(logItem.trace_id));
                logSet.add(logItem);
                newLogsByTraceId.set(logItem.trace_id, logSet);
                // A log batch carries trace IDs on its individual records, not
                // necessarily on the containing event. Keep log-only traces
                // discoverable until transactions or spans arrive later.
                if (Number.isFinite(logItem.timestamp)) {
                  const trace =
                    (changes.mutableTraces.has(logItem.trace_id)
                      ? newTracesById.get(logItem.trace_id)
                      : writableTrace(logItem.trace_id)) ??
                    initializeTrace({
                      ...event,
                      timestamp: logItem.timestamp,
                      start_timestamp: undefined,
                      contexts: { trace: { trace_id: logItem.trace_id } },
                    });
                  if (!newTracesById.has(logItem.trace_id))
                    changes.insertedTraces.add(logItem.trace_id);
                  changes.mutableTraces.add(logItem.trace_id);
                  trace.start_timestamp = Math.min(
                    trace.start_timestamp,
                    logItem.timestamp,
                  );
                  trace.timestamp = Math.max(
                    trace.timestamp,
                    logItem.timestamp,
                  );
                  newTracesById.set(logItem.trace_id, trace);
                }
              }
            }

            // Set state once with all accumulated changes
            set({
              logsById: newLogsById,
              logsByTraceId: newLogsByTraceId,
              tracesById: newTracesById,
            });
            if (runtime.generation !== generation) return;
          }

          const { eventsById } = get();
          const newEventIds = new Map(eventsById);
          newEventIds.set(event.event_id, event);
          changes.addedEvents++;
          changes.insertedEvents.add(event.event_id);
          set({ eventsById: newEventIds });
          if (runtime.generation !== generation) return;

          const traceCtx = event.contexts?.trace;
          if (traceCtx?.trace_id) {
            const { tracesById, profilesByTraceId, profileChunksByProfilerId } =
              get();
            const existingTrace = writableTrace(traceCtx.trace_id);

            // Initialize or get existing trace
            let trace = existingTrace ?? initializeTrace(event);
            if (!existingTrace) changes.insertedTraces.add(traceCtx.trace_id);
            changes.mutableTraces.add(traceCtx.trace_id);

            // Update timestamps for all events
            trace.start_timestamp = Math.min(
              event.start_timestamp ?? event.timestamp,
              trace.start_timestamp,
            );
            trace.timestamp = Math.max(event.timestamp, trace.timestamp);

            let mergedV2Profile: SentryProfileWithTraceMeta | undefined;

            if (isTraceEvent(event)) {
              // Process transaction event and update trace
              const result = processTransactionEvent(event, {
                existingTrace: trace,
                profilesByTraceId,
                profileChunksByProfilerId,
              });
              trace = result.trace;
              mergedV2Profile = result.mergedProfile;
            } else if (event.type === "span") {
              const result = processSpanEvent(event, {
                existingTrace: trace,
                profilesByTraceId,
                profileChunksByProfilerId,
              });
              trace = result.trace;
              mergedV2Profile = result.mergedProfile;
            } else if (isErrorEvent(event)) {
              // For error events, increment error count
              trace.errors += 1;
            }

            // Only real span changes can invalidate the graft's topology or
            // timing. Context-only errors/logs must not extend profile samples.
            if (isTraceEvent(event) || event.type === "span") {
              mergedV2Profile =
                continuousProfileForTrace(trace, profileChunksByProfilerId) ??
                mergedV2Profile;
              const profile =
                mergedV2Profile ?? profilesByTraceId.get(trace.trace_id);
              if (profile) graftProfileSpans(trace, profile);
            }

            // Update trace metadata and status for all events with trace context
            updateTraceMetadata(trace);

            if (traceCtx.status !== "ok") {
              trace.status = traceCtx.status;
            }

            // Always save trace to store (whether new or updated)
            const newTracesById = new Map(tracesById);
            newTracesById.set(trace.trace_id, trace);

            // If we merged a V2 profile, store it by trace_id so the UI can find it
            if (mergedV2Profile) {
              const newProfilesByTraceId = new Map(profilesByTraceId);
              newProfilesByTraceId.set(trace.trace_id, mergedV2Profile);
              set({
                tracesById: newTracesById,
                profilesByTraceId: newProfilesByTraceId,
              });
            } else {
              set({ tracesById: newTracesById });
            }
          }

          if (runtime.generation !== generation) return;
          if (isProfileEvent(event)) {
            const { profilesByTraceId, tracesById } = get();
            const newTracesById = new Map(tracesById);
            const transactions =
              event.transactions ??
              (event.transaction ? [event.transaction] : []);
            const traceIds = new Set(
              transactions.flatMap((transaction) =>
                typeof transaction === "string" ? [] : [transaction.trace_id],
              ),
            );
            for (const traceId of traceIds) {
              changes.traceIds.add(traceId);
              const trace = writableTrace(traceId);
              if (trace) newTracesById.set(traceId, trace);
            }
            const { profiles } = processProfileEvent(event, {
              tracesById: newTracesById,
            });

            // Update store with processed profiles
            const newProfilesByTraceId = new Map(profilesByTraceId);
            for (const { traceId, profile } of profiles) {
              newProfilesByTraceId.set(traceId, profile);
            }
            set({
              profilesByTraceId: newProfilesByTraceId,
              tracesById: newTracesById,
            });
          }

          // Handle V2 profile chunks (continuous profiling)
          if (isProfileChunkEvent(event)) {
            const { profileChunksByProfilerId, tracesById, profilesByTraceId } =
              get();
            const { chunk } = processProfileChunkEvent(event);

            // Update store with processed profile chunk
            const newProfileChunksByProfilerId = new Map(
              profileChunksByProfilerId,
            );
            const existingChunks =
              newProfileChunksByProfilerId.get(chunk.profiler_id) || [];

            // Check if this chunk already exists (by chunk_id)
            if (!existingChunks.some((c) => c.chunk_id === chunk.chunk_id)) {
              const updatedChunks = [...existingChunks, chunk];
              newProfileChunksByProfilerId.set(
                chunk.profiler_id,
                updatedChunks,
              );

              // All transactions and streamed segments linked to this profiler
              // must see every new chunk, even after their first successful graft.
              const newTracesById = new Map(tracesById);
              const newProfilesByTraceId = new Map(profilesByTraceId);
              for (const existingTrace of tracesById.values()) {
                const mergedProfile = continuousProfileForTrace(
                  existingTrace,
                  newProfileChunksByProfilerId,
                  chunk.profiler_id,
                );
                if (!mergedProfile) continue;
                changes.traceIds.add(existingTrace.trace_id);
                const trace = writableTrace(existingTrace.trace_id)!;
                graftProfileSpans(trace, mergedProfile);
                newTracesById.set(trace.trace_id, trace);
                newProfilesByTraceId.set(trace.trace_id, mergedProfile);
              }
              set({
                profileChunksByProfilerId: newProfileChunksByProfilerId,
                tracesById: newTracesById,
                profilesByTraceId: newProfilesByTraceId,
              });
            }
          }
        } finally {
          releaseError?.();
          if (pendingIds.get(event.event_id) === generation)
            pendingIds.delete(event.event_id);
        }
      },
      getEvents: () => [...get().eventsById.values()],
    };
  };
