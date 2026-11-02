import { describe, expect, it } from "vitest";
import {
  MAX_MCP_REQUEST_BODY_BYTES,
  boundMcpRequestBody,
  readBoundedBody,
} from "./mcp-limits.js";

const CHUNK_BYTES = 64 * 1024;

/** A streamed body of exactly `size` bytes of "a", sent in 64 KiB chunks. */
function streamOf(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(CHUNK_BYTES, size - sent));
      controller.enqueue(chunk.fill(0x61));
      sent += chunk.byteLength;
    },
  });
}

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("https://example.test/mcp", {
    body,
    // Node requires `duplex` for streamed request bodies.
    duplex: "half",
    headers,
    method: "POST",
  } as RequestInit);
}

describe("readBoundedBody", () => {
  it("returns a streamed body at the limit", async () => {
    const body = await readBoundedBody(
      post(streamOf(MAX_MCP_REQUEST_BODY_BYTES)),
    );

    expect(body?.byteLength).toBe(MAX_MCP_REQUEST_BODY_BYTES);
    expect(body?.every((byte) => byte === 0x61)).toBe(true);
  });

  it("returns an empty body when the request has none", async () => {
    await expect(readBoundedBody(post(null))).resolves.toEqual(
      new Uint8Array(),
    );
  });

  it("rejects a declared Content-Length over the limit before reading", async () => {
    const request = post(streamOf(1), {
      "content-length": String(MAX_MCP_REQUEST_BODY_BYTES + 1),
    });

    await expect(readBoundedBody(request)).resolves.toBeUndefined();
    expect(request.bodyUsed).toBe(false);
  });

  it("rejects a streamed body over the limit without Content-Length", async () => {
    const request = post(streamOf(MAX_MCP_REQUEST_BODY_BYTES + 1));
    expect(request.headers.has("content-length")).toBe(false);

    await expect(readBoundedBody(request)).resolves.toBeUndefined();
  });

  it("rejects a body larger than its declared Content-Length", async () => {
    const request = post(streamOf(MAX_MCP_REQUEST_BODY_BYTES + 1), {
      "content-length": "1",
    });

    await expect(readBoundedBody(request)).resolves.toBeUndefined();
  });
});

describe("boundMcpRequestBody", () => {
  it("replays a body within the limit", async () => {
    const bounded = await boundMcpRequestBody(post('{"id":1}'));

    expect(bounded).toBeInstanceOf(Request);
    await expect((bounded as Request).text()).resolves.toBe('{"id":1}');
  });

  it("returns the JSON-RPC 413 for an oversized body", async () => {
    const bounded = await boundMcpRequestBody(
      post(streamOf(MAX_MCP_REQUEST_BODY_BYTES + 1)),
    );

    expect(bounded).toBeInstanceOf(Response);
    const response = bounded as Response;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: -32000,
        message: `Payload Too Large: Request body must not exceed ${MAX_MCP_REQUEST_BODY_BYTES} bytes`,
      },
      id: null,
      jsonrpc: "2.0",
    });
  });

  it("passes non-POST requests through unchanged", async () => {
    const request = new Request("https://example.test/mcp", { method: "GET" });

    await expect(boundMcpRequestBody(request)).resolves.toBe(request);
  });
});
