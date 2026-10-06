/**
 * Unit tests for {@link makeCompressedTransport}.
 *
 * Uses the SDK's `options.httpModule` extension point to inject a mock
 * that captures the bytes written to the ClientRequest and synthesizes
 * a response. We don't touch real sockets.
 *
 * Each scenario asserts on one of:
 *   1. the `content-encoding` header as observed on the wire,
 *   2. the compressed body round-tripping back to the input,
 *   3. rate-limit response headers surfacing correctly to the
 *      `createTransport` layer.
 */

import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { createEnvelope } from "@sentry/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  hasZstdSupport,
  isNoProxyExempt,
  makeCompressedTransport,
  maybeCompress,
  normalizeBody,
  shouldFallbackToDefault,
} from "../../../src/lib/telemetry/zstd-transport.js";

/** No-op for SDK callbacks that require a function but return nothing meaningful. */
function noop(): void {
  // intentionally empty
}

// ── Mock http module ─────────────────────────────────────────────────

type MockResponseShape = {
  statusCode: number;
  headers: IncomingHttpHeaders;
};

type CapturedRequest = {
  chunks: Buffer[];
  options: Record<string, unknown>;
};

/**
 * Build a fake {@link http} module that captures outbound body bytes and
 * resolves with a pre-canned response. The returned object exposes both
 * the shim and the capture buffer for test assertions.
 */
function buildMockHttpModule(response: MockResponseShape): {
  httpModule: {
    request: (opts: unknown, cb?: (res: unknown) => void) => ClientRequest;
  };
  captured: CapturedRequest;
} {
  const captured: CapturedRequest = { chunks: [], options: {} };
  const httpModule = {
    request: (opts: unknown, cb?: (res: unknown) => void) => {
      captured.options = opts as Record<string, unknown>;

      // The ClientRequest must behave as a Writable so that
      // `Readable.from(payload).pipe(req)` succeeds. We fake one from
      // an EventEmitter and expose `write`/`end` that push into the
      // captured buffer.
      const req = new EventEmitter() as unknown as ClientRequest & {
        write: (chunk: Buffer | string) => boolean;
        end: (chunk?: Buffer | string) => void;
      };
      req.write = (chunk: Buffer | string) => {
        captured.chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        );
        return true;
      };
      req.end = (chunk?: Buffer | string) => {
        if (chunk !== undefined) {
          captured.chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          );
        }
        // Fire the response on next tick so the caller has time to
        // finish piping before we resolve. The response object is a
        // minimal IncomingMessage-like shape that the transport's
        // handler uses.
        process.nextTick(() => {
          const res = Object.assign(new EventEmitter(), {
            statusCode: response.statusCode,
            headers: response.headers,
            setEncoding: noop,
          });
          cb?.(res);
          // Drive data/end events the transport listens to.
          process.nextTick(() => {
            res.emit("data", Buffer.alloc(0));
            res.emit("end");
          });
        });
      };
      return req;
    },
  };
  return { httpModule: httpModule as never, captured };
}

// ── Tests ────────────────────────────────────────────────────────────

const BASE_OPTIONS = {
  url: "https://ingest.example.com/api/0/envelope/",
  headers: { "x-sentry-auth": "Sentry sentry_key=abc" },
  recordDroppedEvent: noop,
};

describe("makeCompressedTransport", () => {
  test("zstd branch: sets Content-Encoding: zstd and round-trips", async () => {
    if (!hasZstdSupport()) {
      // On a runtime without zstd this test is meaningless.
      return;
    }
    const { httpModule, captured } = buildMockHttpModule({
      statusCode: 200,
      headers: {},
    });

    const transport = makeCompressedTransport({
      ...BASE_OPTIONS,
      httpModule,
    });

    // Build a large envelope — above ZSTD_THRESHOLD (1 KiB).
    const payload = "x".repeat(4096);
    const envelope: any = createEnvelope({} as any, [
      [{ type: "event" } as any, { data: payload } as any],
    ]);
    await transport.send(envelope);

    const headers = captured.options.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("zstd");

    const wire = Buffer.concat(captured.chunks);
    expect(wire.length).toBeGreaterThan(0);

    // Decompress and verify the payload body is present
    const decompressed = zstdDecompressSync(wire);
    const text = decompressed.toString("utf-8");
    expect(text).toContain(payload);
  });

  // Note: the "gzip fallback when zstd is absent" test was removed because
  // zstd is now provided by node:zlib (always available in Node 22.15+),
  // not by a removable globalThis.Bun.zstdCompress polyfill.

  test("below threshold: no content-encoding header", async () => {
    const { httpModule, captured } = buildMockHttpModule({
      statusCode: 200,
      headers: {},
    });

    const transport = makeCompressedTransport({
      ...BASE_OPTIONS,
      httpModule,
    });

    // Tiny envelope - well below 1 KiB zstd threshold
    const envelope: any = createEnvelope({} as any, [
      [{ type: "event" } as any, { tiny: "x" } as any],
    ]);
    await transport.send(envelope);

    const headers = captured.options.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBeUndefined();

    // The wire body should be exactly the serialized envelope
    const wire = Buffer.concat(captured.chunks);
    expect(wire.toString("utf-8")).toContain("event");
  });

  test("rate-limit response headers bubble up (string form)", async () => {
    const { httpModule } = buildMockHttpModule({
      statusCode: 429,
      headers: {
        "retry-after": "60",
        "x-sentry-rate-limits": "60:error:organization",
      },
    });

    const transport = makeCompressedTransport({
      ...BASE_OPTIONS,
      httpModule,
    });

    const envelope: any = createEnvelope({} as any, [
      [{ type: "event" } as any, { data: "small" } as any],
    ]);
    const response = await transport.send(envelope);

    expect(response.statusCode).toBe(429);
    expect(response.headers?.["retry-after"]).toBe("60");
    expect(response.headers?.["x-sentry-rate-limits"]).toBe(
      "60:error:organization"
    );
  });

  test("rate-limit response headers normalize array form", async () => {
    const { httpModule } = buildMockHttpModule({
      statusCode: 429,
      // Some proxies emit duplicate headers as arrays
      headers: {
        "retry-after": "30",
        "x-sentry-rate-limits": [
          "30:transaction:organization",
          "60:error:organization",
        ] as never,
      },
    });

    const transport = makeCompressedTransport({
      ...BASE_OPTIONS,
      httpModule,
    });

    const envelope: any = createEnvelope({} as any, [
      [{ type: "event" } as any, { data: "small" } as any],
    ]);
    const response = await transport.send(envelope);

    // Array collapsed to first element
    expect(response.headers?.["x-sentry-rate-limits"]).toBe(
      "30:transaction:organization"
    );
  });

  test("invalid URL: no-op transport returned", async () => {
    const transport = makeCompressedTransport({
      ...BASE_OPTIONS,
      url: "not a url",
    });
    const envelope: any = createEnvelope({} as any, [
      [{ type: "event" } as any, {} as any],
    ]);
    // No-op transport resolves with empty response, does not throw.
    const response = await transport.send(envelope);
    expect(response).toEqual({});
  });

  test("proxy configured: falls back to SDK's makeNodeTransport (no zstd applied)", async () => {
    const savedProxy = process.env.https_proxy;
    process.env.https_proxy = "http://proxy.internal:3128";
    try {
      // The SDK's makeNodeTransport also honors options.httpModule, so
      // we can route both paths through our mock and tell them apart by
      // the Content-Encoding header on the wire: the zstd path sets it
      // for any body > 1 KiB, while the SDK default only sets gzip for
      // bodies > 32 KiB. A 4 KiB body therefore distinguishes the two
      // — zstd path stamps "zstd", SDK path stamps nothing.
      const { httpModule, captured } = buildMockHttpModule({
        statusCode: 200,
        headers: {},
      });
      const transport = makeCompressedTransport({
        ...BASE_OPTIONS,
        httpModule,
      });
      const envelope: any = createEnvelope({} as any, [
        [{ type: "event" } as any, { data: "x".repeat(4096) } as any],
      ]);
      await transport.send(envelope);

      const headers = captured.options.headers as Record<string, string>;
      expect(headers["content-encoding"]).toBeUndefined();
      // And the wire body is the raw envelope (not zstd-compressed).
      const wire = Buffer.concat(captured.chunks);
      expect(wire.toString("utf-8")).toContain('"type":"event"');
    } finally {
      if (savedProxy === undefined) {
        delete process.env.https_proxy;
      } else {
        process.env.https_proxy = savedProxy;
      }
    }
  });

  test("network error on socket: promise rejects, nothing throws outward", async () => {
    // Mock http module whose request() emits an 'error' event instead of
    // responding. The executor's `req.on('error', reject)` must surface
    // it to the outer promise, which createTransport's wrapper catches
    // and records as network_error.
    const throwingMod = {
      request: (_opts: unknown, _cb?: unknown) => {
        const req = new EventEmitter() as unknown as ClientRequest & {
          write: (c: unknown) => boolean;
          end: () => void;
        };
        req.write = () => true;
        req.end = () => {
          process.nextTick(() => req.emit("error", new Error("ECONNREFUSED")));
        };
        return req;
      },
    };
    const transport = makeCompressedTransport({
      ...BASE_OPTIONS,
      httpModule: throwingMod as never,
    });
    const envelope: any = createEnvelope({} as any, [
      [{ type: "event" } as any, { data: "x".repeat(4096) } as any],
    ]);
    // createTransport wraps network errors and re-throws them — a real
    // API consumer would swallow this via .catch(). We just assert the
    // promise settles (does not hang) and throws an ECONNREFUSED.
    await expect(transport.send(envelope)).rejects.toThrow("ECONNREFUSED");
  });

  test("proxy configured + URL is no_proxy exempt: uses zstd transport", async () => {
    const savedProxy = process.env.https_proxy;
    const savedNoProxy = process.env.no_proxy;
    process.env.https_proxy = "http://proxy.internal:3128";
    process.env.no_proxy = "example.com";
    try {
      const { httpModule, captured } = buildMockHttpModule({
        statusCode: 200,
        headers: {},
      });
      const transport = makeCompressedTransport({
        ...BASE_OPTIONS,
        httpModule,
      });
      const envelope: any = createEnvelope({} as any, [
        [{ type: "event" } as any, { data: "small" } as any],
      ]);
      await transport.send(envelope);
      // httpModule was called → we took the zstd path, not the SDK
      // fallback (which would have ignored our httpModule mock and
      // tried to connect through the proxy).
      expect(captured.chunks.length).toBeGreaterThan(0);
    } finally {
      if (savedProxy === undefined) {
        delete process.env.https_proxy;
      } else {
        process.env.https_proxy = savedProxy;
      }
      if (savedNoProxy === undefined) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = savedNoProxy;
      }
    }
  });
});

// ── Direct helper tests ──────────────────────────────────────────────

describe("normalizeBody", () => {
  test("string → UTF-8 bytes", () => {
    const buf = normalizeBody("hello");
    expect(buf.toString("utf-8")).toBe("hello");
  });

  test("multi-byte UTF-8 string", () => {
    const buf = normalizeBody("café ☕");
    expect(buf.toString("utf-8")).toBe("café ☕");
  });

  test("Uint8Array → zero-copy Buffer view", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5]);
    const buf = normalizeBody(src);
    expect(buf.length).toBe(5);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });

  test("Uint8Array with non-zero byteOffset", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = new Uint8Array(backing.buffer, 2, 3);
    const buf = normalizeBody(view);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  test("empty string", () => {
    expect(normalizeBody("").length).toBe(0);
  });

  test("empty Uint8Array", () => {
    expect(normalizeBody(new Uint8Array(0)).length).toBe(0);
  });
});

describe("maybeCompress", () => {
  test("zstd + body above threshold → zstd-compressed", async () => {
    if (!hasZstdSupport()) {
      return;
    }
    const buf = Buffer.from("x".repeat(4096));
    const result = await maybeCompress(buf, "zstd");
    expect(result.encodingApplied).toBe("zstd");
    expect(result.payload.length).toBeLessThan(buf.length);
    const decompressed = zstdDecompressSync(result.payload);
    expect(decompressed.toString("utf-8")).toBe("x".repeat(4096));
  });

  test("zstd + body below 1 KiB threshold → passthrough", async () => {
    const buf = Buffer.from("x".repeat(512));
    const result = await maybeCompress(buf, "zstd");
    expect(result.encodingApplied).toBe("none");
    expect(result.payload).toBe(buf);
  });

  test("gzip + body above 32 KiB threshold → gzip-compressed", async () => {
    const buf = Buffer.from("y".repeat(64 * 1024));
    const result = await maybeCompress(buf, "gzip");
    expect(result.encodingApplied).toBe("gzip");
    expect(result.payload.length).toBeLessThan(buf.length);
    const decompressed = gunzipSync(result.payload);
    expect(decompressed.toString("utf-8")).toBe("y".repeat(64 * 1024));
  });

  test("gzip + body below 32 KiB threshold → passthrough", async () => {
    const buf = Buffer.from("z".repeat(16 * 1024));
    const result = await maybeCompress(buf, "gzip");
    expect(result.encodingApplied).toBe("none");
    expect(result.payload).toBe(buf);
  });

  // Note: the "zstd mid-flight missing" tests were removed because zstd
  // is now provided by node:zlib (always available), not a runtime polyfill
  // that could disappear between construction and first send.
});

describe("isNoProxyExempt", () => {
  let savedNoProxy: string | undefined;
  let savedNoProxyUpper: string | undefined;

  beforeEach(() => {
    savedNoProxy = process.env.no_proxy;
    savedNoProxyUpper = process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
  });

  afterEach(() => {
    if (savedNoProxy === undefined) {
      delete process.env.no_proxy;
    } else {
      process.env.no_proxy = savedNoProxy;
    }
    if (savedNoProxyUpper === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = savedNoProxyUpper;
    }
  });

  test("no env var set → not exempt", () => {
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(false);
  });

  test("suffix match in no_proxy → exempt", () => {
    process.env.no_proxy = "example.com,internal.lan";
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(true);
  });

  test("no match → not exempt", () => {
    process.env.no_proxy = "other.com";
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(false);
  });

  test("NO_PROXY (uppercase) also recognized", () => {
    process.env.NO_PROXY = "example.com";
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(true);
  });

  test("lowercase takes precedence over uppercase", () => {
    process.env.no_proxy = "other.com";
    process.env.NO_PROXY = "example.com";
    // Lowercase wins → uppercase ignored → no match → not exempt
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(false);
  });

  test("trims whitespace around comma-separated entries", () => {
    // Common config style: `"a.com, b.com"` — both entries should match
    // even with the leading space after the comma.
    process.env.no_proxy = "other.com, ingest.example.com";
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(true);
  });

  test("ignores empty entries (trailing comma, double comma)", () => {
    process.env.no_proxy = "other.com,, , example.com,";
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(true);
    // Empty entry must not match every host (would be true if `endsWith("")`
    // were ever evaluated).
    expect(isNoProxyExempt(new URL("https://other-host.test/"))).toBe(false);
  });

  test("'*' wildcard exempts all hosts", () => {
    process.env.no_proxy = "*";
    expect(isNoProxyExempt(new URL("https://ingest.example.com/"))).toBe(true);
    expect(isNoProxyExempt(new URL("https://anything.test/"))).toBe(true);
    expect(isNoProxyExempt(new URL("http://192.0.2.1:8080/"))).toBe(true);
  });

  test("'*' wildcard alongside other entries still exempts everything", () => {
    process.env.no_proxy = "specific.com, *, other.com";
    expect(isNoProxyExempt(new URL("https://unrelated.test/"))).toBe(true);
  });

  test("literal '*' in a host name does not get matched as wildcard", () => {
    // The wildcard check requires `*` to be a standalone entry.
    // A bizarre value like `"*.example.com"` is treated as a literal
    // suffix: `endsWith("*.example.com")` is false for normal hosts.
    process.env.no_proxy = "*.example.com";
    expect(isNoProxyExempt(new URL("https://foo.example.com/"))).toBe(false);
  });
});

describe("hasZstdSupport", () => {
  test("true on Node 22.15+ (node:zlib provides zstdCompress)", () => {
    // node:zlib.zstdCompress is always available in our minimum Node version.
    expect(hasZstdSupport()).toBe(true);
  });
});

describe("shouldFallbackToDefault", () => {
  const PROXY_VARS = [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
  ] as const;
  const saved: Partial<Record<(typeof PROXY_VARS)[number], string>> = {};

  beforeEach(() => {
    for (const k of PROXY_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PROXY_VARS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  const opts = { url: "https://ingest.example.com/", recordDroppedEvent: noop };
  const httpsUrl = new URL("https://ingest.example.com/");
  const httpUrl = new URL("http://ingest.example.com/");

  test("no proxy configured → no fallback", () => {
    expect(shouldFallbackToDefault(httpsUrl, opts)).toBe(false);
  });

  test("options.proxy wins → fallback", () => {
    expect(
      shouldFallbackToDefault(httpsUrl, {
        ...opts,
        proxy: "http://proxy.internal:3128",
      })
    ).toBe(true);
  });

  test("lowercase https_proxy → fallback (HTTPS URL)", () => {
    process.env.https_proxy = "http://proxy.internal:3128";
    expect(shouldFallbackToDefault(httpsUrl, opts)).toBe(true);
  });

  test("uppercase HTTPS_PROXY → fallback (HTTPS URL)", () => {
    process.env.HTTPS_PROXY = "http://proxy.internal:3128";
    expect(shouldFallbackToDefault(httpsUrl, opts)).toBe(true);
  });

  test("lowercase wins over uppercase when both are set", () => {
    process.env.https_proxy = "http://winning.proxy:3128";
    process.env.HTTPS_PROXY = "http://losing.proxy:3128";
    // Both trigger fallback; this just asserts the lookup doesn't
    // crash on duplicate vars and that the function still returns true.
    expect(shouldFallbackToDefault(httpsUrl, opts)).toBe(true);
  });

  test("HTTPS URL falls back to http_proxy when https_proxy is unset (matches SDK precedent)", () => {
    process.env.http_proxy = "http://proxy.internal:3128";
    expect(shouldFallbackToDefault(httpsUrl, opts)).toBe(true);
  });

  test("uppercase HTTP_PROXY → fallback (http URL)", () => {
    process.env.HTTP_PROXY = "http://proxy.internal:3128";
    expect(shouldFallbackToDefault(httpUrl, opts)).toBe(true);
  });

  test("uppercase NO_PROXY exemption keeps zstd path even with proxy set", () => {
    process.env.HTTPS_PROXY = "http://proxy.internal:3128";
    process.env.NO_PROXY = "example.com";
    expect(shouldFallbackToDefault(httpsUrl, opts)).toBe(false);
  });
});
