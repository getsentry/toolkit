import { operations } from "@sentry/api/operations";
import { describe, expect, it } from "vitest";
import { getSpec } from "./openapi";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

describe("shipped OpenAPI schema", () => {
  it("matches the @sentry/api release in the pnpm catalog", () => {
    const spec = getSpec() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const shipped = Object.entries(spec.paths)
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((method) => METHODS.includes(method))
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    // On failure, run `pnpm --filter @sentry/mcp-cloudflare generate:openapi`.
    expect(shipped).toEqual(
      operations.map(({ method, path }) => `${method} ${path}`).sort(),
    );
  });
});
