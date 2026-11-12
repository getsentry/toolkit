/**
 * HTTP/1.1-only dispatchers for Node's global `fetch`.
 *
 * Node 26 bundles undici 8, which negotiates HTTP/2 by default
 * (`allowH2: true`), so parallel requests to one origin share a single
 * connection as HTTP/2 streams. Sentry's edge resets concurrent upload
 * streams on one connection with `ENHANCE_YOUR_CALM`: of N parallel
 * chunk-upload requests, only the last body to finish is accepted. Uploads
 * that send large bodies in parallel use an HTTP/1.1 dispatcher instead, so
 * each request gets its own connection, as the legacy sentry-cli (curl
 * without HTTP/2) did.
 *
 * The dispatcher is built from the class of the runtime's own global
 * dispatcher, so no undici dependency is bundled and the runtime's proxy
 * configuration (`EnvHttpProxyAgent` under `NODE_USE_ENV_PROXY`) still
 * applies. undici 7 and older (Node 24 and older) already default to
 * HTTP/1.1 and register only the version-1 symbol; Bun has no undici
 * dispatcher. Both get `undefined` and keep the default dispatcher.
 */

import { logger } from "./logger.js";

const log = logger.withTag("http");

/** undici ≥ 8 registers its global dispatcher under this symbol. */
const GLOBAL_DISPATCHER_V2 = Symbol.for("undici.globalDispatcher.2");

/** The part of an undici dispatcher the CLI uses: fetch's `dispatcher` and teardown. */
export type Http1Dispatcher = { destroy: () => Promise<void> };

type DispatcherClass = new (options: { allowH2: false }) => Http1Dispatcher;

/**
 * Create an HTTP/1.1-only dispatcher like the runtime's global one, or
 * `undefined` when the runtime's fetch does not use HTTP/2 by default (or
 * has no undici dispatcher). The caller must `destroy()` it after its
 * requests, or its keep-alive sockets hold the process open.
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

/**
 * Destroy a dispatcher from {@link createHttp1Dispatcher}. Never rejects:
 * it runs in a `finally`, where a teardown error would mask the upload's
 * own result.
 */
export async function destroyHttp1Dispatcher(
  dispatcher: Http1Dispatcher | undefined,
): Promise<void> {
  try {
    await dispatcher?.destroy();
  } catch (error) {
    log.debug("HTTP/1.1 dispatcher teardown failed", error);
  }
}
