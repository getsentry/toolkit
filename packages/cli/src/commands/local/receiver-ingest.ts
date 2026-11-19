/** Bounded HTTP decoding and raw delivery identity for the Local receiver. */
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { logger } from "../../lib/logger.js";
import {
  createReceiverEnvelope,
  type ReceiverBuffer,
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
};
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
  status: number,
): void {
  if (status !== 413) return;
  for (const listener of oversizedListeners.get(buffer) ?? []) listener();
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

/** Wait only for writes and controls admitted before this call. */
export async function drainReceiver(buffer: ReceiverBuffer): Promise<void> {
  const state = stateFor(buffer);
  await Promise.allSettled([...state.pending, state.queue]);
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
    /** URL the delivery was posted to, which identifies the receiver's own routes. */
    receiverUrl?: string;
    userAgent?: string | undefined;
  },
): Promise<204 | 400 | 413 | 415 | 503> {
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
    async (): Promise<204 | 400 | 413 | 503> => {
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
            : 400;
        }
      }
      if (generation !== state.generation) return 503;
      if (body.length > MAX_DECODED_BYTES) return 413;
      const delivery = input.receiverUrl
        ? withoutOwnDeliveries(body, input.receiverUrl)
        : body;
      // Envelopes with only Local's own delivery telemetry use no retention.
      if (!delivery) return 204;
      buffer.put(
        createReceiverEnvelope({
          body: delivery,
          contentType: CONTENT_TYPE,
          userAgent: input.userAgent,
        }),
      );
      return 204;
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
