/**
 * Telemetry transport that keeps envelopes it fails to send.
 *
 * Wraps a transport factory (the zstd transport by default) with
 * `makeOfflineTransport` from `@sentry/core`, backed by the SQLite store in
 * `offline-store.ts`. The SDK stores an envelope whose send throws, which
 * includes the request deadline, and returns any HTTP response as is, so a
 * 4xx is dropped. It never stores client reports.
 *
 * On top of that:
 * - A per-transport circuit breaker. After the first network error, timeout,
 *   or 5xx response, `shouldSend` returns false, so later envelopes go
 *   straight to the store with no network wait. With ingest stalled, the CLI
 *   then waits for at most one request deadline on exit instead of one per
 *   round of sends.
 * - {@link StoringTransport.sendStored}, which the next run calls at startup,
 *   in place of the SDK's own retries. Those run from unref'd timers (5 s
 *   backoff, 100 ms after a success) that rarely fire before a short command
 *   exits, and could extend the exit when they do.
 */

import {
  makeOfflineTransport,
  type Transport,
  type TransportMakeRequestResponse,
} from "@sentry/core";
import { logger } from "../logger.js";
import { createEnvelopeStore } from "./offline-store.js";
import {
  makeCompressedTransport,
  type NodeTransportOptions,
} from "./zstd-transport.js";

const log = logger.withTag("telemetry-store");

/** Stored envelopes a run sends at startup. */
export const STORED_ENVELOPES_PER_RUN = 10;

/** A transport that can also send envelopes stored by earlier runs. */
export type StoringTransport = Transport & {
  /**
   * Claim up to `limit` stored envelopes and send them in the background.
   * One that fails to send again goes back to the store with its original
   * age. Does nothing once the breaker is open.
   */
  sendStored(limit: number): void;
};

/**
 * Create the transport.
 *
 * @param options - Transport options from `Sentry.init`
 * @param makeTransport - Inner transport factory; carries the request deadline
 */
export function makeStoringTransport(
  options: NodeTransportOptions,
  makeTransport: (
    options: NodeTransportOptions,
  ) => Transport = makeCompressedTransport,
): StoringTransport {
  const store = createEnvelopeStore();
  let ingestDown = false;

  function markIngestDown(reason: unknown): void {
    if (!ingestDown) {
      ingestDown = true;
      log.debug("Telemetry ingest unreachable; storing envelopes", reason);
    }
  }

  const transport = makeOfflineTransport(
    (innerOptions: NodeTransportOptions) => {
      const inner = makeTransport(innerOptions);
      return {
        send: async (envelope): Promise<TransportMakeRequestResponse> => {
          let response: TransportMakeRequestResponse;
          try {
            response = await inner.send(envelope);
          } catch (error) {
            markIngestDown(error);
            throw error;
          }
          // The SDK returns 5xx responses like a 4xx, which would drop them,
          // but an overloaded or unreachable ingest answers 502/503 through
          // its load balancer. Throwing makes the SDK store the envelope.
          const status = response.statusCode ?? 0;
          if (status >= 500) {
            const error = new Error(`Telemetry ingest responded ${status}`);
            markIngestDown(error);
            throw error;
          }
          return response;
        },
        flush: (timeout) => inner.flush(timeout),
      };
    },
  )({
    ...options,
    createStore: () => ({
      push: store.push,
      unshift: store.push,
      // Stored envelopes are sent only by sendStored. The SDK's timers shift
      // one more after each success (and on a backoff after each failure);
      // one that fires during the exit flush starts a request that keeps the
      // process alive past it, and those can chain while others are in flight.
      shift: () => Promise.resolve(undefined),
    }),
    shouldSend: () => !ingestDown,
  });

  return {
    send: (envelope) => transport.send(envelope),
    flush: (timeout) => transport.flush(timeout),
    sendStored(limit) {
      if (ingestDown) {
        return;
      }
      for (const envelope of store.claim(limit)) {
        // Relay corrects item timestamps by the gap between `sent_at` and
        // when it received the envelope, so a stale `sent_at` would shift
        // them forward. The SDK's own retries reset it the same way.
        envelope[0].sent_at = new Date().toISOString();
        transport.send(envelope).then(undefined, (error: unknown) => {
          log.debug("Failed to resend stored telemetry", error);
        });
      }
    },
  };
}
