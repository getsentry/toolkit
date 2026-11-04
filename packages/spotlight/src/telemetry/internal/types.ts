import type { Sdk, SentryErrorEvent } from "../types.ts";
export type EngineOptions = {
  enrichStacktrace?: (event: SentryErrorEvent) => Promise<void>;
};
/** Only the current envelope's footprint; no retained-history scans for receipts. */
export function createEnvelopeChanges() {
  return {
    eventIds: new Set<string>(),
    logIds: new Set<string>(),
    traceIds: new Set<string>(),
    mutableTraces: new Set<string>(),
    beforeSpans: new Map<string, Set<string>>(),
    insertedEvents: new Set<string>(),
    insertedLogs: new Set<string>(),
    insertedTraces: new Set<string>(),
    errorCommit: Promise.resolve(),
    addedEvents: 0,
    hasProfiles: false,
    sdk: undefined as Sdk | undefined,
  };
}
export type ProcessingRuntime = {
  generation: number;
  receivedAtMs: number;
  changes: ReturnType<typeof createEnvelopeChanges>;
};
