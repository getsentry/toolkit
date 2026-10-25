/**
 * Unit tests for JSON formatting and field filtering.
 *
 * Note: Core invariants (idempotency, subset property, missing field handling,
 * primitive pass-through, array element filtering, deduplication, whitespace
 * tolerance) are tested via property-based tests in json.property.test.ts.
 * These tests focus on specific output documentation, edge cases, and the
 * writeJson/writeJsonList/formatJson APIs not covered by property tests.
 */

import { describe, expect, test } from "vitest";
import {
  filterFields,
  formatJson,
  parseFieldsList,
  writeJson,
  writeJsonList,
} from "../../../src/lib/formatters/json.js";

/**
 * Helper: cast to Record so filterFields calls don't fight
 * TypeScript's strict `Partial<T>` return type on `toEqual`.
 */
function filter(data: unknown, fields: string[]): unknown {
  return filterFields(data, fields);
}

describe("filterFields edge cases", () => {
  test("preserves unselected nested array positions for an indexed path", () => {
    expect(
      filter({ items: [[{ id: 1 }], [{ id: 2 }]] }, ["items.1.id"]),
    ).toEqual({ items: [[{}], [{ id: 2 }]] });
  });

  test("picks nested fields via dot-notation", () => {
    const data = {
      id: 1,
      metadata: { type: "error", value: "ReferenceError" },
      contexts: { trace: { traceId: "abc" } },
    };
    expect(
      filter(data, ["id", "metadata.value", "contexts.trace.traceId"]),
    ).toEqual({
      id: 1,
      metadata: { value: "ReferenceError" },
      contexts: { trace: { traceId: "abc" } },
    });
  });

  test("projects dotted attributes through nested arrays without changing keys", () => {
    const data = {
      spans: [
        {
          span_id: "root",
          data: { "http.method": "GET", unrelated: true },
          children: [{ data: { "http.method": "POST" } }],
        },
        { span_id: "other", data: { unrelated: true } },
      ],
    };
    expect(filter(data, ["spans.span_id", "spans.data.http.method"])).toEqual({
      spans: [
        { span_id: "root", data: { "http.method": "GET" } },
        { span_id: "other" },
      ],
    });
    expect(filter(data, ["spans.children.data.http.method"])).toEqual({
      spans: [{ children: [{ data: { "http.method": "POST" } }] }, {}],
    });
  });

  test("preserves literal key precedence at every nesting level", () => {
    const data = {
      "data.http.method": "root literal",
      data: {
        "http.method": "nested literal",
        http: { method: "nested object", status: 200 },
      },
    };
    expect(filter(data, ["data.http.method"])).toEqual({
      "data.http.method": "root literal",
    });
    expect(
      filter({ item: data.data }, ["item.http.method", "item.http.status"]),
    ).toEqual({
      item: { "http.method": "nested literal", http: { status: 200 } },
    });
  });

  test("unions nested selections and whole parents independently of order", () => {
    const data = {
      spans: [
        { span_id: "first", data: { "http.method": "GET", count: 0 } },
        { span_id: "second", data: { "http.method": "POST", count: 1 } },
      ],
    };
    const fields = ["spans.data.http.method", "spans.span_id", "spans.data"];
    expect(filter(data, fields)).toEqual(data);
    expect(filter(data, fields.toReversed())).toEqual(data);
    expect(filter(data, ["spans.data.http.method", "spans"])).toEqual(data);
    expect(filter(data, ["spans", "spans.data.http.method"])).toEqual(data);
  });

  test("does not mutate frozen nested source objects for overlapping fields", () => {
    const attributes = Object.freeze({ "http.method": "GET", count: 0 });
    const span = Object.freeze({ span_id: "first", data: attributes });
    const data = Object.freeze({ spans: Object.freeze([span]) });
    expect(
      filter(data, ["spans.data", "spans.data.http.method", "spans.span_id"]),
    ).toEqual(data);
    expect(data.spans[0]?.data).toEqual({ "http.method": "GET", count: 0 });
  });

  test("keeps nested array positions and empty arrays when fields are absent", () => {
    expect(
      filter({ spans: [{ id: "one" }, { other: true }], empty: [] }, [
        "spans.id",
        "empty.id",
        "missing.id",
      ]),
    ).toEqual({ spans: [{ id: "one" }, {}], empty: [] });
    expect(filter({ spans: [{ other: true }] }, ["spans.id"])).toEqual({
      spans: [{}],
    });
  });

  test("preserves array indices when mixing numeric and per-item selectors", () => {
    const data = {
      spans: [
        { id: "one", data: { "http.method": "GET" } },
        { id: "two", data: { "http.method": "POST" } },
        { id: "three" },
      ],
    };
    expect(filter(data, ["spans.1.data.http.method"])).toEqual({
      spans: [{}, { data: { "http.method": "POST" } }, {}],
    });
    const fields = ["spans.id", "spans.1.data.http.method", "spans.1"];
    const expected = {
      spans: [
        { id: "one" },
        { id: "two", data: { "http.method": "POST" } },
        { id: "three" },
      ],
    };
    expect(filter(data, fields)).toEqual(expected);
    expect(filter(data, fields.toReversed())).toEqual(expected);
    expect(filter(data, ["spans.10.id"])).toEqual({});
  });

  test("retains selected falsey values and omits null intermediate fields", () => {
    expect(
      filter(
        {
          spans: [
            { data: { count: 0, label: "", optional: null, unset: undefined } },
            { data: null },
            null,
          ],
        },
        [
          "spans.data.count",
          "spans.data.label",
          "spans.data.optional",
          "spans.data.unset",
        ],
      ),
    ).toEqual({
      spans: [
        { data: { count: 0, label: "", optional: null, unset: undefined } },
        {},
        null,
      ],
    });
    expect(filter({ spans: [{ data: null }] }, ["spans.data"])).toEqual({
      spans: [{ data: null }],
    });
  });

  test("preserves null values", () => {
    expect(filter({ id: 1, value: null }, ["id", "value"])).toEqual({
      id: 1,
      value: null,
    });
  });

  test("preserves undefined values when key exists", () => {
    expect(filter({ id: 1, value: undefined }, ["id", "value"])).toEqual({
      id: 1,
      value: undefined,
    });
  });

  test("stops at null intermediate in dot-path", () => {
    expect(filter({ a: { b: null } }, ["a.b.c"])).toEqual({});
  });

  test("stops at primitive intermediate in dot-path", () => {
    expect(filter({ a: { b: 42 } }, ["a.b.c"])).toEqual({});
  });

  test("merges nested paths into shared parents", () => {
    expect(
      filter({ user: { name: "Alice", email: "alice@example.com", age: 30 } }, [
        "user.name",
        "user.email",
      ]),
    ).toEqual({
      user: { name: "Alice", email: "alice@example.com" },
    });
  });

  test("handles boolean values in objects", () => {
    expect(
      filter({ active: true, deleted: false, name: "test" }, [
        "active",
        "deleted",
      ]),
    ).toEqual({
      active: true,
      deleted: false,
    });
  });

  test("handles nested array values", () => {
    expect(
      filter({ id: 1, tags: ["bug", "critical"], title: "test" }, [
        "id",
        "tags",
      ]),
    ).toEqual({
      id: 1,
      tags: ["bug", "critical"],
    });
  });
});

describe("parseFieldsList", () => {
  test("parses comma-separated fields", () => {
    expect(parseFieldsList("id,title,status")).toEqual([
      "id",
      "title",
      "status",
    ]);
  });

  test("trims whitespace around fields", () => {
    expect(parseFieldsList("  id , title , status  ")).toEqual([
      "id",
      "title",
      "status",
    ]);
  });

  test("handles dot-notation fields", () => {
    expect(parseFieldsList("id,metadata.value,contexts.trace.traceId")).toEqual(
      ["id", "metadata.value", "contexts.trace.traceId"],
    );
  });

  test("handles single field", () => {
    expect(parseFieldsList("id")).toEqual(["id"]);
  });

  test("returns empty array for empty string", () => {
    expect(parseFieldsList("")).toEqual([]);
  });
});

describe("writeJson with fields", () => {
  function capture(): {
    writer: { write: (s: string) => void };
    output: () => string;
  } {
    let buf = "";
    return {
      writer: {
        write: (s: string) => {
          buf += s;
        },
      },
      output: () => buf,
    };
  }

  test("without fields: outputs full object", () => {
    const { writer, output } = capture();
    const data = { id: 1, title: "bug", status: "open" };
    writeJson(writer, data);
    expect(JSON.parse(output())).toEqual(data);
  });

  test("with fields: outputs filtered object", () => {
    const { writer, output } = capture();
    writeJson(writer, { id: 1, title: "bug", status: "open", extra: true }, [
      "id",
      "title",
    ]);
    expect(JSON.parse(output())).toEqual({ id: 1, title: "bug" });
  });

  test("with empty fields array: outputs full object", () => {
    const { writer, output } = capture();
    const data = { id: 1, title: "bug" };
    writeJson(writer, data, []);
    expect(JSON.parse(output())).toEqual(data);
  });

  test("with undefined fields: outputs full object", () => {
    const { writer, output } = capture();
    const data = { id: 1, title: "bug" };
    writeJson(writer, data, undefined);
    expect(JSON.parse(output())).toEqual(data);
  });

  test("with dot-notation fields: outputs nested subset", () => {
    const { writer, output } = capture();
    writeJson(
      writer,
      {
        issue: { id: 1, title: "bug" },
        event: { id: "abc", contexts: { trace: { traceId: "def" } } },
      },
      ["issue.id", "event.contexts.trace.traceId"],
    );
    expect(JSON.parse(output())).toEqual({
      issue: { id: 1 },
      event: { contexts: { trace: { traceId: "def" } } },
    });
  });

  test("with array data: filters each element", () => {
    const { writer, output } = capture();
    writeJson(
      writer,
      [
        { id: 1, title: "first", extra: true },
        { id: 2, title: "second", extra: false },
      ],
      ["id", "title"],
    );
    expect(JSON.parse(output())).toEqual([
      { id: 1, title: "first" },
      { id: 2, title: "second" },
    ]);
  });
});

describe("formatJson", () => {
  test("pretty-prints with 2-space indentation", () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test("handles null", () => {
    expect(formatJson(null)).toBe("null");
  });

  test("handles arrays", () => {
    expect(formatJson([1, 2])).toBe("[\n  1,\n  2\n]");
  });
});

describe("writeJsonList", () => {
  function capture(): {
    writer: { write: (s: string) => void };
    output: () => string;
    parsed: () => unknown;
  } {
    let buf = "";
    return {
      writer: {
        write: (s: string) => {
          buf += s;
        },
      },
      output: () => buf,
      parsed: () => JSON.parse(buf),
    };
  }

  test("wraps items in {data, hasMore} envelope", () => {
    const { writer, parsed } = capture();
    const items = [{ id: 1 }, { id: 2 }];
    writeJsonList(writer, items, { hasMore: false });
    expect(parsed()).toEqual({ data: [{ id: 1 }, { id: 2 }], hasMore: false });
  });

  test("includes nextCursor when provided", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], {
      hasMore: true,
      nextCursor: "abc123",
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("abc123");
  });

  test("omits nextCursor when null", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], {
      hasMore: false,
      nextCursor: null,
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.nextCursor).toBeUndefined();
  });

  test("omits nextCursor when undefined", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], { hasMore: false });
    const result = parsed() as Record<string, unknown>;
    expect(result.nextCursor).toBeUndefined();
  });

  test("omits nextCursor when empty string", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], {
      hasMore: false,
      nextCursor: "",
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.nextCursor).toBeUndefined();
  });

  test("includes errors when non-empty", () => {
    const { writer, parsed } = capture();
    const errors = [{ message: "org failed" }];
    writeJsonList(writer, [{ id: 1 }], { hasMore: false, errors });
    const result = parsed() as Record<string, unknown>;
    expect(result.errors).toEqual(errors);
  });

  test("omits errors when empty array", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], { hasMore: false, errors: [] });
    const result = parsed() as Record<string, unknown>;
    expect(result.errors).toBeUndefined();
  });

  test("omits errors when undefined", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], { hasMore: false });
    const result = parsed() as Record<string, unknown>;
    expect(result.errors).toBeUndefined();
  });

  test("handles empty items array", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [], { hasMore: false });
    expect(parsed()).toEqual({ data: [], hasMore: false });
  });

  test("filters each array element when fields provided", () => {
    const { writer, parsed } = capture();
    const items = [
      { id: 1, title: "Bug", status: "open", extra: true },
      { id: 2, title: "Feature", status: "closed", extra: false },
    ];
    writeJsonList(writer, items, {
      hasMore: true,
      fields: ["id", "title"],
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.data).toEqual([
      { id: 1, title: "Bug" },
      { id: 2, title: "Feature" },
    ]);
    expect(result.hasMore).toBe(true);
  });

  test("does not filter wrapper metadata keys", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1, title: "Bug" }], {
      hasMore: true,
      nextCursor: "xyz",
      fields: ["id"],
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("xyz");
  });

  test("with empty fields array: outputs full items (no filtering)", () => {
    const { writer, parsed } = capture();
    const items = [{ id: 1, title: "Bug", extra: true }];
    writeJsonList(writer, items, { hasMore: false, fields: [] });
    const result = parsed() as Record<string, unknown>;
    expect(result.data).toEqual(items);
  });

  test("with undefined fields: outputs full items (no filtering)", () => {
    const { writer, parsed } = capture();
    const items = [{ id: 1, title: "Bug", extra: true }];
    writeJsonList(writer, items, { hasMore: false, fields: undefined });
    const result = parsed() as Record<string, unknown>;
    expect(result.data).toEqual(items);
  });

  test("supports dot-notation field filtering on nested items", () => {
    const { writer, parsed } = capture();
    const items = [
      { id: 1, metadata: { type: "error", value: "ReferenceError" } },
      { id: 2, metadata: { type: "warning", value: "DeprecationWarning" } },
    ];
    writeJsonList(writer, items, {
      hasMore: false,
      fields: ["id", "metadata.value"],
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.data).toEqual([
      { id: 1, metadata: { value: "ReferenceError" } },
      { id: 2, metadata: { value: "DeprecationWarning" } },
    ]);
  });

  test("includes extra metadata in wrapper", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1 }], {
      hasMore: true,
      extra: { hint: "sentry project list my-org/ --json" },
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.hint).toBe("sentry project list my-org/ --json");
    expect(result.hasMore).toBe(true);
  });

  test("extra metadata does not interfere with fields filtering", () => {
    const { writer, parsed } = capture();
    writeJsonList(writer, [{ id: 1, title: "Bug", extra: true }], {
      hasMore: true,
      fields: ["id"],
      extra: { hint: "use --cursor" },
    });
    const result = parsed() as Record<string, unknown>;
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.hint).toBe("use --cursor");
  });

  test("output ends with newline", () => {
    const { writer, output } = capture();
    writeJsonList(writer, [{ id: 1 }], { hasMore: false });
    expect(output().endsWith("\n")).toBe(true);
  });
});
