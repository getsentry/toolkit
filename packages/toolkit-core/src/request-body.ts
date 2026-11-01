/**
 * Request body limits shared by Toolkit's HTTP MCP servers
 * (GHSA-46jr-4wx8-v453). Each server picks its own byte budget.
 */

/**
 * Reads a request body, stopping as soon as it exceeds `maxBytes`. Returns
 * `undefined` when the body is too large.
 *
 * A declared `Content-Length` over the limit is rejected before reading.
 * Streamed bytes are still counted, so bodies without `Content-Length`, or with
 * a wrong one, are bounded too.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
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
    if (received > maxBytes) {
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
export function mcpPayloadTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: `Payload Too Large: Request body must not exceed ${maxBytes} bytes`,
      },
      id: null,
    },
    { status: 413 },
  );
}

/**
 * Buffers an MCP POST body up to `maxBytes` and returns a request that replays
 * it, or the JSON-RPC 413. Other methods and bodiless requests pass through
 * unchanged.
 *
 * Use this when the MCP transport parses the body itself and its own limit does
 * not cover every path.
 */
export async function boundMcpRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Request | Response> {
  if (request.method !== "POST" || request.body === null) {
    return request;
  }

  const body = await readBoundedBody(request, maxBytes);
  if (!body) {
    return mcpPayloadTooLargeResponse(maxBytes);
  }
  return new Request(request, { method: "POST", body });
}
