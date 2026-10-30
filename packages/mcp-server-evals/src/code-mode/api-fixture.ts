import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { z } from "zod";

export interface FixtureRequest {
  method: string;
  path: string;
  query: string;
  status: number;
}

interface ApiRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface ApiReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Authenticated loopback HTTP boundary; scenario state and grading stay with the fixture. */
export async function startApiFixture(
  accessToken: string,
  handle: (
    request: ApiRequest,
  ) => ApiReply | undefined | Promise<ApiReply | undefined>,
) {
  const requests: FixtureRequest[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const method = request.method ?? "GET";
    let reply: ApiReply;
    try {
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        reply = { status: 401, body: { detail: "Invalid token" } };
      } else {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 256_000)
            throw new Error("Fixture request body exceeds its budget");
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        reply = (await handle({
          method,
          url,
          headers: request.headers,
          body: raw ? JSON.parse(raw) : undefined,
        })) ?? {
          status: 404,
          body: { detail: "Endpoint not implemented in this eval fixture" },
        };
      }
    } catch (error) {
      reply =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? {
              status: 400,
              body: {
                detail: "Invalid request",
                ...(error instanceof z.ZodError
                  ? { errors: error.issues }
                  : {}),
              },
            }
          : { status: 500, body: { detail: "Fixture internal error" } };
    }
    const status = reply.status ?? 200;
    requests.push({ method, path: url.pathname, query: url.search, status });
    response.writeHead(status, {
      "content-type": "application/json",
      ...reply.headers,
    });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close(this: void) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
