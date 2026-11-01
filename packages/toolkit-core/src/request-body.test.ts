import { describe, expect, it } from "vitest";
import { boundMcpRequestBody, readBoundedBody } from "./request-body.js";

const LIMIT = 64;

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of chunks) {
        controller.enqueue(new Uint8Array(size).fill(0x61));
      }
      controller.close();
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
  it("returns a body at the limit across chunks", async () => {
    const body = await readBoundedBody(post(streamOf([40, 24])), LIMIT);

    expect(body).toEqual(new Uint8Array(LIMIT).fill(0x61));
  });

  it("returns an empty body when the request has none", async () => {
    const body = await readBoundedBody(post(null), LIMIT);

    expect(body).toEqual(new Uint8Array());
  });

  it("rejects a declared Content-Length over the limit", async () => {
    const request = post(streamOf([1]), {
      "content-length": String(LIMIT + 1),
    });

    await expect(readBoundedBody(request, LIMIT)).resolves.toBeUndefined();
  });

  it("rejects a streamed body over the limit without Content-Length", async () => {
    const request = post(streamOf([40, 25]));
    expect(request.headers.has("content-length")).toBe(false);

    await expect(readBoundedBody(request, LIMIT)).resolves.toBeUndefined();
  });
});

describe("boundMcpRequestBody", () => {
  it("replays a body within the limit", async () => {
    const bounded = await boundMcpRequestBody(post('{"id":1}'), LIMIT);

    expect(bounded).toBeInstanceOf(Request);
    await expect((bounded as Request).text()).resolves.toBe('{"id":1}');
  });

  it("returns the JSON-RPC 413 for an oversized body", async () => {
    const bounded = await boundMcpRequestBody(
      post(streamOf([LIMIT + 1])),
      LIMIT,
    );

    expect(bounded).toBeInstanceOf(Response);
    const response = bounded as Response;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: -32000,
        message: `Payload Too Large: Request body must not exceed ${LIMIT} bytes`,
      },
      id: null,
      jsonrpc: "2.0",
    });
  });

  it("passes non-POST requests through unchanged", async () => {
    const request = new Request("https://example.test/mcp", { method: "GET" });

    await expect(boundMcpRequestBody(request, LIMIT)).resolves.toBe(request);
  });
});
