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
  test("returns endpoints for a known resource", () => {
    const result = resolveResourceQuery("issues");
    expect(result.kind).toBe("endpoints");
    if (result.kind === "endpoints") {
      expect(result.endpoints.length).toBeGreaterThan(0);
      for (const ep of result.endpoints) {
        expect(ep.resource).toBe("issues");
      }
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

  test("does not interpret a partial operation identifier as exact", () => {
    expect(() => resolveResourceQuery("OrganizationEvents")).toThrow(
      ResolutionError
    );
  });
  test("no-match resource throws ResolutionError instead of listing everything", () => {
    let thrown: unknown;
    try {
      resolveResourceQuery("committers");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResolutionError);
    // Must not be the full-list OutputError dump this replaced.
    expect(thrown).not.toBeInstanceOf(OutputError);
    const err = thrown as ResolutionError;
    expect(err.message).toContain('Resource "committers"');
    expect(err.message).toContain("does not exist");
    // Non-zero exit so scripts can branch on it.
    expect(err.exitCode).toBeGreaterThan(0);
  });

  test("suggests a close resource name for a typo", () => {
    let thrown: unknown;
    try {
      resolveResourceQuery("committers");
    } catch (error) {
      thrown = error;
    }
    const err = thrown as ResolutionError;
    // "committers" is one edit from the real "commits" resource.
    expect(err.message).toContain("commits");
  });

  test("garbage term also throws ResolutionError", () => {
    expect(() => resolveResourceQuery("zzzznomatch")).toThrow(ResolutionError);
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

  test("glob pattern matching nothing throws ResolutionError", () => {
    expect(() => resolveResourceQuery("zzzz*")).toThrow(ResolutionError);
  });
});
