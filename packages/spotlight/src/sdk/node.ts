import { stringifyValue } from "../telemetry/utils/stringifyValue.ts";
import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import type { Envelope } from "@sentry/core";
import type {
  BatchOptions,
  DiagnosticCode,
  IgnoreReason,
  IngestOptions,
} from "../telemetry/contracts.ts";
import { decodeEnvelope } from "../telemetry/envelope/codec.ts";
import {
  normalizeEnvelope,
  validateEnvelope,
} from "../telemetry/internal/envelopes.ts";
import {
  diagnostic,
  receipt,
  reportDiagnostic,
} from "../telemetry/internal/results.ts";
import { validateRetention } from "../telemetry/internal/retention.ts";
import { generateUuidv4 } from "../telemetry/uuid.ts";
import {
  type IngestResult,
  type TelemetryStore,
  type TelemetryStoreOptions,
  createTelemetryStore,
} from "./core.ts";

export type { TelemetrySnapshot } from "./core.ts";

export type TelemetryPipelineOptions = TelemetryStoreOptions & {
  decodedHistory?: {
    /** Maximum retained decoded payloads (default 500); zero disables storage. */
    maxEntries?: number;
    /** Total decoded payload history budget (default 32 MiB); zero disables storage. */
    maxBytes?: number;
  };
  /** Maximum input body size before decompression. Default: 8 MiB. */
  maxPayloadBytes?: number;
  /** Maximum body size after decompression. Default: 32 MiB. */
  maxDecodedBytes?: number;
};

export type TelemetryPayload = {
  body: Uint8Array | string;
  contentType?: string;
  encoding?: string;
  userAgent?: string;
  deliveryId?: string;
  signal?: AbortSignal;
};

export type DecodedPayload = { body: Buffer; contentType: string };
export type TelemetryPipeline = TelemetryStore & {
  ingestPayload(input: TelemetryPayload): Promise<IngestResult>;
  ingestPayloads(
    inputs: readonly TelemetryPayload[],
  ): Promise<readonly IngestResult[]>;
  getDecodedPayload(envelopeId: string): DecodedPayload | undefined;
};

const envelopeContentType = "application/x-sentry-envelope";
const compressedEncodings = new Set(["gzip", "deflate", "br"]);

function limit(name: string, value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
    );
  }
  return value;
}

/** Decode bounded serialized Sentry envelopes, then process them through the shared telemetry store. */
export function createTelemetryPipeline(
  options: TelemetryPipelineOptions = {},
): TelemetryPipeline {
  const maxHistoryEntries = limit(
    "decodedHistory.maxEntries",
    options.decodedHistory?.maxEntries ?? 500,
    true,
  );
  const maxHistoryBytes = limit(
    "decodedHistory.maxBytes",
    options.decodedHistory?.maxBytes ?? 32 * 1024 * 1024,
    true,
  );
  const maxPayloadBytes = limit(
    "maxPayloadBytes",
    options.maxPayloadBytes ?? 8 * 1024 * 1024,
  );
  const maxDecodedBytes = limit(
    "maxDecodedBytes",
    options.maxDecodedBytes ?? 32 * 1024 * 1024,
  );
  const maxPending = limit("maxPending", options.maxPending ?? 64);
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? 32 * 1024 * 1024;
  const telemetry = createTelemetryStore(options);
  const decodedPayloads = new Map<string, DecodedPayload>();
  // null commits a parsed delivery or an oversized body without retaining raw bytes.
  const stagedPayloads = new Map<string, DecodedPayload | null>();
  const pending = new Set<Promise<unknown>>();
  const decodeControllers = new Set<AbortController>();
  const coreAdmissions = new Set<symbol>();
  const identities = new WeakMap<object, string>();
  let decodedBytes = 0;
  let generation = 0;
  let disposed = false;
  let queue = Promise.resolve();
  let pruning: Promise<void> | undefined;

  function retainDecodedPayload(
    envelopeId: string,
    payload: DecodedPayload | null,
  ) {
    const previous = decodedPayloads.get(envelopeId);
    if (previous) {
      decodedBytes -= previous.body.length;
      decodedPayloads.delete(envelopeId);
    }
    // Oversized individual payloads are processed but cannot enter the decoded history.
    if (
      !payload ||
      maxHistoryEntries === 0 ||
      payload.body.length > maxHistoryBytes ||
      maxHistoryBytes === 0
    )
      return;
    decodedPayloads.set(envelopeId, payload);
    decodedBytes += payload.body.length;
    while (
      decodedPayloads.size > maxHistoryEntries ||
      decodedBytes > maxHistoryBytes
    ) {
      const oldest = decodedPayloads.keys().next().value!;
      decodedBytes -= decodedPayloads.get(oldest)!.body.length;
      decodedPayloads.delete(oldest);
    }
  }

  // Register before public listeners so decoded history commits with the core snapshot.
  telemetry.subscribe((_snapshot, change) => {
    // An eviction can publish an existing ID while its redispatch is staged.
    // Only successful ingestion authorizes replacing decoded delivery bytes.
    if (change.type !== "ingest") return;
    for (const envelopeId of change.envelopeIds) {
      const payload = stagedPayloads.get(envelopeId);
      if (payload === undefined) continue;
      stagedPayloads.delete(envelopeId);
      retainDecodedPayload(envelopeId, payload);
    }
  });

  function ignored(reason: IgnoreReason): IngestResult {
    return receipt(
      { status: "ignored", reason },
      { revision: telemetry.getStats().revision },
    );
  }
  function invalid(code: DiagnosticCode, message: string): IngestResult {
    const item = diagnostic(code, message);
    reportDiagnostic(options.onDiagnostic, item);
    return receipt(
      { status: "invalid", diagnostics: [item] },
      { revision: telemetry.getStats().revision },
    );
  }

  async function processPayload(
    input: TelemetryPayload,
    body: Buffer,
    contentType: string,
    encoding: string | undefined,
    currentGeneration: number,
  ) {
    function cancelled(): IngestResult | undefined {
      if (disposed) return ignored("disposed");
      if (generation !== currentGeneration) return ignored("reset");
      if (input.signal?.aborted) return ignored("aborted");
      return undefined;
    }
    const initialCancellation = cancelled();
    if (initialCancellation) return initialCancellation;
    if (encoding && encoding !== "identity") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      decodeControllers.add(controller);
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        // zlib applies this bound while producing output, before a compressed bomb can expand in memory.
        const decodeOptions = {
          maxOutputLength: maxDecodedBytes,
          signal: controller.signal,
        };
        body = await new Promise<Buffer>((resolve, reject) => {
          const completed = (error: Error | null, output: Buffer) => {
            if (error) reject(error);
            else resolve(output);
          };
          switch (encoding) {
            case "gzip":
              gunzip(body, decodeOptions, completed);
              break;
            case "deflate":
              inflate(body, decodeOptions, completed);
              break;
            case "br":
              brotliDecompress(body, decodeOptions, completed);
              break;
            default:
              reject(new Error("Unsupported content encoding"));
          }
        });
      } catch (error) {
        const cancellation = cancelled();
        if (cancellation) return cancellation;
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ERR_BUFFER_TOO_LARGE"
        ) {
          return invalid(
            "decoded_payload_too_large",
            "Decoded envelope exceeds maxDecodedBytes",
          );
        }
        return invalid(
          "decompression_failed",
          "Could not decompress the envelope body",
        );
      } finally {
        decodeControllers.delete(controller);
        input.signal?.removeEventListener("abort", abort);
      }
    }
    const cancellation = cancelled();
    if (cancellation) return cancellation;
    if (body.length > maxDecodedBytes)
      return invalid(
        "decoded_payload_too_large",
        "Decoded envelope exceeds maxDecodedBytes",
      );
    let parseFailed = false;
    let envelope: ReturnType<typeof decodeEnvelope> = null;
    try {
      envelope = decodeEnvelope(
        body,
        input.userAgent,
        () => {
          parseFailed = true;
        },
        true,
      );
    } catch {
      parseFailed = true;
    }
    if (!envelope || parseFailed)
      return invalid(
        "invalid_envelope",
        "Malformed serialized Sentry envelope",
      );
    // Normalize the codec's legacy UUID object before staging; the core publishes this exact string ID.
    const envelopeId =
      input.deliveryId ?? envelope[0].__spotlight_envelope_id.toString();
    const parsedEnvelope = envelope as Envelope;
    parsedEnvelope[0].__spotlight_envelope_id = envelopeId;
    const payload =
      maxHistoryEntries > 0 &&
      maxHistoryBytes > 0 &&
      body.length <= maxHistoryBytes
        ? { body, contentType }
        : null;
    stagedPayloads.set(envelopeId, payload);
    try {
      const result = await withCoreAdmission(() =>
        telemetry.ingestEnvelope(parsedEnvelope, {
          deliveryId: input.deliveryId,
          signal: input.signal,
        }),
      );
      const retainPayload =
        result.status === "processed" ||
        (result.status === "ignored" && result.reason === "unsupported_items");
      if (
        retainPayload &&
        "envelopeId" in result &&
        result.envelopeId &&
        !cancelled() &&
        stagedPayloads.get(envelopeId) === payload
      ) {
        // Raw history is independent of processed retention, including immediate age/byte eviction.
        retainDecodedPayload(result.envelopeId, payload);
      }
      return result;
    } finally {
      if (stagedPayloads.get(envelopeId) === payload)
        stagedPayloads.delete(envelopeId);
    }
  }

  async function withCoreAdmission<T>(work: () => Promise<T>): Promise<T> {
    const admission = Symbol();
    coreAdmissions.add(admission);
    try {
      return await work();
    } finally {
      coreAdmissions.delete(admission);
    }
  }

  type PreparedEnvelope = { envelope: Envelope; options: IngestOptions };
  function prepareEnvelope(
    input: unknown,
    inputOptions: IngestOptions = {},
  ): PreparedEnvelope | IngestResult {
    const captured = {
      deliveryId: inputOptions.deliveryId,
      signal: inputOptions.signal,
    };
    if (captured.signal?.aborted) return ignored("aborted");
    if (
      captured.deliveryId !== undefined &&
      (typeof captured.deliveryId !== "string" || !captured.deliveryId.trim())
    ) {
      return invalid(
        "invalid_delivery_id",
        "deliveryId must be a non-empty string.",
      );
    }
    if (!validateEnvelope(input)) {
      return invalid(
        "invalid_envelope",
        "Expected a parsed envelope [headers, [[itemHeaders, payload], ...]].",
      );
    }
    try {
      // Clones need an explicit stable ID: the core cannot associate a fresh clone with its original object.
      const id =
        captured.deliveryId ??
        stringifyValue(
          input[0].__spotlight_envelope_id ??
            identities.get(input) ??
            generateUuidv4(),
        );
      identities.set(input, id);
      const envelope = normalizeEnvelope(input);
      envelope[0].__spotlight_envelope_id = id;
      if (
        Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxEnvelopeBytes
      ) {
        return invalid(
          "payload_too_large",
          "Parsed envelope exceeds maxEnvelopeBytes.",
        );
      }
      return { envelope, options: captured };
    } catch {
      return invalid(
        "invalid_envelope",
        "Envelope data must be cloneable wire data.",
      );
    }
  }

  async function processEnvelope(
    prepared: PreparedEnvelope,
    epoch: number,
  ): Promise<IngestResult> {
    if (disposed) return ignored("disposed");
    if (epoch !== generation) return ignored("reset");
    if (prepared.options.signal?.aborted) return ignored("aborted");
    const envelopeId = String(prepared.envelope[0].__spotlight_envelope_id);
    stagedPayloads.set(envelopeId, null);
    try {
      return await withCoreAdmission(() =>
        telemetry.ingestEnvelope(prepared.envelope, prepared.options),
      );
    } finally {
      stagedPayloads.delete(envelopeId);
    }
  }

  function pendingCount() {
    // Core validation may synchronously notify before core admission increments its own count.
    // Every admitted Node job still occupies its slot throughout that callback.
    return Math.max(
      pending.size,
      telemetry.getStats().pending + pending.size - coreAdmissions.size,
    );
  }

  type PreparedPayload = {
    input: TelemetryPayload;
    body: Buffer;
    contentType: string;
    encoding?: string;
  };
  function preparePayload(
    input: TelemetryPayload,
  ): PreparedPayload | IngestResult {
    if (
      !input ||
      (typeof input.body !== "string" && !nodeTypes.isUint8Array(input.body))
    ) {
      return invalid(
        "invalid_body",
        "Envelope body must be a string or Uint8Array",
      );
    }
    if (input.signal?.aborted) return ignored("aborted");
    if (
      input.contentType !== undefined &&
      typeof input.contentType !== "string"
    ) {
      return invalid("invalid_content_type", "Content type must be a string");
    }
    const contentType = (input.contentType ?? envelopeContentType)
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType !== envelopeContentType)
      return ignored("unsupported_content_type");
    if (input.encoding !== undefined && typeof input.encoding !== "string") {
      return invalid(
        "unsupported_encoding",
        "Content encoding must be a string",
      );
    }
    const encoding = input.encoding?.trim().toLowerCase();
    if (
      encoding &&
      encoding !== "identity" &&
      !compressedEncodings.has(encoding)
    ) {
      return invalid(
        "unsupported_encoding",
        `Unsupported content encoding: ${encoding}`,
      );
    }
    const size =
      typeof input.body === "string"
        ? Buffer.byteLength(input.body, "utf8")
        : input.body.byteLength;
    if (size > maxPayloadBytes)
      return invalid(
        "payload_too_large",
        "Envelope body exceeds maxPayloadBytes",
      );
    if ((!encoding || encoding === "identity") && size > maxDecodedBytes) {
      return invalid(
        "decoded_payload_too_large",
        "Decoded envelope exceeds maxDecodedBytes",
      );
    }
    const body =
      typeof input.body === "string"
        ? Buffer.from(input.body, "utf8")
        : Buffer.from(input.body);
    return { input: { ...input }, body, contentType, encoding };
  }

  function enqueue<T>(work: (epoch: number) => Promise<T>): Promise<T> {
    const epoch = generation;
    const operation = queue.then(() => work(epoch));
    pending.add(operation);
    queue = operation.then(
      () => {},
      () => {},
    );
    const release = () => {
      pending.delete(operation);
    };
    void operation.then(release, release);
    return operation;
  }

  function ingestPayload(input: TelemetryPayload): Promise<IngestResult> {
    if (disposed) return Promise.resolve(ignored("disposed"));
    if (input?.signal?.aborted) return Promise.resolve(ignored("aborted"));
    if (pendingCount() >= maxPending)
      return Promise.resolve(ignored("queue_full"));
    // Standalone payload bytes and metadata are copied before the first await.
    const prepared = preparePayload(input);
    if ("status" in prepared) return Promise.resolve(prepared);
    return enqueue((epoch) =>
      processPayload(
        prepared.input,
        prepared.body,
        prepared.contentType,
        prepared.encoding,
        epoch,
      ),
    );
  }

  function ingestEnvelope(
    input: unknown,
    inputOptions: IngestOptions = {},
  ): Promise<IngestResult> {
    if (disposed) return Promise.resolve(ignored("disposed"));
    if (inputOptions.signal?.aborted)
      return Promise.resolve(ignored("aborted"));
    if (pendingCount() >= maxPending)
      return Promise.resolve(ignored("queue_full"));
    // Snapshot standalone parsed data before enqueueing while retaining the original object's delivery identity.
    const prepared = prepareEnvelope(input, inputOptions);
    if ("status" in prepared) return Promise.resolve(prepared);
    return enqueue((epoch) => processEnvelope(prepared, epoch));
  }

  function ingestEnvelopes(
    inputs: Iterable<unknown>,
    batchOptions: BatchOptions = {},
  ): Promise<readonly IngestResult[]> {
    const signal = batchOptions.signal;
    const rejected = disposed
      ? "disposed"
      : pendingCount() >= maxPending
        ? "queue_full"
        : undefined;
    if (rejected)
      return Promise.resolve(
        Object.freeze(Array.from(inputs, () => ignored(rejected))),
      );
    return enqueue(async (epoch) => {
      const results: IngestResult[] = [];
      for (const input of inputs) {
        if (disposed) results.push(ignored("disposed"));
        else if (epoch !== generation) results.push(ignored("reset"));
        else {
          const prepared = prepareEnvelope(input, { signal });
          results.push(
            "status" in prepared
              ? prepared
              : await processEnvelope(prepared, epoch),
          );
        }
      }
      return Object.freeze(results);
    });
  }

  return {
    ...telemetry,
    ingestEnvelope,
    ingestEnvelopes,
    ingestPayload,
    ingestPayloads(inputs) {
      const rejected = disposed
        ? "disposed"
        : pendingCount() >= maxPending
          ? "queue_full"
          : undefined;
      const entries = Array.from(inputs);
      if (rejected)
        return Promise.resolve(
          Object.freeze(entries.map(() => ignored(rejected))),
        );
      // One admitted queue operation keeps every batch entry ahead of later payload calls.
      // Prepare each entry when reached so a large batch cannot allocate unbounded byte copies.
      return enqueue(async (epoch) => {
        const results: IngestResult[] = [];
        for (const input of entries) {
          if (disposed) results.push(ignored("disposed"));
          else if (epoch !== generation) results.push(ignored("reset"));
          else {
            const prepared = preparePayload(input);
            results.push(
              "status" in prepared
                ? prepared
                : await processPayload(
                    prepared.input,
                    prepared.body,
                    prepared.contentType,
                    prepared.encoding,
                    epoch,
                  ),
            );
          }
        }
        return Object.freeze(results);
      });
    },
    getDecodedPayload(envelopeId) {
      const payload = decodedPayloads.get(envelopeId);
      return (
        payload && {
          body: Buffer.from(payload.body),
          contentType: payload.contentType,
        }
      );
    },
    getStats() {
      const stats = telemetry.getStats();
      return Object.freeze({ ...stats, pending: pendingCount() });
    },
    async drain() {
      // Capture both barriers now: work submitted after this call cannot extend the drain.
      const wireBarrier = queue;
      const coreBarrier = telemetry.drain();
      await Promise.all([wireBarrier, coreBarrier]);
    },
    setRetention(update) {
      if (disposed) return Promise.resolve();
      const next = validateRetention(update);
      const epoch = generation;
      // Retention changes share payload ordering without consuming an admission slot.
      const operation = queue.then(async () => {
        if (!disposed && epoch === generation)
          await telemetry.setRetention(next);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    prune() {
      if (disposed) return Promise.resolve();
      if (pruning) return pruning;
      const epoch = generation;
      // A single control continuation does not consume an ingestion admission slot.
      const operation = queue.then(async () => {
        if (!disposed && epoch === generation) await telemetry.prune();
      });
      queue = operation.catch(() => {});
      pruning = operation;
      const release = () => {
        if (pruning === operation) pruning = undefined;
      };
      void operation.then(release, release);
      return operation;
    },
    reset() {
      generation += 1;
      pruning = undefined;
      queue = Promise.resolve();
      pending.clear();
      coreAdmissions.clear();
      for (const controller of decodeControllers) controller.abort();
      decodedPayloads.clear();
      stagedPayloads.clear();
      decodedBytes = 0;
      telemetry.reset();
    },
    dispose() {
      disposed = true;
      pruning = undefined;
      generation += 1;
      queue = Promise.resolve();
      pending.clear();
      coreAdmissions.clear();
      for (const controller of decodeControllers) controller.abort();
      decodedPayloads.clear();
      stagedPayloads.clear();
      decodedBytes = 0;
      telemetry.dispose();
    },
  };
}
