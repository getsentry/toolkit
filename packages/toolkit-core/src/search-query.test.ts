/**
 * Issue-search rewrites in `rewriteSearchQuery`.
 *
 * The general AND/OR rules are covered through the CLI wrapper in
 * `packages/cli/test/lib/search-query*.test.ts`. These tests cover what
 * `issueSearch: true` adds: `is:` OR groups and paren unwrapping.
 */

import { describe, expect, it } from "vitest";
import { rewriteSearchQuery, SearchQueryError } from "./search-query.js";

function rewriteIssues(query: string): string {
  return rewriteSearchQuery(query, { issueSearch: true }).query;
}

describe("rewriteSearchQuery: return shape", () => {
  it("returns no notes when the query is unchanged", () => {
    expect(rewriteSearchQuery("is:unresolved level:error")).toEqual({
      query: "is:unresolved level:error",
      notes: [],
    });
  });

  it("returns a note per rewrite", () => {
    const result = rewriteSearchQuery("level:error AND project:123");
    expect(result.query).toBe("level:error project_id:123");
    expect(result.notes).toHaveLength(2);
  });

  it("throws SearchQueryError when OR can't be rewritten", () => {
    expect(() => rewriteSearchQuery("error OR timeout")).toThrow(
      SearchQueryError,
    );
  });
});

describe("rewriteSearchQuery: is: OR in issue search", () => {
  it("rewrites statuses to a status in-list", () => {
    expect(rewriteIssues("is:unresolved OR is:resolved OR is:ignored")).toBe(
      "status:[unresolved,resolved,ignored]",
    );
  });

  it("rewrites substatuses of one status to a substatus in-list", () => {
    expect(rewriteIssues("is:regressed OR is:escalating")).toBe(
      "substatus:[regressed,escalating]",
    );
    expect(
      rewriteIssues("is:archived_forever OR is:archived_until_escalating"),
    ).toBe("substatus:[archived_forever,archived_until_escalating]");
  });

  it("keeps surrounding filters", () => {
    expect(
      rewriteIssues("is:unresolved is:regressed OR is:escalating level:error"),
    ).toBe("is:unresolved substatus:[regressed,escalating] level:error");
  });

  it("drops duplicate values", () => {
    expect(rewriteIssues("is:new OR is:new")).toBe("substatus:[new]");
  });

  it.each([
    // The endpoint adds a status filter for the first substatus only.
    ["substatuses of different statuses", "is:ongoing OR is:archived_forever"],
    ["a status mixed with a substatus", "is:resolved OR is:regressed"],
    ["flags", "is:assigned OR is:unassigned"],
    ["negated is:", "!is:resolved OR !is:ignored"],
    ["is: mixed with another key", "is:resolved OR level:error"],
  ])("throws for %s", (_label, query) => {
    expect(() => rewriteIssues(query)).toThrow(SearchQueryError);
  });

  it("explains the status and substatus rewrites when it throws", () => {
    expect(() => rewriteIssues("is:resolved OR is:regressed")).toThrow(
      /status:\[resolved,ignored\][\s\S]*substatus:\[regressed,escalating\]/,
    );
  });

  it("leaves is: OR alone outside issue search", () => {
    expect(() => rewriteSearchQuery("is:regressed OR is:escalating")).toThrow(
      SearchQueryError,
    );
  });
});

describe("rewriteSearchQuery: parentheses in issue search", () => {
  it("unwraps a group that reduces to one in-list", () => {
    expect(rewriteIssues("is:unresolved (is:regressed OR is:escalating)")).toBe(
      "is:unresolved substatus:[regressed,escalating]",
    );
    expect(rewriteIssues("(level:error OR level:warning) is:unresolved")).toBe(
      "level:[error,warning] is:unresolved",
    );
  });

  it("unwraps a group without OR", () => {
    expect(rewriteIssues("(is:unresolved)")).toBe("is:unresolved");
    expect(rewriteIssues("(is:unresolved AND level:error) timeout")).toBe(
      "is:unresolved level:error timeout",
    );
  });

  it("unwraps nested groups", () => {
    expect(rewriteIssues("((level:error OR level:warning))")).toBe(
      "level:[error,warning]",
    );
  });

  it("merges a single-term group into a surrounding OR", () => {
    expect(rewriteIssues("(level:error) OR level:warning")).toBe(
      "level:[error,warning]",
    );
  });

  it("notes the unwrap", () => {
    expect(
      rewriteSearchQuery("(is:unresolved)", { issueSearch: true }),
    ).toEqual({
      query: "is:unresolved",
      notes: [
        "Issue search does not support parentheses — removed the grouping.",
      ],
    });
  });

  it.each([
    ["OR across keys", "is:unresolved (level:error OR assigned:me)"],
    [
      "a multi-term group inside OR",
      "(is:unresolved level:error) OR level:warning",
    ],
  ])("throws for %s", (_label, query) => {
    expect(() => rewriteIssues(query)).toThrow(SearchQueryError);
  });

  it("keeps parentheses outside issue search", () => {
    expect(rewriteSearchQuery("(is:unresolved)").query).toBe("(is:unresolved)");
  });
});
