import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../../app";

describe("/api/search", () => {
  it("should return 400 for invalid request body", async () => {
    const res = await app.request(
      "/api/search",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "192.0.2.1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // Missing required 'query' field
      },
      env,
    );

    expect(res.status).toBe(400);
    const json = await res.json<{ error: string; details: unknown[] }>();
    expect(json.error).toBe("Invalid request");
    expect(json.details).toBeDefined();
  });

  it("should return 400 for empty query", async () => {
    const res = await app.request(
      "/api/search",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "192.0.2.1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "" }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it("should return 503 when AI binding is not available", async () => {
    const res = await app.request(
      "/api/search",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "192.0.2.1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "how to install sentry" }),
      },
      env, // env doesn't have AI binding in test config
    );

    expect(res.status).toBe(503);
    const json = await res.json<{ error: string; name: string }>();
    expect(json.error).toBe("AI service not available");
    expect(json.name).toBe("AI_SERVICE_UNAVAILABLE");
  });
});
