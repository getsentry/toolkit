import type { StateCreator } from "zustand/vanilla";
import type { ProcessingRuntime } from "../../internal/types.ts";
import type { SentryStore, SharedSliceActions } from "../types.ts";

export const createSharedSlice =
  (
    runtime: ProcessingRuntime,
  ): StateCreator<SentryStore, [], [], SharedSliceActions> =>
  (set, get) => ({
    getEventById: (id: string) => get().eventsById.get(id),
    getTraceById: (id: string) => get().tracesById.get(id),
    getEventsByTrace: (traceId: string, spanId?: string | null) =>
      get()
        .getEvents()
        .filter((event) => {
          const trace = event.contexts?.trace;
          return (
            trace?.trace_id === traceId &&
            (spanId === undefined || trace.span_id === spanId)
          );
        }),
    resetData: () => {
      runtime.generation += 1;
      set({
        envelopes: new Map(),
        eventsById: new Map(),
        tracesById: new Map(),
        sdks: new Map(),
        profilesByTraceId: new Map(),
        profileChunksByProfilerId: new Map(),
        logsById: new Map(),
        logsByTraceId: new Map(),
      });
    },
  });
