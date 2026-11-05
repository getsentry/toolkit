/**
 * E2E tests for the zstd transport.
 *
 * Spins up a real `http.createServer` on `127.0.0.1:0`, points the
 * transport at it, and verifies the wire-level behavior: the request
 * body is zstd-compressed, the `Content-Encoding` header is correct,
 * and the body decompresses back to a valid envelope.
 */

import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { createEnvelope } from "@sentry/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  hasZstdSupport,
  makeCompressedTransport,
  makeNodeTransportWithDeadline,
} from "../../../src/lib/telemetry/zstd-transport.js";
import {
  closeIngestServers,
  noop,
  startMockIngest,
  startStalledIngest,
  startStalledProxy,
} from "./ingest-servers.js";

describe("makeCompressedTransport (e2e)", () => {
  afterEach(closeIngestServers);

  test("sends zstd-encoded envelope; server decompresses back to original", async () => {
    if (!hasZstdSupport()) {
      return;
    }

    const { url, captures } = await startMockIngest(() => ({
      statusCode: 200,
    }));

    const transport = makeCompressedTransport({
      url,
      recordDroppedEvent: noop,
    });

    // Sizable envelope — above the 1 KiB zstd threshold.
    const message = "x".repeat(4096);
    const envelope: any = createEnvelope({ event_id: "abc" } as any, [
      [{ type: "event" } as any, { message } as any],
    ]);

    const response = await transport.send(envelope);
    expect(response.statusCode).toBe(200);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["content-encoding"]).toBe("zstd");

    const decompressed = await promisify(zstdDecompress)(captures[0]!.body);
    const text = Buffer.from(
      decompressed.buffer,
      decompressed.byteOffset,
      decompressed.byteLength,
    ).toString("utf-8");
    expect(text).toContain(message);
    expect(text).toContain('"type":"event"');
  });

  test("rate-limit headers flow back into createTransport wrapper", async () => {
    const { url, captures } = await startMockIngest(() => ({
      statusCode: 429,
      headers: {
        "retry-after": "60",
        "x-sentry-rate-limits": "60:error:organization",
      },
    }));

    const transport = makeCompressedTransport({
      url,
      recordDroppedEvent: noop,
    });

    const envelope: any = createEnvelope({ event_id: "a" } as any, [
      [{ type: "event" } as any, { message: "hi" } as any],
    ]);
    const response = await transport.send(envelope);

    expect(response.statusCode).toBe(429);
    expect(response.headers?.["retry-after"]).toBe("60");
    expect(response.headers?.["x-sentry-rate-limits"]).toBe(
      "60:error:organization",
    );
    expect(captures).toHaveLength(1);
  });

  test("aborts a request the server never answers", async () => {
    const { url, closed } = await startStalledIngest();
    const transport = makeCompressedTransport(
      { url, recordDroppedEvent: noop },
      100,
    );
    const envelope: any = createEnvelope({ event_id: "a" } as any, [
      [{ type: "event" } as any, { message: "hi" } as any],
    ]);

    // Without a deadline this never settles, and its socket keeps the
    // CLI process alive after the command finishes (#1956).
    await expect(transport.send(envelope)).rejects.toThrow();
    await closed;
  });

  test("aborts a request stalled behind a proxy", async () => {
    const proxy = await startStalledProxy();
    const savedProxy = process.env.http_proxy;
    process.env.http_proxy = proxy.url;
    try {
      const transport = makeCompressedTransport(
        { url: "http://127.0.0.1:9/api/0/envelope/", recordDroppedEvent: noop },
        100,
      );
      const envelope: any = createEnvelope({ event_id: "a" } as any, [
        [{ type: "event" } as any, { message: "hi" } as any],
      ]);

      await expect(transport.send(envelope)).rejects.toThrow();
      await proxy.closed;
    } finally {
      if (savedProxy === undefined) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = savedProxy;
      }
    }
  });
});

describe("makeNodeTransportWithDeadline (e2e)", () => {
  afterEach(closeIngestServers);

  test("aborts a request the server never answers", async () => {
    const { url, closed } = await startStalledIngest();
    const transport = makeNodeTransportWithDeadline(
      { url, recordDroppedEvent: noop },
      100,
    );
    const envelope: any = createEnvelope({ event_id: "a" } as any, [
      [{ type: "event" } as any, { message: "hi" } as any],
    ]);

    // `sentry mcp` keeps the SDK transport; without a deadline a stalled
    // ingest socket outlives the client's disconnect (#1956).
    await expect(transport.send(envelope)).rejects.toThrow();
    await closed;
  });
});
