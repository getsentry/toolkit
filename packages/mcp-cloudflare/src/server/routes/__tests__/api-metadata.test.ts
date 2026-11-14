import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../../app";

describe("/api/metadata", () => {
  it("should return 401 without authorization", async () => {
    const res = await app.request(
      "/api/metadata",
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.1",
        },
      },
      env,
    );

    expect(res.status).toBe(401);
    const json = await res.json<{ error: string; name: string }>();
    expect(json.error).toBe("Authorization required");
    expect(json.name).toBe("MISSING_AUTH_TOKEN");
  });
});
