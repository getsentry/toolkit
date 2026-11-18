import { describe, expect, it } from "vitest";
import { parseResourceMcpConstraints } from "./resource-scope";

describe("parseResourceMcpConstraints", () => {
  it("returns the organization for /mcp/:org", () => {
    expect(
      parseResourceMcpConstraints("https://mcp.sentry.dev/mcp/sentry"),
    ).toEqual({ organizationSlug: "sentry", projectSlug: null });
  });

  it("returns the organization and project for /mcp/:org/:project", () => {
    expect(
      parseResourceMcpConstraints(
        "https://mcp.sentry.dev/mcp/sentry/mcp-server/?utm_source=plugin",
      ),
    ).toEqual({ organizationSlug: "sentry", projectSlug: "mcp-server" });
  });

  it.each([
    "https://mcp.sentry.dev/mcp",
    "https://mcp.sentry.dev/mcp/",
    "https://mcp.sentry.dev/mcp/sentry/mcp-server/extra",
    "https://mcp.sentry.dev/sse/sentry",
    "https://mcp.sentry.dev/",
    "not a url",
  ])("returns null for %s", (resource) => {
    expect(parseResourceMcpConstraints(resource)).toBeNull();
  });
});
