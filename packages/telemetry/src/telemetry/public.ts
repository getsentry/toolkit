import type { Envelope, EnvelopeItem } from "@sentry/core";
import type {
  BatchOptions,
  ChangeMetadata,
  Diagnostic,
  IngestOptions,
  IngestResult,
  IngestStats,
} from "./contracts.ts";
import type { TelemetryReader } from "./reader.ts";
import type {
  ProfileFunctionSummary as InternalProfileFunctionSummary,
  QuerySummary as InternalQuerySummary,
  ResourceSummary as InternalResourceSummary,
} from "./selectors/index.ts";

import type {
  AITrace as InternalAITrace,
  Sdk,
  SentryErrorEvent,
  SentryEvent,
  SentryLogEventItem,
  SentryProfileWithTraceMeta,
  Span,
  Trace,
} from "./types.ts";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends readonly unknown[]
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

/** A parsed Sentry wire envelope; input timestamps retain their wire units. */
// Item payloads remain unknown: forward-compatible wire records include span-v2
// containers that older @sentry/core payload unions cannot represent.
export type SentryEnvelope = [Envelope[0], [EnvelopeItem[0], unknown][]];
export type ProcessedEvent = DeepReadonly<SentryEvent>;
export type ProcessedSpan = DeepReadonly<Span>;
export type ProcessedTrace = DeepReadonly<Trace>;
export type ProcessedLog = DeepReadonly<SentryLogEventItem>;
export type ProcessedProfile = DeepReadonly<SentryProfileWithTraceMeta>;
export type AITrace = DeepReadonly<InternalAITrace>;
export type QuerySummary = DeepReadonly<InternalQuerySummary>;
export type ResourceSummary = DeepReadonly<InternalResourceSummary>;
export type ProfileFunctionSummary =
  DeepReadonly<InternalProfileFunctionSummary>;
export type * from "./contracts.ts";
export type {
  TraceReadFilter as TraceFilter,
  EventReadFilter as EventFilter,
  DatabaseReadFilter as DatabaseQueryFilter,
} from "./reader.ts";
export type RetentionOptions = {
  /** Maximum retained envelopes, including all telemetry derived from them. Default: 500. */
  maxEnvelopes?: number;
  /** Optional maximum age since receipt. Expiration runs automatically; dispose releases the timer. */
  maxAgeMs?: number;
  /** Serialized retained-envelope budget. Default: 64 MiB. */
  maxBytes?: number;
};
export type TelemetryStoreOptions = {
  retention?: RetentionOptions;
  enrichStacktrace?: (
    event: SentryErrorEvent,
    context: { signal: AbortSignal },
  ) => Promise<void>;
  /** Maximum ingestion operations, including active work. Default: 64. Overflow returns ignored/queue_full. */
  maxPending?: number;
  /** Maximum serialized parsed envelope size. Default: 32 MiB. */
  maxEnvelopeBytes?: number;
  /** Optional enrichment deadline. Default: 5000 ms. */
  enrichmentTimeoutMs?: number;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
};
export type TelemetrySnapshot = {
  readonly revision: number;
  readonly envelopes: readonly DeepReadonly<SentryEnvelope>[];
  readonly events: readonly ProcessedEvent[];
  readonly traces: readonly ProcessedTrace[];
  readonly logs: readonly ProcessedLog[];
  readonly sdks: readonly DeepReadonly<Sdk>[];
  readonly profiles: ReadonlyMap<string, ProcessedProfile>;
};
export type TelemetryStore = TelemetryReader & {
  ingestEnvelope: (
    input: unknown,
    options?: IngestOptions,
  ) => Promise<IngestResult>;
  ingestEnvelopes: (
    inputs: Iterable<unknown>,
    options?: BatchOptions,
  ) => Promise<readonly IngestResult[]>;
  /** Wait for operations submitted before this call; future operations are excluded. */
  drain: () => Promise<void>;
  getStats: () => IngestStats;
  subscribe: (
    listener: (snapshot: TelemetrySnapshot, change: ChangeMetadata) => void,
  ) => () => void;
  reset: () => void;
  /** Update supplied limits, preserving omitted fields, then wait for retention eviction. */
  setRetention: (options: RetentionOptions) => Promise<void>;
  prune: () => Promise<void>;
  dispose: () => void;
};
