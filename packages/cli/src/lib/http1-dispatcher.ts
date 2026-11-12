/**
 * HTTP/1.1-only dispatchers for Node's global `fetch`.
 *
 * Node 26's fetch (undici 8) uses HTTP/2 by default, so parallel requests to
 * one origin share one connection. Sentry's edge resets all but one of the
 * concurrent upload streams on a connection with `ENHANCE_YOUR_CALM`, so
 * parallel uploads use HTTP/1.1 with one connection per request, as the
 * legacy sentry-cli did.
 *
 * The dispatcher is an instance of the runtime's own global dispatcher class,
 * so no undici dependency is bundled and `NODE_USE_ENV_PROXY` still applies.
 * undici 7 (Node 24) already uses HTTP/1.1; there the dispatcher only turns
 * off what is already off.
 */

import { logger } from "./logger.js";

const log = logger.withTag("http");

/** undici's global dispatcher symbol, set by Node 24 (undici 7) and Node 26 (undici 8). */
const GLOBAL_DISPATCHER_V2 = Symbol.for("undici.globalDispatcher.2");

/** An undici dispatcher, as `fetch` accepts it. */
export type Http1Dispatcher = NonNullable<RequestInit["dispatcher"]>;

type DispatcherClass = new (options: { allowH2: false }) => Http1Dispatcher;

/**
 * Create an HTTP/1.1-only dispatcher, or `undefined` when no undici global
 * dispatcher is registered or its class rejects the options. Destroy it
 * after use, or its keep-alive sockets hold the process open.
 *
 * Node loads undici, and registers the global dispatcher, on the first
 * `fetch`. Chunk uploads always follow the chunk-upload options request, so
 * the dispatcher is registered by the time this runs.
 */
export function createHttp1Dispatcher(): Http1Dispatcher | undefined {
  const registered = (globalThis as Record<PropertyKey, unknown>)[
    GLOBAL_DISPATCHER_V2
  ];
  const DispatcherCtor = (registered as { constructor?: unknown } | undefined)
    ?.constructor;
  if (typeof DispatcherCtor !== "function") {
    return;
  }
  try {
    return new (DispatcherCtor as DispatcherClass)({ allowH2: false });
  } catch (error) {
    log.debug("Could not create an HTTP/1.1 dispatcher; using default", error);
    return;
  }
}

/** Destroy a dispatcher. Never rejects, so it cannot mask the caller's result. */
export async function destroyHttp1Dispatcher(
  dispatcher: Http1Dispatcher | undefined,
): Promise<void> {
  try {
    await dispatcher?.destroy();
  } catch (error) {
    log.debug("HTTP/1.1 dispatcher teardown failed", error);
  }
}
