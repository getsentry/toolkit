/**
 * Pagination context keys and persisted request metadata.
 * Cursor-stack invariants live in pagination.model-based.test.ts.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { clearAuth } from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  advancePaginationState,
  buildMultiTargetContextKey,
  buildOrgContextKey,
  buildPaginationContextKey,
  getPaginationRequests,
  getPaginationState,
} from "../../../src/lib/db/pagination.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("pagination-requests-");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pagination request metadata", () => {
  const url =
    "https://sentry.io/api/0/organizations/example/issues/?query=open";

  test("stores the request with its page and preserves it through navigation", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    advancePaginationState("api", "query", "first", "page-2", {
      currentCursor: "",
      request: { scope: "workspace", url },
    });

    expect(
      getDatabase()
        .query(
          "SELECT cursor_stack, page_index, expires_at, request_scope, request_url FROM pagination_cursors WHERE command_key = 'api' AND context = 'query'",
        )
        .get(),
    ).toEqual({
      cursor_stack: JSON.stringify(["", "page-2"]),
      page_index: 0,
      expires_at: 1_300_000,
      request_scope: "workspace",
      request_url: url,
    });

    now.mockReturnValue(1_200_000);
    advancePaginationState("api", "query", "next", undefined, {
      currentCursor: "page-2",
    });
    now.mockReturnValue(1_400_000);
    expect(getPaginationRequests("api", "workspace")).toEqual([
      { contextKey: "query", url },
    ]);
    expect(getPaginationState("api", "query")).toEqual({
      stack: ["", "page-2"],
      index: 1,
    });

    advancePaginationState("api", "query", "prev", "page-2", {
      currentCursor: "",
    });
    advancePaginationState("api", "query", "first", "page-2", {
      currentCursor: "",
    });
    expect(getPaginationRequests("api", "workspace")).toEqual([
      { contextKey: "query", url },
    ]);
  });

  test("replaces a request with an opaque blocker without retaining its old URL", () => {
    advancePaginationState("api", "query", "first", "page-2", {
      currentCursor: "",
      request: { scope: "workspace", url },
    });
    advancePaginationState("api", "query", "next", undefined, {
      currentCursor: "page-2",
      request: { scope: "new-workspace" },
    });

    expect(getPaginationRequests("api", "workspace")).toEqual([]);
    expect(getPaginationRequests("api", "new-workspace")).toEqual([
      { contextKey: "query", url: undefined },
    ]);
    expect(
      getDatabase()
        .query("SELECT page_index, request_url FROM pagination_cursors")
        .get(),
    ).toEqual({ page_index: 1, request_url: null });
  });

  test("keeps exhausted walks and opaque requests when detecting ambiguity", () => {
    advancePaginationState("api", "exhausted", "first", undefined, {
      request: { scope: "workspace", url },
    });
    advancePaginationState("api", "opaque", "first", "page-2", {
      request: { scope: "workspace" },
    });
    advancePaginationState("api", "another-scope", "first", "page-2", {
      request: { scope: "other-workspace", url },
    });
    advancePaginationState("other", "another-command", "first", "next", {
      request: { scope: "workspace", url },
    });
    advancePaginationState("api", "legacy", "first", "page-2");

    expect(getPaginationRequests("api", "workspace")).toEqual(
      expect.arrayContaining([
        { contextKey: "exhausted", url },
        { contextKey: "opaque", url: undefined },
      ]),
    );
    advancePaginationState("api", "third", "first", "page-2", {
      request: { scope: "workspace", url },
    });
    expect(getPaginationRequests("api", "workspace")).toHaveLength(2);
  });

  test.each(["lookup", "write"])(
    "removes expired request metadata during %s",
    (operation) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      advancePaginationState("api", "expired", "first", "page-2", {
        request: { scope: "old-workspace", url },
      });
      now.mockReturnValue(1_300_000);

      if (operation === "lookup") {
        expect(getPaginationRequests("api", "workspace")).toEqual([]);
      } else {
        advancePaginationState("api", "new", "first", "page-2");
      }

      expect(
        getDatabase()
          .query("SELECT context FROM pagination_cursors WHERE context = ?")
          .get("expired"),
      ).toBeNull();
    },
  );

  test("logout removes the saved request together with its cursor stack", async () => {
    advancePaginationState("api", "query", "first", "page-2", {
      request: { scope: "workspace", url },
    });

    await clearAuth();

    expect(getPaginationRequests("api", "workspace")).toEqual([]);
    expect(getPaginationState("api", "query")).toBeUndefined();
  });
});

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
      buildMultiTargetContextKey(targets, {
        query: "is:unresolved",
        limit: 10,
      }),
    ).toBe(`${existing}|limit:10`);
    expect(buildMultiTargetContextKey(targets, { limit: 10 })).not.toBe(
      buildMultiTargetContextKey(targets, { limit: 25 }),
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
