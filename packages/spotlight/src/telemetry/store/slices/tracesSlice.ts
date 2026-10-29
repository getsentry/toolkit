import type { StateCreator } from "zustand/vanilla";
import type {
  SentryStore,
  TracesSliceActions,
  TracesSliceState,
} from "../types.ts";

export const createTracesSlice: StateCreator<
  SentryStore,
  [],
  [],
  TracesSliceState & TracesSliceActions
> = (_, get) => ({
  tracesById: new Map(),

  getTraces: () => Array.from(get().tracesById.values()),
});
