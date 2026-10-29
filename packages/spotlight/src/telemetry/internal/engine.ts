import { createStore } from "zustand/vanilla";
import { createEnvelopesSlice } from "../store/slices/envelopesSlice.ts";
import { createEventsSlice } from "../store/slices/eventsSlice.ts";
import { createLogsSlice } from "../store/slices/logsSlice.ts";
import { createProfilesSlice } from "../store/slices/profilesSlice.ts";
import { createSDKsSlice } from "../store/slices/sdksSlice.ts";
import { createSharedSlice } from "../store/slices/sharedSlice.ts";
import { createTracesSlice } from "../store/slices/tracesSlice.ts";
import type { SentryStore } from "../store/types.ts";

import type { EngineOptions, ProcessingRuntime } from "./types.ts";

export function createEngine(options: EngineOptions = {}) {
  const runtime: ProcessingRuntime = {
    generation: 0,
    receivedAtMs: Date.now(),
  };
  const store = createStore<SentryStore>()((...args) => ({
    ...createEventsSlice(options, runtime)(...args),
    ...createTracesSlice(...args),
    ...createProfilesSlice(...args),
    ...createEnvelopesSlice(runtime)(...args),
    ...createSDKsSlice(...args),
    ...createLogsSlice(...args),
    ...createSharedSlice(runtime)(...args),
  }));
  return { store, runtime };
}
