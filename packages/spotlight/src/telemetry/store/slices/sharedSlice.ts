import type { StateCreator } from "zustand/vanilla";
import type { ProcessingRuntime } from "../../internal/types.ts";
import type { SentryStore, SharedSliceActions } from "../types.ts";

export const createSharedSlice =
  (
    runtime: ProcessingRuntime,
  ): StateCreator<SentryStore, [], [], SharedSliceActions> =>
  (set) => ({
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
