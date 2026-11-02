import { operations } from "@sentry/api/operations";
import { describe, expect, it } from "vitest";
import { OPERATIONS, SPEC_TEXT } from "./openapi";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

// Search reads the schema and authorization reads the operation list, so both
// must describe the same release. On failure, run
// `pnpm --filter @sentry/mcp-cloudflare generate:openapi`.
describe("shipped Code Mode API data", () => {
  const release = operations.map(({ method, path }) => `${method} ${path}`);

  it("has the schema of the @sentry/api release in the pnpm catalog", () => {
    const spec = JSON.parse(SPEC_TEXT) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const shipped = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => METHODS.includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(shipped.sort()).toEqual([...release].sort());
  });

  it("has the operations of that release", () => {
    expect(
      OPERATIONS.map(({ method, path }) => `${method} ${path}`).sort(),
    ).toEqual([...release].sort());
  });
});
