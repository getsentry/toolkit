import { expect, test } from "vitest";
import { routes } from "../../src/app.js";
import { getMcpArgs } from "../../src/cli.js";

test("exposes the local MCP server through the sentry CLI", () => {
  expect(
    routes.getAllEntries().some((entry) => entry.name.original === "mcp"),
  ).toBe(true);
});

test("recognizes MCP after leading global flags", () => {
  expect(getMcpArgs(["--verbose", "mcp", "--host=sentry.example.com"])).toEqual(
    ["--host=sentry.example.com"],
  );
  expect(getMcpArgs(["--org", "acme", "mcp"])).toEqual([]);
  expect(getMcpArgs(["issue", "mcp"])).toBeUndefined();
});
