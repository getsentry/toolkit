/**
 * Contract tests for the manually runnable local-agent Hono fixture.
 *
 * The fixture is intentionally small, but each route represents a distinct
 * telemetry shape that `sentry local` needs to make useful to an agent.
 */

import { describe, expect, test } from "vitest";
import { createLocalAgentServer } from "../../fixtures/local-agent-server.js";

describe("local agent fixture", () => {
  test("reports that it is ready for a local-only telemetry session", async () => {
    const app = createLocalAgentServer();

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      service: "local-agent-fixture",
      status: "ok",
    });
  });

  test("returns a user after a simulated database span", async () => {
    const app = createLocalAgentServer();

    const res = await app.request("/api/users/42");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: "42",
      name: "Ada Lovelace",
      source: "fixture-db",
    });
  });

  test("runs a simulated agent tool call", async () => {
    const app = createLocalAgentServer();

    const res = await app.request("/api/agent/run", {
      method: "POST",
      body: JSON.stringify({ prompt: "Where is the rate limit configured?" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      answer: "The rate limit is configured in src/lib/rate-limit.ts.",
      tool: "search_files",
    });
  });

  test("returns a safe error response after capturing the underlying exception", async () => {
    const app = createLocalAgentServer();

    const res = await app.request("/api/broken");

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "fixture_failure",
      message:
        "The fixture intentionally failed. Check sentry local for details.",
    });
  });
});
