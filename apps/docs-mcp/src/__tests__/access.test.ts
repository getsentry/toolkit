import { describe, expect, test } from "vitest";
import { isDocsMcpServiceRequest } from "../access";

describe("isDocsMcpServiceRequest", () => {
  test.each([
    "https://docs-mcp.internal/mcp",
    "http://localhost:8788/mcp",
    "http://127.0.0.1:8788/mcp",
  ])("allows the service-binding or local development origin: %s", (url) => {
    expect(isDocsMcpServiceRequest(new Request(url))).toBe(true);
  });

  test.each([
    "https://docs-mcp.getsentry.workers.dev/mcp",
    "https://preview-docs-mcp.getsentry.workers.dev/mcp",
  ])("rejects public worker origins: %s", (url) => {
    expect(isDocsMcpServiceRequest(new Request(url))).toBe(false);
  });
});
