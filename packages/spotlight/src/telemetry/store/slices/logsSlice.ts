import type { StateCreator } from "zustand/vanilla";
import type {
  LogsSliceActions,
  LogsSliceState,
  SentryStore,
} from "../types.ts";

export const createLogsSlice: StateCreator<
  SentryStore,
  [],
  [],
  LogsSliceState & LogsSliceActions
> = (_set, get) => ({
  logsById: new Map(),
  logsByTraceId: new Map(),
  getLogs: () => [...get().logsById.values()],
});
