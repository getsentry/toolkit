/**
 * Unit tests for pagination context key builders.
 */

import { describe, expect, test } from "vitest";
import {
  buildMultiTargetContextKey,
  buildOrgContextKey,
  buildPaginationContextKey,
} from "../../../src/lib/db/pagination.js";

describe("buildPaginationContextKey", () => {
  test("builds simple org-scoped key", () => {
    const key = buildPaginationContextKey("org", "my-org");
    expect(key).toContain("type:org:my-org");
    expect(key).toMatch(/^host:.+\|type:org:my-org$/);
  });

  test("includes optional params when defined", () => {
    const key = buildPaginationContextKey("trace", "my-org/my-proj", {
      sort: "date",
      q: "GET /api",
    });
    expect(key).toContain("type:trace:my-org/my-proj");
    expect(key).toContain("|sort:date");
    expect(key).toContain("|q:GET /api");
  });

  test("omits undefined params", () => {
    const key = buildPaginationContextKey("trace", "my-org/my-proj", {
      sort: "date",
      q: undefined,
    });
    expect(key).toContain("|sort:date");
    expect(key).not.toContain("|q:");
  });

  test("escapes pipe characters in param values", () => {
    const key = buildPaginationContextKey("org", "my-org", {
      q: "a|b",
    });
    expect(key).toContain("|q:a%7Cb");
    expect(key).not.toContain("|q:a|b");
  });
});

describe("buildMultiTargetContextKey", () => {
  test("isolates page sizes without changing existing callers' cursor keys", () => {
    const targets = [
      {
        org: "org",
        project: "project",
        orgDisplay: "Org",
        projectDisplay: "Project",
      },
    ];
    const existing = buildMultiTargetContextKey(targets, {
      query: "is:unresolved",
    });
    expect(existing).not.toContain("|limit:");
    expect(
      buildMultiTargetContextKey(targets, { query: "is:unresolved", limit: 10 })
    ).toBe(`${existing}|limit:10`);
    expect(buildMultiTargetContextKey(targets, { limit: 10 })).not.toBe(
      buildMultiTargetContextKey(targets, { limit: 25 })
    );
  });
});

describe("buildOrgContextKey", () => {
  test("delegates to buildPaginationContextKey", () => {
    const orgKey = buildOrgContextKey("test-org");
    const directKey = buildPaginationContextKey("org", "test-org");
    expect(orgKey).toBe(directKey);
  });
});
