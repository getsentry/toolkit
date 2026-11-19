/** Bounded HTTP decoding and raw delivery identity for the Local receiver. */
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import type { Context } from "hono";
import { logger } from "../../lib/logger.js";
import {
  createReceiverEnvelope,
  envelopeEventId,
  readEnvelopeHeader,
  type ReceiverBuffer,
  withoutDsnHeader,
  withoutOwnDeliveries,
} from "./envelope.js";
export {
  createReceiverEnvelope,
  prepareReceiverEnvelope,
  receiverEnvelopeId,
  receiverEnvelopeReceivedAt,
  type ReceiverBuffer,
  type ReceiverEnvelope,
} from "./envelope.js";
export const MAX_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_PENDING = 64;
const CONTENT_TYPE = "application/x-sentry-envelope";
type ReceiverState = {
  generation: number;
  queue: Promise<unknown>;
  pending: Set<Promise<unknown>>;
  /** Requests still reading their body or reporting their status. */
  requests: Set<Promise<unknown>>;
};
/**
 * An accepted envelope gets Relay's body. SDKs such as sentry-elixir accept a
 * delivery only on HTTP 200 with this JSON, and retry anything else.
 */
type ReceiverAccepted = { status: 200; body: { id?: string } };
/** A body that is not an envelope: its JSON has the shape of Local's 410 body. */
type ReceiverRejected = { status: 400; body: { error: string } };
/** How the receiver answers a delivery: a JSON response or a bare status. */
export type IngestResult =
  | ReceiverAccepted
  | ReceiverRejected
  | 400
  | 410
  | 413
  | 415
  | 503;
const receivers = new WeakMap<ReceiverBuffer, ReceiverState>();
const oversizedListeners = new WeakMap<ReceiverBuffer, Set<() => void>>();

/** Call `listener` whenever this receiver rejects an oversized envelope. */
export function onOversizedEnvelope(
  buffer: ReceiverBuffer,
  listener: () => void,
): () => void {
  let listeners = oversizedListeners.get(buffer);
  if (!listeners) {
    listeners = new Set();
    oversizedListeners.set(buffer, listeners);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell this receiver's listeners when a delivery got HTTP 413. */
export function reportIngestStatus(
  buffer: ReceiverBuffer,
  result: IngestResult,
): void {
  if (result !== 413) return;
  for (const listener of oversizedListeners.get(buffer) ?? []) listener();
}

/** Answer an ingest request with its JSON body, or with the bare status. */
export function ingestResponse(c: Context, result: IngestResult): Response {
  if (typeof result === "object") return c.json(result.body, result.status);
  if (result === 503) c.header("Retry-After", "1");
  return c.body(null, result);
}

function rejected(error: string): ReceiverRejected {
  return { status: 400, body: { error } };
}

/** Stop consuming chunked input as soon as its encoded body exceeds the limit. */
export async function readReceiverBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer | 400 | 413> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return 413;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader
          .cancel()
          .catch(() => logger.debug("Local request body was already closed."));
        return 413;
      }
      chunks.push(value);
    }
  } catch {
    logger.debug("Local receiver could not read the request body.");
    return 400;
  } finally {
    reader.releaseLock();
  }
}

function stateFor(buffer: ReceiverBuffer): ReceiverState {
  const existing = receivers.get(buffer);
  if (existing) return existing;
  const state: ReceiverState = {
    generation: 0,
    queue: Promise.resolve(),
    pending: new Set(),
    requests: new Set(),
  };
  receivers.set(buffer, state);
  for (const method of ["clear", "reset"] as const) {
    const original = buffer[method].bind(buffer);
    buffer[method] = () => {
      state.generation++;
      original();
    };
  }
  return state;
}

/** Wait only for requests, writes, and controls admitted before this call. */
export async function drainReceiver(buffer: ReceiverBuffer): Promise<void> {
  const state = stateFor(buffer);
  await Promise.allSettled([...state.requests, ...state.pending, state.queue]);
}

/**
 * Count a request in this receiver's drain from its first body byte to its
 * status report, so a close waits to tell readers why a delivery it already
 * started reading was rejected.
 */
export function trackReceiverRequest<T>(
  buffer: ReceiverBuffer,
  request: () => Promise<T>,
): Promise<T> {
  const { requests } = stateFor(buffer);
  const operation = request();
  requests.add(operation);
  void operation.then(
    () => requests.delete(operation),
    () => requests.delete(operation),
  );
  return operation;
}

/** Keep retention updates between earlier writes and later admissions. */
export function withReceiverBarrier(
  buffer: ReceiverBuffer,
  update: () => void,
): Promise<void> {
  const state = stateFor(buffer);
  const operation = state.queue.then(update);
  state.queue = operation.catch(() =>
    logger.debug("Local receiver retention update was rejected."),
  );
  return operation;
}

/** Decode serially within a bounded queue; clear invalidates preceding admissions. */
export function ingestReceiverEnvelope(
  buffer: ReceiverBuffer,
  input: {
    body: Buffer;
    contentType?: string;
    encoding?: string | undefined;
    /** Drop the envelope header's `dsn`, which can carry a session capability. */
    dropDsnHeader?: boolean;
    /** URL the delivery was posted to, which identifies the receiver's own routes. */
    receiverUrl?: string;
    userAgent?: string | undefined;
    /**
     * Capture had stopped by the time the body finished arriving. The size
     * limits still apply first, so a late oversized delivery reports 413.
     */
    closed?: boolean;
  },
): Promise<Exclude<IngestResult, 400>> {
  const contentType = input.contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    contentType &&
    contentType !== "text/plain" &&
    contentType !== CONTENT_TYPE
  )
    return Promise.resolve(415);
  const encoding = input.encoding?.trim().toLowerCase();
  if (encoding && !["identity", "gzip", "deflate", "br"].includes(encoding))
    return Promise.resolve(415);
  const state = stateFor(buffer);
  if (state.pending.size >= MAX_PENDING) return Promise.resolve(503);
  const generation = state.generation;
  const operation = state.queue.then(
    async (): Promise<Exclude<IngestResult, 400 | 415>> => {
      if (generation !== state.generation) return 503;
      let body = input.body;
      if (encoding && encoding !== "identity") {
        try {
          body = await new Promise<Buffer>((resolve, reject) => {
            const completed = (error: Error | null, output: Buffer) => {
              if (error) reject(error);
              else resolve(output);
            };
            const options = { maxOutputLength: MAX_DECODED_BYTES };
            if (encoding === "gzip") gunzip(body, options, completed);
            else if (encoding === "deflate") inflate(body, options, completed);
            else brotliDecompress(body, options, completed);
          });
        } catch (error) {
          return typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ERR_BUFFER_TOO_LARGE"
            ? 413
            : rejected("The body could not be decompressed.");
        }
      }
      if (generation !== state.generation) return 503;
      if (body.length > MAX_DECODED_BYTES) return 413;
      if (input.closed) return 410;
      // Reject bodies that are not envelopes, as Relay does, and retain nothing.
      if (!body.length) return rejected("The envelope is empty.");
      const header = readEnvelopeHeader(body);
      if (!header) return rejected("The envelope header is not a JSON object.");
      const eventId = envelopeEventId(header.header);
      const accepted: ReceiverAccepted = {
        status: 200,
        body: eventId ? { id: eventId } : {},
      };
      if (input.dropDsnHeader) body = withoutDsnHeader(body, header);
      const delivery = input.receiverUrl
        ? withoutOwnDeliveries(body, input.receiverUrl)
        : body;
      // Envelopes with only Local's own delivery telemetry use no retention.
      if (!delivery) return accepted;
      buffer.put(
        createReceiverEnvelope({
          body: delivery,
          contentType: CONTENT_TYPE,
          userAgent: input.userAgent,
        }),
      );
      return accepted;
    },
  );
  state.pending.add(operation);
  state.queue = operation.catch(() =>
    logger.debug("Local receiver could not retain a delivery."),
  );
  void operation.then(
    () => state.pending.delete(operation),
    () => state.pending.delete(operation),
  );
  return operation;
}
