/**
 * Telemetry transport that keeps envelopes it fails to send.
 *
 * Wraps a transport factory (the zstd transport by default) with
 * `makeOfflineTransport` from `@sentry/core`, backed by the SQLite store in
 * `offline-store.ts`. The SDK stores an envelope whose send throws, which
 * includes the request deadline. It returns any HTTP response as is, so a
 * 4xx or 5xx is dropped, and it never stores client reports. Metrics
 * (`trace_metric`) aren't stored either: they are sent as usual and dropped
 * on failure. A long-running command emits runtime metrics every few
 * seconds, and old ones are worth little; stored, they would push sessions
 * and transactions out of the store's caps.
 *
 * On top of that:
 * - A per-transport circuit breaker. After the first network error or
 *   timeout, `shouldSend` returns false, so later envelopes go straight to
 *   the store with no network wait. With ingest stalled, a short command then
 *   waits for at most one request deadline on exit instead of one per round
 *   of sends. After {@link BREAKER_COOLDOWN_MS}, the next envelope is sent as
 *   a probe: a response closes the breaker and sends a batch of stored
 *   envelopes, and a failure opens it for another cooldown. Only long-running
 *   commands (`sentry mcp`, `sentry local`) live long enough to probe.
 * - {@link StoringTransport.sendStored}, which each run calls at startup, in
 *   place of the SDK's own retries. Those run from unref'd timers (5 s
 *   backoff, 100 ms after a success) that rarely fire before a short command
 *   exits, and could extend the exit when they do.
 */

import {
  envelopeContainsItemType,
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

/** Stored envelopes a run sends at startup, and after the breaker closes. */
export const STORED_ENVELOPES_PER_RUN = 10;

/**
 * How long the breaker stays open before a probe.
 *
 * Short commands never live this long, so they keep one deadline and then
 * disk. For a long-running process (`sentry mcp`, `sentry local`), a stalled
 * ingest costs one deadline-bound request every 5 minutes, and one batch of
 * {@link STORED_ENVELOPES_PER_RUN} stored envelopes goes out within 5 minutes
 * of ingest or the network coming back. The rest wait for later runs, so
 * each recovery adds a bounded amount of work.
 */
export const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Breaker state. `closed` sends; `open` stores until the cooldown since
 * `openedAt` ends; `probing` stores while the one probe is in flight.
 */
type BreakerState =
  | { kind: "closed" }
  | { kind: "open"; openedAt: number }
  | { kind: "probing" };

/** A transport that can also send envelopes stored by earlier runs. */
export type StoringTransport = Transport & {
  /**
   * Claim up to `limit` stored envelopes and send them in the background.
   * One that fails to send again goes back to the store with its original
   * age. Does nothing while the breaker is open.
   */
  sendStored(limit: number): void;
};

/**
 * Create the transport.
 *
 * @param options - Transport options from `Sentry.init`
 * @param makeTransport - Inner transport factory; carries the request deadline
 * @param now - Clock for the breaker cooldown, injectable for tests
 */
export function makeStoringTransport(
  options: NodeTransportOptions,
  makeTransport: (
    options: NodeTransportOptions,
  ) => Transport = makeCompressedTransport,
  now: () => number = Date.now,
): StoringTransport {
  const store = createEnvelopeStore();
  let breaker: BreakerState = { kind: "closed" };

  function shouldSend(): boolean {
    if (breaker.kind === "closed") {
      return true;
    }
    if (
      breaker.kind === "open" &&
      now() - breaker.openedAt >= BREAKER_COOLDOWN_MS
    ) {
      breaker = { kind: "probing" };
      return true;
    }
    return false;
  }

  function onFailure(reason: unknown): void {
    if (breaker.kind !== "open") {
      log.debug("Telemetry ingest unreachable; storing envelopes", reason);
    }
    breaker = { kind: "open", openedAt: now() };
  }

  function onResponse(): void {
    // Only the probe's answer closes the breaker. A request that started
    // while it was closed and answers after another one failed (say, in a
    // parallel drain batch) leaves it open, so one run never drains more
    // than one batch per recovery.
    if (breaker.kind !== "probing") {
      return;
    }
    breaker = { kind: "closed" };
    log.debug("Telemetry ingest reachable again; sending stored envelopes");
    sendStored(STORED_ENVELOPES_PER_RUN);
  }

  function sendStored(limit: number): void {
    if (breaker.kind !== "closed") {
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
            onFailure(error);
            throw error;
          }
          // Any response, even a 4xx or 5xx, means ingest is reachable. The
          // SDK records no outcome for a dropped 5xx, and the CLI's client
          // reports show network errors, not 5xx, as the real loss.
          onResponse();
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
    shouldSend,
    shouldStore: (envelope) =>
      !envelopeContainsItemType(envelope, ["trace_metric"]),
  });

  return {
    send: (envelope) => transport.send(envelope),
    flush: (timeout) => transport.flush(timeout),
    sendStored,
  };
}
