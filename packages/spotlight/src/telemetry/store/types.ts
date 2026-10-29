import type { Envelope } from "@sentry/core";
import type { Sdk, SentryEvent, SentryLogEventItem, Trace } from "../types.ts";
import type { ProcessedProfileChunk } from "./utils/profileChunkProcessor.ts";

import type { SentryProfileWithTraceMeta } from "../types.ts";
export type { SentryProfileWithTraceMeta } from "../types.ts";

export interface EventsSliceState {
  eventsById: Map<string, SentryEvent>;
}

export interface EventsSliceActions {
  pushEvent: (event: SentryEvent & { event_id?: string }) => Promise<void>;
  getEvents: () => SentryEvent[];
}

export interface TracesSliceState {
  tracesById: Map<string, Trace>;
}

export interface TracesSliceActions {
  getTraces: () => Trace[];
}

export interface ProfilesSliceState {
  /** Final merged profiles keyed by trace_id - works for both V1 and V2 */
  profilesByTraceId: Map<string, SentryProfileWithTraceMeta>;
  /** Internal: V2 chunks being accumulated, keyed by profiler_id */
  profileChunksByProfilerId: Map<string, ProcessedProfileChunk[]>;
}

export interface EnvelopesSliceState {
  envelopes: Map<string, Envelope>;
}

export interface EnvelopesSliceActions {
  ingestEnvelope: (params: Envelope) => Promise<number>;
  getEnvelopes: () => Array<Envelope>;
}

export interface SDKsSliceState {
  sdks: Map<string, Sdk>;
}

export interface LogsSliceState {
  logsById: Map<string, SentryLogEventItem>;
  logsByTraceId: Map<string, Set<SentryLogEventItem>>;
}

export interface LogsSliceActions {
  getLogs: () => SentryLogEventItem[];
}

export interface SDKsSliceActions {
  inferSdkFromEvent: (event: SentryEvent) => Sdk;
  storeSdkRecord: (sdk: Sdk) => Sdk;
  getSdks: () => Sdk[];
}

export interface SharedSliceActions {
  resetData: () => void;
}

export type SentryStoreState = EventsSliceState &
  TracesSliceState &
  ProfilesSliceState &
  EnvelopesSliceState &
  LogsSliceState &
  SDKsSliceState;

export type SentryStoreActions = EventsSliceActions &
  TracesSliceActions &
  EnvelopesSliceActions &
  LogsSliceActions &
  SDKsSliceActions &
  SharedSliceActions;

export type SentryStore = SentryStoreState & SentryStoreActions;
