import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../../app";

describe("/.mcp discovery routes", () => {
  it("GET /.mcp should return available endpoints", async () => {
    const res = await app.request(
      "/.mcp",
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.1",
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");

    const json = await res.json();
    expect(json).toEqual({
      endpoints: ["/.mcp/tools.json"],
    });
  });

  it("GET /.mcp/tools.json should return direct tool definitions", async () => {
    const res = await app.request(
      "/.mcp/tools.json",
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.1",
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const json = (await res.json()) as Array<{
      name: string;
      inputSchema: unknown;
      skills: string[];
      surface: "direct" | "catalog";
      deprecated?: { replacedBy: string[] };
    }>;
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThan(0);

    const toolsByName = new Map(json.map((tool) => [tool.name, tool]));
    expect(toolsByName.get("find_organizations")).toEqual(
      expect.objectContaining({
        inputSchema: expect.any(Object),
        surface: "direct",
      }),
    );
    expect(toolsByName.get("get_issue_details")).toEqual(
      expect.objectContaining({
        inputSchema: expect.any(Object),
        skills: expect.arrayContaining(["inspect"]),
        surface: "direct",
      }),
    );
    // EXPOSE_ALL_TOOLS lists every tool directly and drops the gateway.
    // Deprecated tools stay catalog-only so harness search skips them.
    for (const tool of json) {
      expect([tool.name, tool.surface]).toEqual([
        tool.name,
        tool.deprecated ? "catalog" : "direct",
      ]);
    }
    expect(toolsByName.get("search_events")?.deprecated).toEqual({
      replacedBy: expect.arrayContaining(["search_errors", "search_logs"]),
    });
    expect(toolsByName.has("search_sentry_tools")).toBe(false);
    expect(toolsByName.has("execute_sentry_tool")).toBe(false);
  });
});
