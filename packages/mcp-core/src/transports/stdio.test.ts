import type { McpServer } from "@modelcontextprotocol/server";
import { startSpan } from "@sentry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIB_VERSION, setServerVersion } from "../version";
import { startStdio } from "./stdio";

vi.mock("@sentry/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/core")>()),
  startNewTrace: (callback: () => unknown) => callback(),
  startSpan: vi.fn((_options: unknown, callback: () => unknown) => callback()),
}));

// The span is all this test reads; the fake server never starts the transport.
const server = {
  connect: vi.fn(async () => undefined),
} as unknown as McpServer;

async function spanAttributes(context: Parameters<typeof startStdio>[1]) {
  await startStdio(server, context);
  const [options] = vi.mocked(startSpan).mock.calls[0]!;
  return options.attributes;
}

describe("startStdio", () => {
  beforeEach(() => {
    vi.mocked(startSpan).mockClear();
  });

  afterEach(() => {
    setServerVersion(undefined);
  });

  it("tags the span with the host's version", async () => {
    setServerVersion("0.48.0-test");
    expect(await spanAttributes({})).toMatchObject({
      "app.server.version": "0.48.0-test",
      "service.version": "0.48.0-test",
    });
  });

  it("falls back to mcp-core's version", async () => {
    expect(await spanAttributes({})).toMatchObject({
      "app.server.version": LIB_VERSION,
      "service.version": LIB_VERSION,
    });
  });
});
