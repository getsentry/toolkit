import { beforeEach, describe, expect, test, vi } from "vitest";

const { executeInternalDocsRequest } = vi.hoisted(() => ({
  executeInternalDocsRequest: vi.fn(),
}));

vi.mock("../internal-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../internal-api")>()),
  executeInternalDocsRequest,
}));

import { app } from "../index";
import { MAX_MCP_REQUEST_BODY_BYTES } from "@sentry/toolkit-core/mcp-limits";

function docsRequest(body: string) {
  return new Request("https://docs-mcp.internal/internal/docs", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("private docs API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("rejects requests outside the service binding", async () => {
    const response = await app.request(
      "https://docs-mcp.getsentry.workers.dev/internal/docs",
      {
        body: JSON.stringify({ operation: "search-docs", query: "tracing" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(403);
  });

  test("executes a validated request through the service binding", async () => {
    executeInternalDocsRequest.mockResolvedValue({
      results: [{ title: "Tracing", url: "https://docs.sentry.io/tracing/" }],
    });

    const response = await app.request(
      "https://docs-mcp.internal/internal/docs",
      {
        body: JSON.stringify({ operation: "search-docs", query: "tracing" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      {
        CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "test" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ title: "Tracing", url: "https://docs.sentry.io/tracing/" }],
    });
    expect(executeInternalDocsRequest).toHaveBeenCalledWith(
      undefined,
      { operation: "search-docs", query: "tracing" },
      "test",
    );
  });

  test("returns a safe code when a docs answer cannot be citation-verified", async () => {
    executeInternalDocsRequest.mockRejectedValue(
      new Error("Docs citation was not fetched: https://docs.sentry.io/"),
    );

    const response = await app.request(
      "https://docs-mcp.internal/internal/docs",
      {
        body: JSON.stringify({ operation: "query-docs", query: "tracing" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      {
        CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "test" },
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "DOCS_UNGROUNDED",
      error: "Docs API request failed",
    });
  });

  test("returns a safe code when no configured model is available in the region", async () => {
    executeInternalDocsRequest.mockRejectedValue(
      new Error("This model is not available in your region."),
    );

    const response = await app.request(
      "https://docs-mcp.internal/internal/docs",
      {
        body: JSON.stringify({ operation: "query-docs", query: "tracing" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      {
        CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "test" },
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "DOCS_MODEL_UNAVAILABLE",
      error: "Docs API request failed",
    });
  });
  // The body limit itself is tested in toolkit-core; this checks the route
  // applies it with its own error shape.
  test("rejects an oversized body before parsing it", async () => {
    const response = await app.request(
      docsRequest("a".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: `Request body must not exceed ${MAX_MCP_REQUEST_BODY_BYTES} bytes`,
    });
    expect(executeInternalDocsRequest).not.toHaveBeenCalled();
  });

  test("still rejects malformed JSON as an invalid request", async () => {
    const response = await app.request(docsRequest("{"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid docs API request",
    });
  });
});
