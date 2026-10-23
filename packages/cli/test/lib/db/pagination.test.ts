/**
 * Unit tests for pagination context key builders and cursor storage.
 */

import { describe, expect, test } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  advancePaginationState,
  buildMultiTargetContextKey,
  buildOrgContextKey,
  buildPaginationContextKey,
  clearPaginationState,
  resolveCursor,
} from "../../../src/lib/db/pagination.js";
import { useTestConfigDir } from "../../helpers.js";

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

describe("cursor storage across CLI versions", () => {
  useTestConfigDir("pagination-versions-");

  const CMD = "trace-list";
  const CTX = "host:sentry.io|type:org:my-org";

  /** Write a row the way a CLI version without the format namespace did. */
  function writeUnversionedRow(stack: string[]): void {
    getDatabase()
      .query(
        `INSERT OR REPLACE INTO pagination_cursors
           (command_key, context, cursor_stack, page_index, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(CMD, CTX, JSON.stringify(stack), 0, Date.now() + 60_000);
  }

  function unversionedStack(): string | undefined {
    const row = getDatabase()
      .query(
        "SELECT cursor_stack FROM pagination_cursors WHERE command_key = ? AND context = ?",
      )
      .get(CMD, CTX) as { cursor_stack: string } | undefined;
    return row?.cursor_stack;
  }

  test("ignores history written in another cursor format", () => {
    writeUnversionedRow(["", "1735689600:0:0"]);
    expect(() => resolveCursor("next", CMD, CTX)).toThrow(
      "No next page saved for this query",
    );
  });

  test("never overwrites or clears another format's history", () => {
    writeUnversionedRow(["", "1735689600:0:0"]);
    advancePaginationState(CMD, CTX, "first", "cli1~100~0~abc");

    expect(resolveCursor("next", CMD, CTX).cursor).toBe("cli1~100~0~abc");
    expect(unversionedStack()).toBe(JSON.stringify(["", "1735689600:0:0"]));

    clearPaginationState(CMD, CTX);
    expect(() => resolveCursor("next", CMD, CTX)).toThrow(
      "No next page saved for this query",
    );
    expect(unversionedStack()).toBe(JSON.stringify(["", "1735689600:0:0"]));
  });
});
