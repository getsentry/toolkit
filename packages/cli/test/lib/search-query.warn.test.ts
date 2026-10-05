/**
 * Warning copy for stacked search-query rewrites.
 *
 * `sanitizeQuery` must emit one warn: reasons, then a newline, then
 * `Running query:` quoting the string that is actually sent.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const { fakeLog } = vi.hoisted(() => {
  const log = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    withTag() {
      return log;
    },
  };
  return { fakeLog: log };
});

vi.mock("../../src/lib/logger.js", () => ({
  logger: fakeLog,
}));

const { sanitizeQuery } = await import("../../src/lib/search-query.js");

function runningQueries(): string[] {
  return fakeLog.warn.mock.calls
    .map((call) => String(call[0]))
    .filter((msg) => msg.includes("Running query:"));
}

describe("sanitizeQuery: rewrite warnings", () => {
  beforeEach(() => {
    fakeLog.warn.mockClear();
  });

  test("numeric project: plus OR warns once with the final in-list", () => {
    expect(sanitizeQuery("project:123 OR project:456")).toBe(
      "project_id:[123,456]"
    );
    const warns = runningQueries();
    expect(warns).toHaveLength(1);
    expect(warns[0].split("\n")).toEqual([
      "`project` is the slug; numeric ids use project_id. Rewrote numeric project: filters. Rewrote OR using in-list syntax: key:[val1,val2].",
      'Running query: "project_id:[123,456]"',
    ]);
    expect(warns[0]).not.toContain("project_id:123 OR project_id:456");
  });

  test("numeric project: plus AND warns once with the stripped query", () => {
    expect(sanitizeQuery("project:123 AND is:unresolved")).toBe(
      "project_id:123 is:unresolved"
    );
    const warns = runningQueries();
    expect(warns).toHaveLength(1);
    expect(warns[0].split("\n")).toEqual([
      "`project` is the slug; numeric ids use project_id. Rewrote numeric project: filters. Sentry search implicitly ANDs terms — removed explicit AND operator.",
      'Running query: "project_id:123 is:unresolved"',
    ]);
  });

  test("OR-only still warns once with the in-list", () => {
    expect(sanitizeQuery("level:error OR level:warning")).toBe(
      "level:[error,warning]"
    );
    const warns = runningQueries();
    expect(warns).toHaveLength(1);
    expect(warns[0].split("\n")).toEqual([
      "Rewrote OR using in-list syntax: key:[val1,val2].",
      'Running query: "level:[error,warning]"',
    ]);
  });

  test("does not warn Running query: when OR rewrite fails", () => {
    expect(() => sanitizeQuery("level:error OR assigned:me")).toThrow();
    expect(runningQueries()).toHaveLength(0);
  });

  test("does not warn Running query: when numeric rewrite is followed by a failed OR", () => {
    expect(() => sanitizeQuery("project:123 OR assigned:me")).toThrow();
    expect(runningQueries()).toHaveLength(0);
  });

  test("still warns about the numeric rewrite when the query does not parse", () => {
    // Unmatched paren → PEG parse fails → passthrough. The rewrite already
    // happened, and the API 400 will quote project_id, so the user must
    // be told.
    expect(sanitizeQuery("project:123 ((( broken")).toBe(
      "project_id:123 ((( broken"
    );
    const warns = runningQueries();
    expect(warns).toHaveLength(1);
    expect(warns[0].split("\n")).toEqual([
      "`project` is the slug; numeric ids use project_id. Rewrote numeric project: filters.",
      'Running query: "project_id:123 ((( broken"',
    ]);
  });

  test("does not warn on unparseable passthrough with no rewrites", () => {
    expect(sanitizeQuery("((( broken")).toBe("((( broken");
    expect(runningQueries()).toHaveLength(0);
  });
});
