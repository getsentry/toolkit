/**
 * Custom Sentry SDK transport factory with zstd-first compression.
 *
 * Wraps `createTransport` from @sentry/core with a custom request executor
 * that compresses outgoing envelope bodies with zstd level 3 (libzstd
 * default). When running on a host without zstd support (Node < 22.15,
 * where `node:zlib` lacks the zstd APIs), falls back to gzip — matches
 * the SDK's default behavior byte-for-byte so there's no regression.
 *
 * Codec selection is one-shot, performed at factory-construction time.
 * No per-request branching: if `node:zlib` zstd support is available
 * when the transport is created, every envelope uses zstd; otherwise
 * every envelope uses gzip.
 *
 * This mirrors `@sentry/node-core/transports/http.js` `makeNodeTransport`
 * — URL parsing, `no_proxy` handling, proxy agent, CA certs, keepAlive,
 * IPv6 hostname unwrapping, rate-limit response header normalization —
 * but swaps out the gzip-via-stream-pipe for an async one-shot compress
 * that sets the correct `Content-Encoding`.
 *
 * Why not patch the SDK:
 *   `Sentry.init({ transport })` is a first-class extension point on
 *   the Client. Going via a custom factory avoids patch-file maintenance
 *   across SDK upgrades and avoids the gzip→gunzip→zstd waste that an
 *   `httpModule` shim would incur (the SDK has already piped the body
 *   through `createGzip()` by the time `httpModule.request()` runs).
 */

// biome-ignore lint/performance/noNamespaceImport: http module must be passed as a namespace object (matches SDK's HTTPModule interface)
import * as http from "node:http";
// biome-ignore lint/performance/noNamespaceImport: same as above for https
import * as https from "node:https";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  gzip as gzipCb,
  constants as zlibConstants,
  zstdCompress as zstdCompressCb,
} from "node:zlib";
import {
  createTransport,
  suppressTracing,
  type Transport,
  type TransportMakeRequestResponse,
  type TransportRequest,
  type TransportRequestExecutor,
} from "@sentry/core";
import {
  makeNodeTransport,
  type NodeTransportOptions,
} from "@sentry/node-core/light";

/** Codec actually applied to a given envelope. */
type AppliedEncoding = "zstd" | "gzip" | "none";

/** Codec the transport will attempt; "none" only happens under threshold. */
type SelectedEncoding = "zstd" | "gzip";

/**
 * zstd compression level. L3 is libzstd's default and was confirmed
 * optimal for telemetry-sized payloads (1–30 KiB) by an offline
 * benchmark before merge: L3–L6 sit on the same ratio-vs-time curve,
 * and L3 wins on compress time without losing ratio. Higher levels
 * (≥9) regress compress time without meaningful ratio gains.
 */
const ZSTD_LEVEL = 3;

/**
 * Minimum body length above which we attempt compression.
 *
 * For zstd we lower this from the SDK's 32 KiB gzip threshold to 1 KiB
 * — Bun's zstd worker is cheap to dispatch and most error envelopes
 * (5–15 KiB) would miss the 32 KiB cutoff and ship uncompressed
 * otherwise.
 */
const ZSTD_THRESHOLD = 1024;

/**
 * Matches the SDK default. Kept identical to avoid any byte-level
 * regression when the zstd fast path is unavailable.
 */
const GZIP_THRESHOLD = 1024 * 32;

const gzipAsync = promisify(gzipCb);
// zstdCompress is only present on Node.js 22.15+. On older runtimes (where the
// npm package falls back to the WASM SQLite driver) it's undefined, and
// promisify(undefined) throws at import time — crashing the whole CLI. Guard it;
// callers gate every use behind hasZstdSupport() so null is never invoked.
const zstdCompressAsync =
  typeof zstdCompressCb === "function" ? promisify(zstdCompressCb) : null;

/**
 * Factory for the SDK's `Sentry.init({ transport })` option.
 *
 * Falls back to `makeNodeTransport` when a proxy is configured (the SDK
 * owns CONNECT tunneling) or when the DSN URL is unparseable. Otherwise
 * picks a one-shot codec — zstd if available, gzip otherwise — and
 * wires up an executor.
 */
export function makeCompressedTransport(
  options: NodeTransportOptions
): Transport {
  let urlSegments: URL;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    urlSegments = new URL(options.url);
  } catch {
    return createTransport(options, () => Promise.resolve({}));
  }

  if (shouldFallbackToDefault(urlSegments, options)) {
    return makeNodeTransport(options);
  }

  const isHttps = urlSegments.protocol === "https:";
  const nativeHttpModule = isHttps ? https : http;
  const keepAlive = options.keepAlive ?? false;
  const agent = new nativeHttpModule.Agent({
    keepAlive,
    maxSockets: 30,
    timeout: 2000,
  });
  const httpModule = options.httpModule ?? nativeHttpModule;
  const encoding: SelectedEncoding = hasZstdSupport() ? "zstd" : "gzip";
  const hostnameIsIPv6 = urlSegments.hostname.startsWith("[");
  const hostname = hostnameIsIPv6
    ? urlSegments.hostname.slice(1, -1)
    : urlSegments.hostname;
  const path = `${urlSegments.pathname}${urlSegments.search}`;

  const executor: TransportRequestExecutor = (request: TransportRequest) =>
    new Promise<TransportMakeRequestResponse>((resolve, reject) => {
      suppressTracing(() => {
        performRequest({
          request,
          options,
          httpModule,
          agent,
          encoding,
          hostname,
          path,
          port: urlSegments.port,
          protocol: urlSegments.protocol,
        })
          .then(resolve)
          .catch(reject);
      });
    });

  return createTransport(options, executor);
}

/**
 * True iff a proxy is configured for this URL and not exempted by
 * no_proxy. When true, the caller falls back to the SDK's default
 * transport (which handles CONNECT tunneling).
 *
 * Mirrors `@sentry/node-core/transports/http.js` `applyNoProxyOption`'s
 * proxy-resolution priority:
 *   - http  → `options.proxy` | `http_proxy`
 *   - https → `options.proxy` | `https_proxy` | `http_proxy`
 *
 * Both upper- and lowercase env vars are recognized so behavior matches
 * cURL / Node ecosystem convention. Lowercase wins when both are set,
 * staying consistent with the SDK and {@link isNoProxyExempt}.
 *
 * @internal Exported for tests.
 */
export function shouldFallbackToDefault(
  url: URL,
  options: NodeTransportOptions
): boolean {
  const isHttps = url.protocol === "https:";
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
  const envProxy = isHttps ? httpsProxy : httpProxy;
  // SDK precedent: HTTPS falls back to http_proxy as a last resort.
  const proxy = options.proxy || envProxy || httpProxy;
  if (!proxy) {
    return false;
  }
  return !isNoProxyExempt(url);
}

type PerformRequestArgs = {
  request: TransportRequest;
  options: NodeTransportOptions;
  httpModule: NonNullable<NodeTransportOptions["httpModule"]>;
  agent: http.Agent;
  encoding: SelectedEncoding;
  hostname: string;
  path: string;
  port: string;
  protocol: string;
};

async function performRequest(
  args: PerformRequestArgs
): Promise<TransportMakeRequestResponse> {
  const { request, options, httpModule, agent, encoding } = args;

  const rawBuffer = normalizeBody(request.body);
  const { payload, encodingApplied } = await maybeCompress(rawBuffer, encoding);

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (encodingApplied !== "none") {
    headers["content-encoding"] = encodingApplied;
  }

  return new Promise<TransportMakeRequestResponse>((resolve, reject) => {
    const req = httpModule.request(
      {
        method: "POST",
        agent,
        headers,
        hostname: args.hostname,
        path: args.path,
        port: args.port,
        protocol: args.protocol,
        ca: options.caCerts,
      },
      (res) => {
        // Drain the response body
        res.on("data", drain);
        res.on("end", drain);
        res.setEncoding("utf8");
        const retryAfterHeader = res.headers["retry-after"] ?? null;
        const rateLimitsHeader = res.headers["x-sentry-rate-limits"] ?? null;
        resolve({
          statusCode: res.statusCode,
          headers: {
            "retry-after": Array.isArray(retryAfterHeader)
              ? (retryAfterHeader[0] ?? null)
              : retryAfterHeader,
            "x-sentry-rate-limits": Array.isArray(rateLimitsHeader)
              ? (rateLimitsHeader[0] ?? null)
              : rateLimitsHeader,
          },
        });
      }
    );
    req.on("error", reject);
    Readable.from(payload).pipe(req);
  });
}

/** No-op used to drain HTTP response bodies. */
function drain(): void {
  // intentionally empty
}

/**
 * Coerce `string | Uint8Array` into a contiguous Buffer (zero-copy for
 * Uint8Array; UTF-8 encoded for strings).
 *
 * @internal Exported for tests.
 */
export function normalizeBody(body: string | Uint8Array): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body, "utf-8");
  }
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

type CompressResult = {
  payload: Buffer;
  encodingApplied: AppliedEncoding;
};

/**
 * Apply the pre-selected codec iff the body is large enough to benefit.
 * Under threshold → passthrough with `encoding: "none"` (matches SDK
 * default behavior).
 *
 * @internal Exported for tests.
 */
export async function maybeCompress(
  buf: Buffer,
  encoding: SelectedEncoding
): Promise<CompressResult> {
  const threshold = encoding === "zstd" ? ZSTD_THRESHOLD : GZIP_THRESHOLD;
  if (buf.length <= threshold) {
    return { payload: buf, encodingApplied: "none" };
  }

  if (encoding === "zstd" && zstdCompressAsync) {
    const out = await zstdCompressAsync(buf, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
    });
    return {
      payload: Buffer.from(out.buffer, out.byteOffset, out.byteLength),
      encodingApplied: "zstd",
    };
  }

  const gz = await gzipAsync(buf);
  return { payload: gz, encodingApplied: "gzip" };
}

/** Feature-detect zstd support on the current runtime. */
export function hasZstdSupport(): boolean {
  return typeof zstdCompressCb === "function";
}

/**
 * Mirror the SDK's `applyNoProxyOption`: returns true iff the target
 * URL matches an entry in `NO_PROXY` / `no_proxy`, in which case the
 * proxy should be ignored.
 *
 * Slightly more permissive than the SDK:
 *   - Whitespace around comma-separated entries is trimmed
 *     (`"a.com, b.com"` is common; SDK does not trim).
 *   - The `"*"` wildcard means "bypass proxy for all hosts" — a
 *     convention from cURL / Go tooling that the SDK currently
 *     ignores (would route through the proxy regardless). We honor
 *     it so users with `no_proxy="*"` keep the zstd path.
 *
 * @internal Exported for tests.
 */
export function isNoProxyExempt(urlSegments: URL): boolean {
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY;
  if (!noProxy) {
    return false;
  }
  const entries = noProxy
    .split(",")
    .map((ex) => ex.trim())
    .filter((ex) => ex.length > 0);
  if (entries.includes("*")) {
    return true;
  }
  return entries.some(
    (ex) => urlSegments.host.endsWith(ex) || urlSegments.hostname.endsWith(ex)
  );
}
