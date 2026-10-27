/**
 * Schema Command Tests
 *
 * Covers resolveResourceQuery — in particular the no-match paths that used to
 * dump the full resource list (byte-identical to a successful browse) instead
 * of reporting that nothing matched. See getsentry/cli#1424.
 */

import { describe, expect, test } from "vitest";
import { resolveResourceQuery } from "../../src/commands/schema.js";
import { OutputError, ResolutionError } from "../../src/lib/errors.js";

describe("resolveResourceQuery", () => {
  test("discovers endpoints for a known resource", () => {
    const result = resolveResourceQuery("issues");
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(result.endpoints.length).toBeGreaterThan(0);
      expect(
        result.endpoints.some((ep) => ep.fn === "listOrganizationIssues"),
      ).toBe(true);
      expect(result.endpoints.every((ep) => ep.match)).toBe(true);
    }
  });

  test("returns one endpoint for an exact operation identifier", () => {
    const result = resolveResourceQuery("listOrganizationEvents");
    expect(result.kind).toBe("endpoint");
    if (result.kind === "endpoint") {
      expect(result.endpoint.fn).toBe("listOrganizationEvents");
      expect(result.endpoint.resource).toBe("events");
    }
  });

  test("treats partial operation names as discovery, never exact selection", () => {
    const result = resolveResourceQuery("OrganizationEvents");
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(
        result.endpoints.some((ep) => ep.fn === "listOrganizationEvents"),
      ).toBe(true);
    }
  });

  test("returns every list candidate instead of selecting a deprecated endpoint", () => {
    const result = resolveResourceQuery("issues", "list");
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(
        result.endpoints.find((ep) => ep.fn === "listOrganizationIssues"),
      ).toBeDefined();
      expect(
        result.endpoints.find(
          (ep) => ep.deprecated && ep.resource === "issues",
        ),
      ).toBeDefined();
      expect(result.endpoints[0]?.deprecated).toBe(false);
    }
  });
  test("no-match resource throws ResolutionError instead of listing everything", () => {
    let thrown: unknown;
    try {
      resolveResourceQuery("zzzznomatch");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResolutionError);
    // Must not be the full-list OutputError dump this replaced.
    expect(thrown).not.toBeInstanceOf(OutputError);
    const err = thrown as ResolutionError;
    expect(err.message).toContain('Resource "zzzznomatch"');
    expect(err.message).toContain("does not exist");
    // Non-zero exit so scripts can branch on it.
    expect(err.exitCode).toBeGreaterThan(0);
  });

  test("a resource typo returns candidates rather than selecting an endpoint", () => {
    const result = resolveResourceQuery("committers");
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(
        result.endpoints.some((endpoint) => endpoint.resource === "commits"),
      ).toBe(true);
    }
  });

  test("known resource with unknown operation shows that resource's endpoints", () => {
    let thrown: unknown;
    try {
      resolveResourceQuery("issues", "xyznonexistent123");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OutputError);
    const data = (thrown as OutputError).data as {
      kind: string;
      endpoints: { resource: string }[];
    };
    expect(data.kind).toBe("endpoints");
    expect(data.endpoints.length).toBeGreaterThan(0);
    for (const ep of data.endpoints) {
      expect(ep.resource).toBe("issues");
    }
  });

  test("known resource with valid operation returns a single endpoint", () => {
    const result = resolveResourceQuery("issues", "getOrganizationIssue");
    expect(result.kind).toBe("endpoint");
    if (result.kind === "endpoint") {
      expect(result.endpoint.resource).toBe("issues");
    }
  });

  test("glob pattern matching resources returns their endpoints", () => {
    const result = resolveResourceQuery("issue*");
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(result.endpoints.length).toBeGreaterThan(0);
    }
  });

  test.each([
    { query: "[i]ssues", resources: ["issues"] },
    { query: "{issues,projects}", resources: ["issues", "projects"] },
  ])("keeps $query scoped to matching resources", ({ query, resources }) => {
    const result = resolveResourceQuery(query);
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(
        [
          ...new Set(result.endpoints.map((endpoint) => endpoint.resource)),
        ].sort(),
      ).toEqual(resources);
    }
  });

  test("glob pattern matching nothing throws ResolutionError", () => {
    expect(() => resolveResourceQuery("zzzz*")).toThrow(ResolutionError);
  });
});
