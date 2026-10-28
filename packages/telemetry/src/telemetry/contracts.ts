/** Machine-readable ingestion outcomes. Messages are explanatory, never control flow. */
export type DiagnosticCode =
  | "invalid_envelope"
  | "invalid_span"
  | "invalid_body"
  | "invalid_content_type"
  | "unsupported_encoding"
  | "decompression_failed"
  | "payload_too_large"
  | "decoded_payload_too_large"
  | "invalid_delivery_id"
  | "enrichment_failed"
  | "enrichment_timeout"
  | "subscriber_failed"
  | "unsupported_version";
export type Diagnostic = {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly severity: "warning" | "error";
  readonly itemIndex?: number;
  readonly spanIndex?: number;
};
export type IgnoreReason =
  | "duplicate"
  | "unsupported_items"
  | "unsupported_content_type"
  | "reset"
  | "disposed"
  | "aborted"
  | "queue_full";
export type IngestCounts = {
  readonly events: number;
  readonly spans: number;
  readonly logs: number;
  readonly skippedItems: number;
  readonly duplicateEvents: number;
};
export type ReceiptMetadata = {
  readonly revision: number;
  readonly retained: boolean;
  readonly counts: IngestCounts;
};
export type IngestOutcome =
  | {
      readonly status: "processed";
      readonly envelopeId: string;
      readonly diagnostics?: readonly Diagnostic[];
    }
  | {
      readonly status: "ignored";
      readonly reason: IgnoreReason;
      readonly envelopeId?: string;
      readonly diagnostics?: readonly Diagnostic[];
    }
  | { readonly status: "invalid"; readonly diagnostics: readonly Diagnostic[] };
export type IngestResult = ReceiptMetadata &
  (
    | {
        readonly status: "processed";
        readonly envelopeId: string;
        readonly diagnostics: readonly Diagnostic[];
      }
    | {
        readonly status: "ignored";
        readonly reason: IgnoreReason;
        readonly envelopeId?: string;
        readonly diagnostics: readonly Diagnostic[];
      }
    | {
        readonly status: "invalid";
        readonly diagnostics: readonly Diagnostic[];
      }
  );
export type IngestOptions = { deliveryId?: string; signal?: AbortSignal };
export type BatchOptions = Pick<IngestOptions, "signal">;
export type ChangeMetadata = {
  readonly type: "ingest" | "evict" | "reset" | "dispose";
  readonly revision: number;
  readonly envelopeIds: readonly string[];
};
export type IngestStats = {
  readonly pending: number;
  readonly retainedEnvelopes: number;
  readonly retainedBytes: number;
  readonly revision: number;
  readonly disposed: boolean;
};
