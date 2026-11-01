/**
 * Input limits shared by Toolkit's HTTP MCP servers (GHSA-46jr-4wx8-v453):
 * the hosted Sentry MCP server and the Docs MCP Worker.
 */

/**
 * Largest MCP POST body accepted over HTTP. The SDK default is 4 MiB. The
 * longest bounded tool text input is 4,096 characters and the rest are
 * queries, slugs, and IDs, so 1 MiB covers every supported request with wide
 * headroom while shrinking what one request can make a Worker parse.
 */
export const MAX_MCP_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Most array elements plus object keys accepted in one `tools/call`
 * `arguments` payload. Without a cap, a single HTTP request can exhaust the
 * heap during input validation. The largest bounded tool inputs today hold
 * ~100 elements, and realistic alert-rule payloads stay in the low hundreds,
 * so this leaves wide headroom for legitimate calls.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

/**
 * Reads a request body, stopping as soon as it exceeds
 * MAX_MCP_REQUEST_BODY_BYTES. Returns `undefined` when the body is too large.
 *
 * A declared `Content-Length` over the limit is rejected before reading.
 * Streamed bytes are still counted, so bodies without `Content-Length`, or with
 * a wrong one, are bounded too.
 */
export async function readBoundedBody(
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (
    Number(request.headers.get("content-length")) > MAX_MCP_REQUEST_BODY_BYTES
  ) {
    return undefined;
  }
  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > MAX_MCP_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The JSON-RPC 413 the MCP SDK returns for an oversized request body. */
export function mcpPayloadTooLargeResponse(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: `Payload Too Large: Request body must not exceed ${MAX_MCP_REQUEST_BODY_BYTES} bytes`,
      },
      id: null,
    },
    { status: 413 },
  );
}

/**
 * Buffers an MCP POST body up to MAX_MCP_REQUEST_BODY_BYTES and returns a
 * request that replays it, or the JSON-RPC 413. Other methods and bodiless
 * requests pass through unchanged.
 *
 * Use this when the MCP transport parses the body itself and its own limit does
 * not cover every path.
 */
export async function boundMcpRequestBody(
  request: Request,
): Promise<Request | Response> {
  if (request.method !== "POST" || request.body === null) {
    return request;
  }

  const body = await readBoundedBody(request);
  if (!body) {
    return mcpPayloadTooLargeResponse();
  }
  return new Request(request, { method: "POST", body });
}
