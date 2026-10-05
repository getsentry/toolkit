import { expect, test } from "vitest";
import { routes } from "../../src/app.js";

test("exposes the local MCP server through the sentry CLI", () => {
  expect(
    routes.getAllEntries().some((entry) => entry.name.original === "mcp")
  ).toBe(true);
});
