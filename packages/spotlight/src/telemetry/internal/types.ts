import type { SentryErrorEvent } from "../types.ts";
export type EngineOptions = {
  enrichStacktrace?: (event: SentryErrorEvent) => Promise<void>;
};
export type ProcessingRuntime = { generation: number; receivedAtMs: number };
