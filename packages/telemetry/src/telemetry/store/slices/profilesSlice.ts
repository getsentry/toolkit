import type { StateCreator } from "zustand/vanilla";
import { getProfileFunctionSummaries } from "../../selectors/profiles.ts";
import type {
  ProfilesSliceActions,
  ProfilesSliceState,
  SentryStore,
} from "../types.ts";

export const createProfilesSlice: StateCreator<
  SentryStore,
  [],
  [],
  ProfilesSliceState & ProfilesSliceActions
> = (_set, get) => ({
  profilesByTraceId: new Map(),
  profileChunksByProfilerId: new Map(),

  // Unified profile access - works for both V1 and merged V2 profiles
  getProfileByTraceId: (id: string) => get().profilesByTraceId.get(id),

  // Keep legacy field names private to the store adapter.
  getAggregateCallData: () =>
    getProfileFunctionSummaries(get().profilesByTraceId).map((summary) => ({
      name: summary.name,
      totalTime: summary.totalDurationMs,
      samples: summary.sampleCount,
      traceIds: summary.traceIds,
    })),
});
