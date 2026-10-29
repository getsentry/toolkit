import type { StateCreator } from "zustand/vanilla";
import type { ProfilesSliceState, SentryStore } from "../types.ts";

export const createProfilesSlice: StateCreator<
  SentryStore,
  [],
  [],
  ProfilesSliceState
> = () => ({
  profilesByTraceId: new Map(),
  profileChunksByProfilerId: new Map(),
});
