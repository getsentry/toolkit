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

  getLogById: (id: string) => get().logsById.get(id),
  getLogs: () => Array.from(get().logsById.values()),
  getLogsByTraceId: (traceId: string) => {
    const logsByTraceId = get().logsByTraceId.get(traceId);
    return logsByTraceId ? Array.from(logsByTraceId) : [];
  },
});
