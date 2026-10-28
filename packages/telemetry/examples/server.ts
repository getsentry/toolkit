import { createServer } from "node:http";
import { createTelemetryPipeline } from "@sentry/telemetry/node";

const maxPayloadBytes = 8 * 1024 * 1024;

/** Embed the SDK in an HTTP server; the SDK itself does not open a port. */
export function createTelemetryServer() {
  const pipeline = createTelemetryPipeline({
    maxPayloadBytes,
    decodedHistory: { maxEntries: 100 },
    retention: { maxEnvelopes: 1000, maxAgeMs: 10 * 60 * 1000 },
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && url.pathname === "/envelope") {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          // Bound HTTP collection too: SDK limits only apply once the body is passed in.
          if (bytes > maxPayloadBytes) {
            response
              .writeHead(413)
              .end(JSON.stringify({ error: "Payload too large" }));
            return;
          }
          chunks.push(buffer);
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        const deliveryId = request.headers["idempotency-key"];
        const result = await pipeline.ingestPayload({
          body: Buffer.concat(chunks),
          contentType: request.headers["content-type"],
          encoding: request.headers["content-encoding"],
          userAgent: request.headers["user-agent"],
          deliveryId: typeof deliveryId === "string" ? deliveryId : undefined,
          signal: controller.signal,
        });
        response.off("close", abort);
        response.statusCode =
          result.status === "invalid"
            ? 400
            : result.status === "ignored" &&
                result.reason === "unsupported_content_type"
              ? 415
              : result.status === "ignored" &&
                  ["queue_full", "reset", "disposed", "aborted"].includes(
                    result.reason,
                  )
                ? 503
                : 202;
        response.end(JSON.stringify(result));
        return;
      }
      if (request.method === "GET" && url.pathname === "/queries") {
        const traceId = url.searchParams.get("traceId") ?? undefined;
        response.end(
          JSON.stringify(pipeline.getDatabaseQuerySummaries({ traceId })),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Not found" }));
    } catch {
      // An aborted request body rejects its async iterator. Keep the server usable.
      if (!response.destroyed) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "Could not read request" }));
      }
    }
  });
  server.on("close", pipeline.dispose);
  return { server, pipeline };
}
