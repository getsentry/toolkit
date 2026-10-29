import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("standalone @sentry/mcp-server bundle", () => {
  test("names `sentry-mcp` and reports the package version", async () => {
    vi.stubGlobal("SENTRY_MCP_SERVER_VERSION", "1.2.3");
    vi.resetModules();
    const { buildMcpUsage, buildMcpVersion } =
      await import("../../../src/lib/mcp/usage.js");

    expect(buildMcpVersion()).toBe("sentry-mcp 1.2.3");
    const usage = buildMcpUsage(["inspect"]);
    expect(usage).toMatch(/^Usage: sentry-mcp /);
    expect(usage).toContain("`sentry-mcp auth login`");
    expect(usage).not.toContain("sentry mcp");
  });
});
