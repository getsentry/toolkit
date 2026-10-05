// biome-ignore-all lint/performance/useTopLevelRegex: regex in test assertions is fine
/**
 * API Command Unit Tests
 *
 * Tests for parsing functions in the api command.
 */

import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  apiCommand,
  buildBodyFromFields,
  buildBodyFromInput,
  buildFromFields,
  buildQueryParams,
  buildQueryParamsFromFields,
  buildRawQueryParams,
  dataToQueryParams,
  extractJsonBody,
  formatApiResponse,
  formatBinaryErrorBody,
  isApiErrorStatus,
  normalizeEndpoint,
  normalizeFields,
  parseDataBody,
  parseFieldKey,
  parseFields,
  parseHeaders,
  parseOrgProjectFromApiPath,
  prepareRequestOptions,
  readStdin,
  resolveApiResponseOutput,
  resolveBinaryTtyOutput,
  resolveBody,
  resolveEffectiveHeaders,
  resolveRequestUrl,
  setNestedValue,
} from "../../src/commands/api.js";
import { OutputError, ValidationError } from "../../src/lib/errors.js";

/**
 * Create a mock stdin stream from a string
 */
function createMockStdin(content: string): NodeJS.ReadStream & { fd: 0 } {
  const readable = Readable.from([content]);
  // Cast to match expected stdin type
  return readable as unknown as NodeJS.ReadStream & { fd: 0 };
}

// Note: Basic behavior for normalizeEndpoint, parseMethod, parseFieldValue, parseFieldKey,
// and setNestedValue is tested via property-based tests in api.property.test.ts.
// The tests below focus on specific edge cases and error message verification.

describe("normalizeEndpoint edge cases", () => {
  test("handles empty string", () => {
    expect(normalizeEndpoint("")).toBe("/");
  });

  test("handles just a slash", () => {
    expect(normalizeEndpoint("/")).toBe("/");
  });
});

describe("normalizeEndpoint: api/0/ prefix stripping (CLI-K1)", () => {
  test("strips api/0/ prefix to avoid doubled path", () => {
    expect(normalizeEndpoint("api/0/projects/my-org/my-project/")).toBe(
      "projects/my-org/my-project/"
    );
  });

  test("strips /api/0/ prefix with leading slash", () => {
    expect(normalizeEndpoint("/api/0/projects/my-org/my-project/")).toBe(
      "projects/my-org/my-project/"
    );
  });

  test("strips api/0/ prefix and adds trailing slash", () => {
    expect(normalizeEndpoint("api/0/organizations/my-org/issues")).toBe(
      "organizations/my-org/issues/"
    );
  });

  test("strips api/0/ prefix with query string", () => {
    expect(
      normalizeEndpoint(
        "api/0/projects/my-org/my-proj/environments/?visibility=visible"
      )
    ).toBe("projects/my-org/my-proj/environments/?visibility=visible");
  });

  test("strips bare api/0 for idempotency", () => {
    // "api/0" → "/" so that normalizing twice is stable
    expect(normalizeEndpoint("api/0")).toBe("/");
  });

  test("strips regional origins from absolute URLs", () => {
    expect(
      normalizeEndpoint(
        "https://de.sentry.io/sentry/api/0/projects/my-org/my-project/events/abc/attachments/1/?download=1"
      )
    ).toBe("projects/my-org/my-project/events/abc/attachments/1/?download=1");
  });

  test("does not strip partial api/ prefix", () => {
    expect(normalizeEndpoint("api/1/organizations/")).toBe(
      "api/1/organizations/"
    );
  });
});

describe("parseOrgProjectFromApiPath", () => {
  test.each([
    ["organizations/acme/issues/", { org: "acme" }],
    ["projects/acme/web/events/", { org: "acme", project: "web" }],
    ["teams/acme/engineering/", { org: "acme" }],
    ["organizations/", undefined],
    ["organizations/{organization_id_or_slug}/issues/", undefined],
    ["issues/", undefined],
  ] as const)("%s", (path, expected) => {
    expect(parseOrgProjectFromApiPath(path)).toEqual(expected);
  });
});

describe("apiCommand tags org from the path", () => {
  let setTagSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTagSpy = vi.spyOn(Sentry, "setTag");
  });

  afterEach(() => {
    setTagSpy.mockRestore();
  });

  test("dry-run of a projects path sets sentry.org and sentry.project", async () => {
    const func = await apiCommand.loader();
    const context = {
      stdin: createMockStdin(""),
      stdout: { write: vi.fn(() => true), isTTY: false },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    };
    await func.call(
      context,
      {
        method: "GET",
        silent: false,
        verbose: false,
        "dry-run": true,
        json: false,
      },
      "projects/acme/web/events/"
    );

    expect(setTagSpy).toHaveBeenCalledWith("sentry.org", "acme");
    expect(setTagSpy).toHaveBeenCalledWith("sentry.project", "web");
  });
});

describe("normalizeEndpoint: path traversal hardening (#350)", () => {
  test("rejects bare .. traversal", () => {
    expect(() => normalizeEndpoint("..")).toThrow(/path traversal/);
  });

  test("rejects leading ../ traversal", () => {
    expect(() => normalizeEndpoint("../../admin/settings/")).toThrow(
      /path traversal/
    );
  });

  test("rejects mid-path traversal", () => {
    expect(() => normalizeEndpoint("organizations/my-org/../admin/")).toThrow(
      /path traversal/
    );
  });

  test("rejects traversal with leading slash", () => {
    expect(() => normalizeEndpoint("/../../admin/")).toThrow(/path traversal/);
  });

  test("rejects traversal before normalizing an absolute URL", () => {
    expect(() =>
      normalizeEndpoint("https://sentry.io/api/0/projects/acme/%2e%2e/admin/")
    ).toThrow(/path traversal/);
  });

  test("allows single dots in paths", () => {
    expect(normalizeEndpoint("organizations/.well-known/")).toBe(
      "organizations/.well-known/"
    );
  });

  test("allows double dots inside segment names", () => {
    expect(normalizeEndpoint("organizations/my..org/")).toBe(
      "organizations/my..org/"
    );
  });

  test("rejects control characters in endpoint", () => {
    expect(() => normalizeEndpoint("organizations/\x00admin/")).toThrow(
      /Invalid/
    );
  });

  test("strips newlines from multi-line pasted endpoints (CLI-FR)", () => {
    expect(
      normalizeEndpoint(
        "organizations/my-org/issues/?\n  environment=Production&project=123"
      )
    ).toBe("organizations/my-org/issues/?environment=Production&project=123");
  });

  test("strips carriage returns and surrounding indentation", () => {
    expect(normalizeEndpoint("organizations/my-org/\r\n  issues/")).toBe(
      "organizations/my-org/issues/"
    );
  });

  test("preserves tabs within segments (not line-break related)", () => {
    // Tabs without adjacent line breaks are control chars — rejected
    expect(() => normalizeEndpoint("organizations/\tmy-org/")).toThrow(
      /Invalid/
    );
  });
});

describe("parseFieldKey error cases", () => {
  test("throws for invalid format with unmatched brackets", () => {
    expect(() => parseFieldKey("user[name")).toThrow(
      /Invalid field key format/
    );
    expect(() => parseFieldKey("user]name[")).toThrow(
      /Invalid field key format/
    );
  });

  test("throws for nested brackets", () => {
    expect(() => parseFieldKey("user[[name]]")).toThrow(
      /Invalid field key format/
    );
  });

  test("parses key with multiple consecutive empty brackets", () => {
    // This is valid syntax: creates path ["a", "", ""]
    // But validatePathSegments will reject it for having [] not at end
    // Testing that parsing itself works
    expect(parseFieldKey("a[][]")).toEqual(["a", "", ""]);
  });
});

describe("setNestedValue type conflicts", () => {
  // Type conflict tests verify specific error messages (matching gh api behavior)
  test("throws when traversing into string (simple then nested)", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "user", "John");
    expect(() => setNestedValue(obj, "user[name]", "Jane")).toThrow(
      /expected map type under "user", got string/
    );
  });

  test("throws when traversing into number", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "count", 42);
    expect(() => setNestedValue(obj, "count[value]", 100)).toThrow(
      /expected map type under "count", got number/
    );
  });

  test("throws when pushing to non-array (simple then array)", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "tags", "foo");
    expect(() => setNestedValue(obj, "tags[]", "bar")).toThrow(
      /expected array type under "tags", got string/
    );
  });

  test("throws when pushing to object", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "tags[name]", "foo");
    expect(() => setNestedValue(obj, "tags[]", "bar")).toThrow(
      /expected array type under "tags", got map/
    );
  });

  test("throws when nesting into array", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "items[]", "first");
    expect(() => setNestedValue(obj, "items[key]", "value")).toThrow(
      /expected map type under "items", got array/
    );
  });

  test("allows overwriting nested with simple value", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "user[name]", "Jane");
    setNestedValue(obj, "user", "John");
    expect(obj).toEqual({ user: "John" });
  });

  test("throws when traversing into boolean", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "flag", true);
    expect(() => setNestedValue(obj, "flag[value]", "test")).toThrow(
      /expected map type under "flag", got boolean/
    );
  });

  test("throws when traversing into null", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "empty", null);
    expect(() => setNestedValue(obj, "empty[value]", "test")).toThrow(
      /expected map type under "empty", got/
    );
  });

  test("throws when pushing to boolean", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "flag", false);
    expect(() => setNestedValue(obj, "flag[]", "item")).toThrow(
      /expected array type under "flag", got boolean/
    );
  });

  test("throws when pushing to null", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "empty", null);
    expect(() => setNestedValue(obj, "empty[]", "item")).toThrow(
      /expected array type under "empty", got/
    );
  });

  test("handles deeply nested type conflict with correct path in error", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "a[b][c]", "value");
    expect(() => setNestedValue(obj, "a[b][c][d]", "nested")).toThrow(
      /expected map type under "a\[b\]\[c\]", got string/
    );
  });

  test("handles array type conflict at nested level with correct path", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "a[b][]", "item");
    expect(() => setNestedValue(obj, "a[b][key]", "value")).toThrow(
      /expected map type under "a\[b\]", got array/
    );
  });
});

describe("parseFields", () => {
  test("parses single field", () => {
    expect(parseFields(["key=value"])).toEqual({ key: "value" });
  });

  test("parses multiple fields", () => {
    expect(parseFields(["a=1", "b=2"])).toEqual({ a: 1, b: 2 });
  });

  test("parses nested fields with bracket notation", () => {
    expect(parseFields(["user[name]=John", "user[age]=30"])).toEqual({
      user: { name: "John", age: 30 },
    });
  });

  test("parses deeply nested fields", () => {
    expect(parseFields(["a[b][c][d]=value"])).toEqual({
      a: { b: { c: { d: "value" } } },
    });
  });

  test("parses JSON values in fields", () => {
    expect(parseFields(["tags=[1,2,3]", "active=true"])).toEqual({
      tags: [1, 2, 3],
      active: true,
    });
  });

  test("handles value with equals sign", () => {
    expect(parseFields(["query=a=b"])).toEqual({ query: "a=b" });
  });

  test("handles array push syntax", () => {
    expect(parseFields(["tags[]=foo", "tags[]=bar"])).toEqual({
      tags: ["foo", "bar"],
    });
  });

  test("handles empty array syntax", () => {
    expect(parseFields(["tags[]"])).toEqual({ tags: [] });
  });

  test("handles mixed object and array fields", () => {
    expect(
      parseFields([
        "user[name]=John",
        "user[roles][]=admin",
        "user[roles][]=editor",
      ])
    ).toEqual({
      user: { name: "John", roles: ["admin", "editor"] },
    });
  });

  test("throws ValidationError for invalid field format without equals", () => {
    expect(() => parseFields(["invalid"])).toThrow(ValidationError);
    expect(() => parseFields(["invalid"])).toThrow(/Invalid field format/);
    expect(() => parseFields(["no-equals"])).toThrow(/Invalid field format/);
  });

  test("allows empty array syntax without equals", () => {
    // This should NOT throw - it's valid empty array syntax
    expect(() => parseFields(["items[]"])).not.toThrow();
  });

  test("returns empty object for empty array", () => {
    expect(parseFields([])).toEqual({});
  });

  test("handles field with empty key", () => {
    // Empty string before = should throw
    expect(() => parseFields(["=value"])).toThrow(/Invalid field key format/);
  });

  test("handles deeply nested array push", () => {
    expect(parseFields(["a[b][c][]=item1", "a[b][c][]=item2"])).toEqual({
      a: { b: { c: ["item1", "item2"] } },
    });
  });

  test("handles overwriting array with object", () => {
    // First create array, then try to treat it as object - should throw
    expect(() => parseFields(["items[]=first", "items[key]=value"])).toThrow(
      /expected map type/
    );
  });

  test("handles overwriting object with array", () => {
    // First create object, then try to treat it as array - should throw
    expect(() => parseFields(["items[key]=value", "items[]=item"])).toThrow(
      /expected array type/
    );
  });
});

describe("normalizeFields", () => {
  let stderrOutput: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrOutput = "";
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("passes through fields that already have '='", () => {
    expect(normalizeFields(["status=resolved", "project=my-proj"])).toEqual([
      "status=resolved",
      "project=my-proj",
    ]);
    expect(stderrOutput).toBe("");
  });

  test("passes through empty-array syntax 'key[]' without warning", () => {
    expect(normalizeFields(["tags[]"])).toEqual(["tags[]"]);
    expect(stderrOutput).toBe("");
  });

  test("corrects ':' separator and emits warning — CLI-9H case", () => {
    expect(normalizeFields(["project:4510942921490432"])).toEqual([
      "project=4510942921490432",
    ]);
    expect(stderrOutput).toContain("project=4510942921490432");
    expect(stderrOutput).toContain("warn");
  });

  test("corrects ':' separator on timestamp values, preserving colons in value — CLI-93 case", () => {
    expect(normalizeFields(["since:2026-02-25T11:20:00"])).toEqual([
      "since=2026-02-25T11:20:00",
    ]);
    expect(stderrOutput).toContain("since=2026-02-25T11:20:00");
  });

  test("corrects ':' separator on URL values, preserving colons in value", () => {
    expect(normalizeFields(["url:https://example.com:8080/path"])).toEqual([
      "url=https://example.com:8080/path",
    ]);
    expect(stderrOutput).toContain("url=https://example.com:8080/path");
  });

  test("corrects ':' separator and emits one warning per field", () => {
    normalizeFields(["status:resolved", "project:my-proj"]);
    // Each corrected field produces a separate log.warn call
    const warnings = stderrOutput.split("\n").filter((l) => l.includes("warn"));
    expect(warnings).toHaveLength(2);
  });

  test("returns field unchanged when no '=' and no ':' (parser will throw)", () => {
    expect(normalizeFields(["invalid"])).toEqual(["invalid"]);
    expect(stderrOutput).toBe("");
  });

  test("returns field unchanged when ':' is the first character", () => {
    // Empty key — uncorrectable, let parser throw
    expect(normalizeFields([":value"])).toEqual([":value"]);
    expect(stderrOutput).toBe("");
  });

  test("returns undefined when given undefined", () => {
    expect(normalizeFields(undefined)).toBeUndefined();
  });

  test("returns empty array when given empty array", () => {
    expect(normalizeFields([])).toEqual([]);
  });

  test("mixes corrected and pass-through fields correctly", () => {
    expect(normalizeFields(["status:resolved", "limit=10", "tags[]"])).toEqual([
      "status=resolved",
      "limit=10",
      "tags[]",
    ]);
    // Only the one corrected field emits a warning
    const warnings = stderrOutput.split("\n").filter((l) => l.includes("warn"));
    expect(warnings).toHaveLength(1);
  });

  test("does not mangle JSON objects — passes through unchanged (CLI-AF)", () => {
    const json = '{"status":"ignored","statusDetails":{"ignoreCount":1}}';
    expect(normalizeFields([json])).toEqual([json]);
    // No colon-correction warning should be emitted for JSON
    expect(stderrOutput).toBe("");
  });

  test("does not mangle JSON arrays — passes through unchanged", () => {
    const json = '["one","two","three"]';
    expect(normalizeFields([json])).toEqual([json]);
    expect(stderrOutput).toBe("");
  });

  test("JSON-shaped fields coexist with other fields", () => {
    const json = '{"key":"value"}';
    expect(normalizeFields([json, "status:resolved", "limit=10"])).toEqual([
      json,
      "status=resolved",
      "limit=10",
    ]);
    // Only the colon-separated field emits a warning, not the JSON
    const warnings = stderrOutput.split("\n").filter((l) => l.includes("warn"));
    expect(warnings).toHaveLength(1);
  });
});

describe("parseFields with raw=true (--raw-field behavior)", () => {
  test("keeps number values as strings", () => {
    expect(parseFields(["count=123"], true)).toEqual({ count: "123" });
    expect(parseFields(["price=3.14"], true)).toEqual({ price: "3.14" });
  });

  test("keeps boolean values as strings", () => {
    expect(parseFields(["active=true"], true)).toEqual({ active: "true" });
    expect(parseFields(["enabled=false"], true)).toEqual({ enabled: "false" });
  });

  test("keeps null as string", () => {
    expect(parseFields(["value=null"], true)).toEqual({ value: "null" });
  });

  test("keeps JSON arrays as strings", () => {
    expect(parseFields(["tags=[1,2,3]"], true)).toEqual({ tags: "[1,2,3]" });
  });

  test("keeps JSON objects as strings", () => {
    expect(parseFields(['data={"a":1}'], true)).toEqual({ data: '{"a":1}' });
  });

  test("keeps plain strings as strings", () => {
    expect(parseFields(["name=John"], true)).toEqual({ name: "John" });
  });

  test("handles nested keys with raw values", () => {
    expect(parseFields(["user[age]=30"], true)).toEqual({
      user: { age: "30" },
    });
  });

  test("handles empty value", () => {
    expect(parseFields(["empty="], true)).toEqual({ empty: "" });
  });

  test("comparison: raw vs typed for same input", () => {
    // Typed (default): parses JSON
    expect(parseFields(["count=123"])).toEqual({ count: 123 });
    // Raw: keeps as string
    expect(parseFields(["count=123"], true)).toEqual({ count: "123" });
  });
});

describe("parseHeaders", () => {
  test("parses single header", () => {
    expect(parseHeaders(["Content-Type: application/json"])).toEqual({
      "Content-Type": "application/json",
    });
  });

  test("parses multiple headers", () => {
    expect(
      parseHeaders(["Content-Type: application/json", "Accept: text/plain"])
    ).toEqual({
      "Content-Type": "application/json",
      Accept: "text/plain",
    });
  });

  test("trims whitespace around key and value", () => {
    expect(parseHeaders(["  Key  :  Value  "])).toEqual({ Key: "Value" });
  });

  test("handles value with colon", () => {
    expect(parseHeaders(["Time: 12:30:00"])).toEqual({ Time: "12:30:00" });
  });

  test("throws for invalid header format", () => {
    expect(() => parseHeaders(["invalid"])).toThrow(/Invalid header format/);
    expect(() => parseHeaders(["no-colon"])).toThrow(/Invalid header format/);
  });

  test("returns empty object for empty array", () => {
    expect(parseHeaders([])).toEqual({});
  });
});

describe("buildQueryParams", () => {
  test("builds simple key=value params", () => {
    expect(buildQueryParams(["status=resolved", "limit=10"])).toEqual({
      status: "resolved",
      limit: "10",
    });
  });

  test("handles arrays as repeated keys", () => {
    expect(buildQueryParams(["tags=[1,2,3]"])).toEqual({
      tags: ["1", "2", "3"],
    });
  });

  test("handles arrays of strings", () => {
    expect(buildQueryParams(['names=["alice","bob"]'])).toEqual({
      names: ["alice", "bob"],
    });
  });

  test("converts all values to strings", () => {
    expect(buildQueryParams(["count=42", "active=true", "value=null"])).toEqual(
      {
        count: "42",
        active: "true",
        value: "null",
      }
    );
  });

  test("handles value with equals sign", () => {
    expect(buildQueryParams(["query=a=b"])).toEqual({ query: "a=b" });
  });

  test("throws ValidationError for invalid field format", () => {
    expect(() => buildQueryParams(["invalid"])).toThrow(ValidationError);
    expect(() => buildQueryParams(["invalid"])).toThrow(/Invalid field format/);
    expect(() => buildQueryParams(["no-equals"])).toThrow(
      /Invalid field format/
    );
  });

  test("returns empty object for empty array", () => {
    expect(buildQueryParams([])).toEqual({});
  });

  test("handles objects by JSON stringifying them", () => {
    expect(buildQueryParams(['data={"key":"value"}'])).toEqual({
      data: '{"key":"value"}',
    });
  });

  test("handles nested objects by JSON stringifying them", () => {
    expect(buildQueryParams(['filter={"user":{"name":"john"}}'])).toEqual({
      filter: '{"user":{"name":"john"}}',
    });
  });

  test("handles arrays of objects by JSON stringifying each element", () => {
    expect(
      buildQueryParams(['filters=[{"key":"value"},{"key2":"value2"}]'])
    ).toEqual({
      filters: ['{"key":"value"}', '{"key2":"value2"}'],
    });
  });

  test("handles mixed arrays with objects and primitives", () => {
    expect(buildQueryParams(['data=[1,{"obj":true},"string"]'])).toEqual({
      data: ["1", '{"obj":true}', "string"],
    });
  });

  test("throws for empty key", () => {
    expect(() => buildQueryParams(["=value"])).toThrow(
      /Invalid field key format/
    );
  });

  test("throws for invalid key format with unmatched brackets", () => {
    expect(() => buildQueryParams(["key[=value"])).toThrow(
      /Invalid field key format/
    );
    expect(() => buildQueryParams(["key]=value"])).toThrow(
      /Invalid field key format/
    );
  });

  test("accepts valid bracket notation keys", () => {
    expect(buildQueryParams(["user[name]=John"])).toEqual({
      "user[name]": "John",
    });
    expect(buildQueryParams(["tags[]=item"])).toEqual({ "tags[]": "item" });
  });
});

describe("buildRawQueryParams", () => {
  test("builds simple key=value params without processing", () => {
    expect(buildRawQueryParams(["name=test", "value=123"])).toEqual({
      name: "test",
      value: "123",
    });
  });

  test("keeps JSON-like values as raw strings (no parsing)", () => {
    expect(
      buildRawQueryParams(["data=[1,2,3]", 'obj={"key":"value"}'])
    ).toEqual({
      data: "[1,2,3]",
      obj: '{"key":"value"}',
    });
  });

  test("does not process bracket notation (kept as literal key)", () => {
    expect(buildRawQueryParams(["user[name]=John"])).toEqual({
      "user[name]": "John",
    });
  });

  test("handles repeated keys by creating string array", () => {
    expect(buildRawQueryParams(["tag=a", "tag=b", "tag=c"])).toEqual({
      tag: ["a", "b", "c"],
    });
  });

  test("handles value with equals sign", () => {
    expect(buildRawQueryParams(["query=a=b=c"])).toEqual({ query: "a=b=c" });
  });

  test("throws ValidationError for invalid field format without equals", () => {
    expect(() => buildRawQueryParams(["invalid"])).toThrow(ValidationError);
    expect(() => buildRawQueryParams(["invalid"])).toThrow(
      /Invalid field format/
    );
  });

  test("throws for empty key", () => {
    expect(() => buildRawQueryParams(["=value"])).toThrow(
      /key cannot be empty/
    );
  });

  test("returns empty object for empty array", () => {
    expect(buildRawQueryParams([])).toEqual({});
  });

  test("preserves empty values", () => {
    expect(buildRawQueryParams(["empty="])).toEqual({ empty: "" });
  });
});

describe("buildQueryParamsFromFields", () => {
  test("returns empty object for no fields", () => {
    expect(buildQueryParamsFromFields(undefined, undefined)).toEqual({});
    expect(buildQueryParamsFromFields([], [])).toEqual({});
  });

  test("builds params from typed fields only", () => {
    expect(
      buildQueryParamsFromFields(["status=resolved", "count=10"], undefined)
    ).toEqual({
      status: "resolved",
      count: "10",
    });
  });

  test("builds params from raw fields only", () => {
    expect(
      buildQueryParamsFromFields(undefined, ["name=test", "value=raw"])
    ).toEqual({
      name: "test",
      value: "raw",
    });
  });

  test("merges typed and raw fields", () => {
    expect(buildQueryParamsFromFields(["typed=1"], ["raw=2"])).toEqual({
      typed: "1",
      raw: "2",
    });
  });

  test("raw fields override typed fields with same key", () => {
    expect(buildQueryParamsFromFields(["key=typed"], ["key=raw"])).toEqual({
      key: "raw",
    });
  });

  test("typed fields parse JSON, raw fields do not", () => {
    expect(
      buildQueryParamsFromFields(["arr=[1,2,3]"], ["raw=[1,2,3]"])
    ).toEqual({
      arr: ["1", "2", "3"], // typed: parsed as JSON array, stringified
      raw: "[1,2,3]", // raw: kept as literal string
    });
  });
});

describe("prepareRequestOptions", () => {
  test("GET with no fields returns undefined for both body and params", () => {
    const result = prepareRequestOptions("GET", undefined);
    expect(result.body).toBeUndefined();
    expect(result.params).toBeUndefined();
  });

  test("GET with empty fields returns undefined for both body and params", () => {
    const result = prepareRequestOptions("GET", []);
    expect(result.body).toBeUndefined();
    expect(result.params).toBeUndefined();
  });

  test("GET with fields returns params (not body)", () => {
    const result = prepareRequestOptions("GET", [
      "status=resolved",
      "limit=10",
    ]);
    expect(result.body).toBeUndefined();
    expect(result.params).toEqual({
      status: "resolved",
      limit: "10",
    });
  });

  test("POST with fields returns body (not params)", () => {
    const result = prepareRequestOptions("POST", ["status=resolved"]);
    expect(result.body).toEqual({ status: "resolved" });
    expect(result.params).toBeUndefined();
  });

  test("PUT with fields returns body (not params)", () => {
    const result = prepareRequestOptions("PUT", ["name=test"]);
    expect(result.body).toEqual({ name: "test" });
    expect(result.params).toBeUndefined();
  });

  test("PATCH with fields returns body (not params)", () => {
    const result = prepareRequestOptions("PATCH", ["active=true"]);
    expect(result.body).toEqual({ active: true });
    expect(result.params).toBeUndefined();
  });

  test("DELETE with fields returns body (not params)", () => {
    const result = prepareRequestOptions("DELETE", ["force=true"]);
    expect(result.body).toEqual({ force: true });
    expect(result.params).toBeUndefined();
  });

  test("POST with no fields returns undefined for both body and params", () => {
    const result = prepareRequestOptions("POST", undefined);
    expect(result.body).toBeUndefined();
    expect(result.params).toBeUndefined();
  });

  test("GET with array field converts to string array in params", () => {
    const result = prepareRequestOptions("GET", ["tags=[1,2,3]"]);
    expect(result.params).toEqual({ tags: ["1", "2", "3"] });
  });

  test("POST with nested fields creates nested body object", () => {
    const result = prepareRequestOptions("POST", [
      "user[name]=John",
      "user[age]=30",
    ]);
    expect(result.body).toEqual({ user: { name: "John", age: 30 } });
  });

  test("POST with raw fields keeps values as strings", () => {
    const result = prepareRequestOptions("POST", undefined, ["count=123"]);
    expect(result.body).toEqual({ count: "123" });
  });

  test("POST merges typed and raw fields", () => {
    const result = prepareRequestOptions("POST", ["typed=123"], ["raw=456"]);
    expect(result.body).toEqual({ typed: 123, raw: "456" });
  });

  test("GET includes both typed and raw fields in query params", () => {
    const result = prepareRequestOptions(
      "GET",
      ["status=resolved"],
      ["raw=value"]
    );
    expect(result.params).toEqual({ status: "resolved", raw: "value" });
    expect(result.body).toBeUndefined();
  });

  test("GET with only raw fields creates params", () => {
    const result = prepareRequestOptions("GET", [], ["name=test", "limit=10"]);
    expect(result.params).toEqual({ name: "test", limit: "10" });
    expect(result.body).toBeUndefined();
  });

  test("GET raw fields override typed fields with same key", () => {
    const result = prepareRequestOptions(
      "GET",
      ["value=123"], // typed: parsed as number, stringified back
      ["value=raw-string"] // raw: kept as-is, overrides typed
    );
    expect(result.params).toEqual({ value: "raw-string" });
  });

  test("POST with only raw fields creates body", () => {
    const result = prepareRequestOptions("POST", [], ["data=value"]);
    expect(result.body).toEqual({ data: "value" });
  });
});

describe("buildBodyFromFields", () => {
  test("returns undefined for no fields", () => {
    expect(buildBodyFromFields(undefined, undefined)).toBeUndefined();
    expect(buildBodyFromFields([], [])).toBeUndefined();
    expect(buildBodyFromFields([], undefined)).toBeUndefined();
    expect(buildBodyFromFields(undefined, [])).toBeUndefined();
  });

  test("builds body from typed fields only", () => {
    expect(buildBodyFromFields(["name=John", "age=30"], undefined)).toEqual({
      name: "John",
      age: 30,
    });
  });

  test("builds body from raw fields only", () => {
    expect(buildBodyFromFields(undefined, ["name=John", "age=30"])).toEqual({
      name: "John",
      age: "30",
    });
  });

  test("merges typed and raw fields", () => {
    expect(buildBodyFromFields(["typed=123"], ["raw=456"])).toEqual({
      typed: 123,
      raw: "456",
    });
  });

  test("raw fields can overwrite typed fields", () => {
    // Typed field first parses "123" as number
    // Raw field then overwrites with string "456"
    expect(buildBodyFromFields(["value=123"], ["value=456"])).toEqual({
      value: "456",
    });
  });

  test("handles nested fields from both typed and raw", () => {
    expect(buildBodyFromFields(["user[name]=John"], ["user[age]=30"])).toEqual({
      user: { name: "John", age: "30" },
    });
  });

  test("handles array push from both typed and raw", () => {
    expect(buildBodyFromFields(["tags[]=foo"], ["tags[]=bar"])).toEqual({
      tags: ["foo", "bar"],
    });
  });
});

describe("formatApiResponse", () => {
  test("formats JSON object with pretty-printing", () => {
    expect(formatApiResponse({ key: "value", num: 42 })).toBe(
      '{\n  "key": "value",\n  "num": 42\n}'
    );
  });

  test("formats JSON array with pretty-printing", () => {
    expect(formatApiResponse([1, 2, 3])).toBe("[\n  1,\n  2,\n  3\n]");
  });

  test("formats string directly without JSON quoting", () => {
    expect(formatApiResponse("plain text response")).toBe(
      "plain text response"
    );
  });

  test("formats number as string", () => {
    expect(formatApiResponse(42)).toBe("42");
  });

  test("formats boolean as string", () => {
    expect(formatApiResponse(true)).toBe("true");
  });

  test("returns empty string for null", () => {
    expect(formatApiResponse(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(formatApiResponse(undefined)).toBe("");
  });

  test("returns empty string for Uint8Array (binary guard)", () => {
    // Binary must never go through JSON.stringify / String().
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(formatApiResponse(png)).toBe("");
  });
});

describe("formatBinaryErrorBody", () => {
  test("summarizes status, content-type, and size without dumping bytes", () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const headers = new Headers({ "content-type": "image/png" });
    const summary = formatBinaryErrorBody(403, headers, body);
    expect(summary).toContain("HTTP 403");
    expect(summary).toContain("image/png");
    expect(summary).toContain("4 bytes");
    // Must not contain raw binary / replacement-char artifacts
    expect(summary).not.toContain("\uFFFD");
    expect(summary).not.toMatch(/\x89/);
  });

  test("uses unknown when content-type is missing", () => {
    const summary = formatBinaryErrorBody(
      500,
      new Headers(),
      new Uint8Array(0)
    );
    expect(summary).toContain("unknown");
    expect(summary).toContain("0 bytes");
  });
});

describe("resolveApiResponseOutput", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  test("silent + success returns undefined (no body)", () => {
    const out = resolveApiResponseOutput(
      { status: 200, headers: new Headers(), body: "ok" },
      { silent: true, isTTY: false }
    );
    expect(out).toBeUndefined();
  });

  test("silent + error throws OutputError(null) for exit code only", () => {
    try {
      resolveApiResponseOutput(
        { status: 500, headers: new Headers(), body: "boom" },
        { silent: true, isTTY: false }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      expect((error as OutputError).data).toBeNull();
    }
  });

  test("error + text body throws OutputError carrying the body", () => {
    try {
      resolveApiResponseOutput(
        { status: 404, headers: new Headers(), body: { detail: "not found" } },
        { silent: false, isTTY: false }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      expect((error as OutputError).data).toEqual({ detail: "not found" });
    }
  });

  test("empty error body throws OutputError with the HTTP status and request", () => {
    try {
      resolveApiResponseOutput(
        {
          status: 404,
          statusText: "Not Found",
          headers: new Headers(),
          body: "",
        },
        {
          silent: false,
          isTTY: false,
          method: "GET",
          endpoint: "issues/7670740039/committers/",
        }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      expect((error as OutputError).data).toBe(
        "HTTP 404 Not Found — GET /api/0/issues/7670740039/committers/"
      );
    }
  });

  test("whitespace-only error body throws OutputError with the HTTP status", () => {
    try {
      resolveApiResponseOutput(
        {
          status: 404,
          statusText: "Not Found",
          headers: new Headers(),
          body: " \n",
        },
        {
          silent: false,
          isTTY: false,
          method: "GET",
          endpoint: "missing/",
        }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      expect((error as OutputError).data).toBe(
        "HTTP 404 Not Found — GET /api/0/missing/"
      );
    }
  });

  test.each([
    [199, "Informational"],
    [300, "Multiple Choices"],
    [304, "Not Modified"],
  ])("non-2xx status %i throws OutputError", (status, statusText) => {
    try {
      resolveApiResponseOutput(
        {
          status,
          statusText,
          headers: new Headers(),
          body: "",
        },
        {
          silent: false,
          isTTY: false,
          method: "GET",
          endpoint: "missing/",
        }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      expect((error as OutputError).data).toBe(
        `HTTP ${status} ${statusText} — GET /api/0/missing/`
      );
    }
  });

  test("JSON errors preserve the empty body in an HTTP response envelope", () => {
    try {
      resolveApiResponseOutput(
        {
          status: 404,
          statusText: "Not Found",
          headers: new Headers(),
          body: "",
        },
        {
          silent: false,
          isTTY: false,
          json: true,
          method: "GET",
          endpoint: "missing/",
        }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      expect((error as OutputError).data).toEqual({
        status: 404,
        statusText: "Not Found",
        body: "",
      });
    }
  });

  test("error + binary body throws OutputError with a byte summary, never raw bytes", () => {
    try {
      resolveApiResponseOutput(
        {
          status: 403,
          headers: new Headers({ "content-type": "image/png" }),
          body: png,
        },
        { silent: false, isTTY: false }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputError);
      const body = (error as OutputError).data as string;
      expect(typeof body).toBe("string");
      expect(body).toContain("HTTP 403");
      expect(body).toContain("image/png");
      expect(body).not.toContain("\uFFFD");
    }
  });

  test("success + text body returns the body unchanged", () => {
    const out = resolveApiResponseOutput(
      { status: 200, headers: new Headers(), body: { ok: true } },
      { silent: false, isTTY: false }
    );
    expect(out).toEqual({ ok: true });
  });

  test("success + binary body returns raw bytes (non-TTY, no warning)", () => {
    const out = resolveApiResponseOutput(
      { status: 200, headers: new Headers(), body: png },
      { silent: false, isTTY: false }
    );
    expect(out).toBe(png);
  });

  test("success + binary body to a TTY still returns raw bytes (warn only, no hard-refuse)", () => {
    const out = resolveApiResponseOutput(
      { status: 200, headers: new Headers(), body: png },
      { silent: false, isTTY: true }
    );
    expect(out).toBe(png);
  });
});

describe("isApiErrorStatus", () => {
  test.each([
    [199, true],
    [200, false],
    [299, false],
    [300, true],
  ])("classifies HTTP %i consistently", (status, expected) => {
    expect(isApiErrorStatus(status)).toBe(expected);
  });
});

describe("resolveBinaryTtyOutput", () => {
  let stderrOutput: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrOutput = "";
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("falls through to raw bytes (undefined) when sixel is unavailable", () => {
    // The test environment is non-interactive, so canRenderSixel() is false
    // and no inline image is produced — the caller keeps the raw bytes.
    const out = resolveBinaryTtyOutput(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      new Headers({ "content-type": "image/png" })
    );
    expect(out).toBeUndefined();
  });

  test("still warns about the raw dump when sixel is disallowed (--json)", () => {
    // In --json mode inline sixel is skipped so it can't corrupt the output,
    // but the raw bytes still stream out, so the TTY warning must still fire.
    const out = resolveBinaryTtyOutput(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      new Headers({ "content-type": "image/png" }),
      false
    );
    expect(out).toBeUndefined();
    expect(stderrOutput).toContain("Binary response written to a TTY");
  });
});

describe("readStdin", () => {
  test("reads content from stdin stream", async () => {
    const mockStdin = createMockStdin("hello world");
    const result = await readStdin(mockStdin);
    expect(result).toBe("hello world");
  });

  test("handles empty stdin", async () => {
    const mockStdin = createMockStdin("");
    const result = await readStdin(mockStdin);
    expect(result).toBe("");
  });

  test("handles multi-line content", async () => {
    const content = "line 1\nline 2\nline 3";
    const mockStdin = createMockStdin(content);
    const result = await readStdin(mockStdin);
    expect(result).toBe(content);
  });

  test("handles JSON content", async () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    const mockStdin = createMockStdin(json);
    const result = await readStdin(mockStdin);
    expect(result).toBe(json);
  });
});

describe("buildBodyFromInput", () => {
  test("reads JSON from stdin when path is '-'", async () => {
    const json = JSON.stringify({ status: "resolved" });
    const mockStdin = createMockStdin(json);

    const result = await buildBodyFromInput("-", mockStdin);

    expect(result).toEqual({ status: "resolved" });
  });

  test("reads non-JSON from stdin when path is '-'", async () => {
    const mockStdin = createMockStdin("plain text content");

    const result = await buildBodyFromInput("-", mockStdin);

    expect(result).toBe("plain text content");
  });

  test("reads JSON from file", async () => {
    // Create a temp file using test config dir (which is writable)
    const { createTestConfigDir, cleanupTestDir } = await import(
      "../helpers.js"
    );
    const testDir = await createTestConfigDir("test-api-file-");
    const tempFile = `${testDir}/test-input.json`;
    await writeFile(tempFile, JSON.stringify({ key: "value" }));

    try {
      const mockStdin = createMockStdin("");
      const result = await buildBodyFromInput(tempFile, mockStdin);
      expect(result).toEqual({ key: "value" });
    } finally {
      await cleanupTestDir(testDir);
    }
  });

  test("reads non-JSON from file", async () => {
    // Create a temp file using test config dir (which is writable)
    const { createTestConfigDir, cleanupTestDir } = await import(
      "../helpers.js"
    );
    const testDir = await createTestConfigDir("test-api-file-");
    const tempFile = `${testDir}/test-input.txt`;
    await writeFile(tempFile, "plain text from file");

    try {
      const mockStdin = createMockStdin("");
      const result = await buildBodyFromInput(tempFile, mockStdin);
      expect(result).toBe("plain text from file");
    } finally {
      await cleanupTestDir(testDir);
    }
  });

  test("throws ValidationError for non-existent file", async () => {
    const mockStdin = createMockStdin("");

    await expect(
      buildBodyFromInput("/nonexistent/path/file.json", mockStdin)
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("resolveEffectiveHeaders", () => {
  test("auto-adds Content-Type for object bodies", () => {
    const headers = resolveEffectiveHeaders(undefined, { key: "value" });
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("does not add Content-Type for string bodies", () => {
    const headers = resolveEffectiveHeaders(undefined, "raw-string");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  test("does not override explicit Content-Type", () => {
    const headers = resolveEffectiveHeaders(
      { "Content-Type": "text/plain" },
      { key: "value" }
    );
    expect(headers["Content-Type"]).toBe("text/plain");
  });

  test("case-insensitive Content-Type check", () => {
    const headers = resolveEffectiveHeaders(
      { "content-type": "text/xml" },
      { key: "value" }
    );
    expect(headers["content-type"]).toBe("text/xml");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  test("preserves custom headers", () => {
    const headers = resolveEffectiveHeaders(
      { Authorization: "Bearer token", "X-Custom": "value" },
      undefined
    );
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers["X-Custom"]).toBe("value");
  });

  test("defaults to empty object when no headers provided", () => {
    const headers = resolveEffectiveHeaders(undefined, undefined);
    expect(headers).toEqual({});
  });

  test("adds Content-Type for null body (matches rawApiRequest)", () => {
    const headers = resolveEffectiveHeaders(undefined, null);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("does not add Content-Type for undefined body", () => {
    const headers = resolveEffectiveHeaders(undefined, undefined);
    expect(headers["Content-Type"]).toBeUndefined();
  });
});

// --data/-d and JSON auto-detection (CLI-AF)

describe("parseDataBody", () => {
  test("parses valid JSON object", () => {
    expect(parseDataBody('{"status":"resolved"}')).toEqual({
      status: "resolved",
    });
  });

  test("parses valid JSON array", () => {
    expect(parseDataBody("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("parses nested JSON", () => {
    expect(
      parseDataBody('{"status":"ignored","statusDetails":{"ignoreCount":1}}')
    ).toEqual({ status: "ignored", statusDetails: { ignoreCount: 1 } });
  });

  test("falls back to raw string for invalid JSON", () => {
    expect(parseDataBody("not json")).toBe("not json");
  });

  test("falls back to raw string for partial JSON", () => {
    expect(parseDataBody('{"broken')).toBe('{"broken');
  });
});

describe("extractJsonBody", () => {
  let stderrOutput: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrOutput = "";
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("returns empty object for undefined input", () => {
    expect(extractJsonBody(undefined)).toEqual({});
    expect(stderrOutput).toBe("");
  });

  test("returns empty object for empty array", () => {
    expect(extractJsonBody([])).toEqual({});
  });

  test("extracts JSON object and emits hint", () => {
    const json = '{"status":"ignored"}';
    const result = extractJsonBody([json]);
    expect(result.body).toEqual({ status: "ignored" });
    expect(result.remaining).toBeUndefined();
    expect(stderrOutput).toContain("request body");
    expect(stderrOutput).toContain("--data/-d");
  });

  test("extracts JSON array and emits hint", () => {
    const result = extractJsonBody(["[1,2,3]"]);
    expect(result.body).toEqual([1, 2, 3]);
    expect(result.remaining).toBeUndefined();
  });

  test("separates JSON body from remaining key=value fields", () => {
    const result = extractJsonBody([
      '{"status":"ignored"}',
      "extra=field",
      "other=value",
    ]);
    expect(result.body).toEqual({ status: "ignored" });
    expect(result.remaining).toEqual(["extra=field", "other=value"]);
  });

  test("does NOT extract JSON primitives — they stay in remaining (no TypeError risk)", () => {
    // Primitives like numbers, booleans, strings are valid JSON but cannot be
    // used with the 'in' operator, which would throw a TypeError downstream.
    expect(extractJsonBody(["42"]).body).toBeUndefined();
    expect(extractJsonBody(["true"]).body).toBeUndefined();
    expect(extractJsonBody(['"hello"']).body).toBeUndefined();
    expect(extractJsonBody(["null"]).body).toBeUndefined();
    expect(stderrOutput).toBe("");
  });

  test("leaves invalid JSON-looking fields in remaining", () => {
    const result = extractJsonBody(["{not-valid-json}"]);
    expect(result.body).toBeUndefined();
    expect(result.remaining).toEqual(["{not-valid-json}"]);
    expect(stderrOutput).toBe("");
  });

  test("throws on multiple JSON bodies", () => {
    expect(() => extractJsonBody(['{"a":1}', '{"b":2}'])).toThrow(
      ValidationError
    );
    expect(() => extractJsonBody(['{"a":1}', '{"b":2}'])).toThrow(
      /Multiple JSON bodies/
    );
  });

  test("does not extract fields that have '=' even if JSON-shaped", () => {
    // This is a normal key=value where the value happens to start with {
    const result = extractJsonBody(['data={"key":"value"}']);
    expect(result.body).toBeUndefined();
    expect(result.remaining).toEqual(['data={"key":"value"}']);
  });

  test("truncates long JSON in hint preview", () => {
    const longJson = JSON.stringify({
      status: "ignored",
      statusDetails: { ignoreCount: 1 },
      longField: "a".repeat(100),
    });
    extractJsonBody([longJson]);
    expect(stderrOutput).toContain("...");
    // Preview should be ~60 chars, not the full string
    expect(stderrOutput.length).toBeLessThan(longJson.length + 100);
  });
});

describe("buildFromFields", () => {
  let stderrOutput: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrOutput = "";
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("auto-detects JSON body in raw-field (CLI-AF scenario)", () => {
    const result = buildFromFields("PUT", {
      "raw-field": ['{"status":"ignored","statusDetails":{"ignoreCount":1}}'],
    });
    expect(result.body).toEqual({
      status: "ignored",
      statusDetails: { ignoreCount: 1 },
    });
    expect(stderrOutput).toContain("request body");
  });

  test("merges JSON body with additional key=value fields", () => {
    const result = buildFromFields("PUT", {
      "raw-field": ['{"status":"ignored"}'],
      field: ["priority=critical"],
    });
    expect(result.body).toEqual({
      status: "ignored",
      priority: "critical",
    });
  });

  test("routes fields to params for GET without JSON", () => {
    const result = buildFromFields("GET", {
      field: ["status=resolved", "limit=10"],
    });
    expect(result.body).toBeUndefined();
    expect(result.params).toEqual({ status: "resolved", limit: "10" });
  });

  test("passes through normal fields when no JSON present", () => {
    const result = buildFromFields("PUT", { field: ["status=resolved"] });
    expect(result.body).toEqual({ status: "resolved" });
    expect(stderrOutput).toBe("");
  });

  test("throws ValidationError when JSON array body is mixed with field flags", () => {
    expect(() =>
      buildFromFields("PUT", {
        "raw-field": ["[1,2,3]"],
        field: ["extra=field"],
      })
    ).toThrow(ValidationError);
    expect(() =>
      buildFromFields("PUT", {
        "raw-field": ["[1,2,3]"],
        field: ["extra=field"],
      })
    ).toThrow(/Cannot combine a JSON array/);
  });

  test("does NOT extract JSON body for GET — falls through to query-param routing (which throws)", () => {
    // GET with a bare JSON field: no body extracted, falls to buildRawQueryParams
    // which throws "Invalid field format" since there is no '='
    expect(() =>
      buildFromFields("GET", { "raw-field": ['{"status":"ignored"}'] })
    ).toThrow(ValidationError);
    // No hint should have been emitted (JSON extraction was skipped for GET)
    expect(stderrOutput).toBe("");
  });

  test("throws ValidationError when field flags conflict with JSON body at same top-level key", () => {
    expect(() =>
      buildFromFields("PUT", {
        "raw-field": ['{"status":"ignored","statusDetails":{"ignoreCount":1}}'],
        field: ["statusDetails[minCount]=5"],
      })
    ).toThrow(ValidationError);
    expect(() =>
      buildFromFields("PUT", {
        "raw-field": ['{"status":"ignored","statusDetails":{"ignoreCount":1}}'],
        field: ["statusDetails[minCount]=5"],
      })
    ).toThrow(/conflict/i);
  });

  test("non-conflicting keys from JSON body and field flags merge cleanly", () => {
    const result = buildFromFields("PUT", {
      "raw-field": ['{"status":"ignored"}'],
      field: ["assignee=me"],
    });
    expect(result.body).toEqual({ status: "ignored", assignee: "me" });
  });
});

// -- resolveBody: the priority/exclusivity layer above individual builders --
// This was extracted from the Stricli command handler (func) so that
// --data, --input, and field flag mutual-exclusivity logic can be unit-tested.

const MOCK_STDIN = process.stdin as unknown as NodeJS.ReadStream & { fd: 0 };

describe("resolveBody", () => {
  test("--data returns parsed JSON body", async () => {
    const result = await resolveBody(
      { method: "PUT", data: '{"status":"resolved"}' },
      MOCK_STDIN
    );
    expect(result.body).toEqual({ status: "resolved" });
    expect(result.params).toBeUndefined();
  });

  test("--data with non-JSON returns raw string body", async () => {
    const result = await resolveBody(
      { method: "POST", data: "hello world" },
      MOCK_STDIN
    );
    expect(result.body).toBe("hello world");
  });

  test("throws when --data and --input are both set", async () => {
    await expect(
      resolveBody(
        { method: "PUT", data: '{"a":1}', input: "file.json" },
        MOCK_STDIN
      )
    ).rejects.toThrow(ValidationError);
    await expect(
      resolveBody(
        { method: "PUT", data: '{"a":1}', input: "file.json" },
        MOCK_STDIN
      )
    ).rejects.toThrow(/--data.*--input/i);
  });

  test("throws when --data and --field are both set", async () => {
    await expect(
      resolveBody(
        { method: "PUT", data: '{"a":1}', field: ["key=value"] },
        MOCK_STDIN
      )
    ).rejects.toThrow(ValidationError);
    await expect(
      resolveBody(
        { method: "PUT", data: '{"a":1}', field: ["key=value"] },
        MOCK_STDIN
      )
    ).rejects.toThrow(/--data.*--field|--field.*--data/i);
  });

  test("throws when --data and --raw-field are both set", async () => {
    await expect(
      resolveBody(
        { method: "PUT", data: '{"a":1}', "raw-field": ["key=value"] },
        MOCK_STDIN
      )
    ).rejects.toThrow(ValidationError);
  });

  test("falls through to buildFromFields when neither --data nor --input", async () => {
    const result = await resolveBody(
      { method: "PUT", field: ["status=resolved"] },
      MOCK_STDIN
    );
    expect(result.body).toEqual({ status: "resolved" });
    expect(result.params).toBeUndefined();
  });

  test("GET fields produce params, not body", async () => {
    const result = await resolveBody(
      { method: "GET", "raw-field": ["query=is:unresolved"] },
      MOCK_STDIN
    );
    expect(result.body).toBeUndefined();
    expect(result.params).toEqual({ query: "is:unresolved" });
  });

  test("GET --data converts URL-encoded string to query params", async () => {
    const result = await resolveBody(
      { method: "GET", data: "stat=received&resolution=1d" },
      MOCK_STDIN
    );
    expect(result.body).toBeUndefined();
    expect(result.params).toEqual({ stat: "received", resolution: "1d" });
  });

  test("GET --data converts JSON object to query params", async () => {
    const result = await resolveBody(
      { method: "GET", data: '{"stat":"received","resolution":"1d"}' },
      MOCK_STDIN
    );
    expect(result.body).toBeUndefined();
    expect(result.params).toEqual({ stat: "received", resolution: "1d" });
  });

  test("GET --data with JSON array throws ValidationError", async () => {
    await expect(
      resolveBody({ method: "GET", data: "[1,2,3]" }, MOCK_STDIN)
    ).rejects.toThrow(ValidationError);
    await expect(
      resolveBody({ method: "GET", data: "[1,2,3]" }, MOCK_STDIN)
    ).rejects.toThrow(/cannot.*query parameters/i);
  });

  test("GET --data with JSON primitive throws ValidationError", async () => {
    await expect(
      resolveBody({ method: "GET", data: "null" }, MOCK_STDIN)
    ).rejects.toThrow(ValidationError);
    await expect(
      resolveBody({ method: "GET", data: "42" }, MOCK_STDIN)
    ).rejects.toThrow(ValidationError);
  });

  test("POST --data still returns body (regression guard)", async () => {
    const result = await resolveBody(
      { method: "POST", data: '{"status":"resolved"}' },
      MOCK_STDIN
    );
    expect(result.body).toEqual({ status: "resolved" });
    expect(result.params).toBeUndefined();
  });
});

// -- dataToQueryParams: converts parsed --data to query params for GET --

describe("dataToQueryParams", () => {
  test("parses URL-encoded string", () => {
    expect(dataToQueryParams("stat=received&resolution=1d")).toEqual({
      stat: "received",
      resolution: "1d",
    });
  });

  test("handles duplicate keys as arrays", () => {
    expect(dataToQueryParams("tag=foo&tag=bar&tag=baz")).toEqual({
      tag: ["foo", "bar", "baz"],
    });
  });

  test("handles empty string", () => {
    expect(dataToQueryParams("")).toEqual({});
  });

  test("converts JSON object with string values", () => {
    expect(dataToQueryParams({ stat: "received", resolution: "1d" })).toEqual({
      stat: "received",
      resolution: "1d",
    });
  });

  test("stringifies non-string JSON values", () => {
    expect(dataToQueryParams({ count: 5, enabled: true })).toEqual({
      count: "5",
      enabled: "true",
    });
  });

  test("throws on JSON array", () => {
    expect(() => dataToQueryParams([1, 2, 3])).toThrow(ValidationError);
    expect(() => dataToQueryParams([1, 2, 3])).toThrow(
      /cannot.*JSON primitive or array.*query parameters/i
    );
  });

  test("throws on null", () => {
    expect(() =>
      dataToQueryParams(null as unknown as Record<string, unknown>)
    ).toThrow(ValidationError);
  });

  test("throws on boolean", () => {
    expect(() =>
      dataToQueryParams(true as unknown as Record<string, unknown>)
    ).toThrow(ValidationError);
  });

  test("throws on number", () => {
    expect(() =>
      dataToQueryParams(42 as unknown as Record<string, unknown>)
    ).toThrow(ValidationError);
  });
});

// Dry-run tests

describe("resolveRequestUrl", () => {
  test("builds URL against an explicit regional origin", () => {
    const url = resolveRequestUrl(
      "organizations/",
      undefined,
      "https://de.sentry.io/sentry"
    );
    expect(url).toBe("https://de.sentry.io/sentry/api/0/organizations/");
  });

  test("strips leading slash from endpoint", () => {
    const url = resolveRequestUrl("/organizations/");
    expect(url).toMatch(/\/api\/0\/organizations\/$/);
  });

  test("appends query params", () => {
    const url = resolveRequestUrl("issues/", { status: "unresolved" });
    expect(url).toContain("?status=unresolved");
    expect(url).toContain("/api/0/issues/");
  });

  test("handles array params", () => {
    const url = resolveRequestUrl("events/", {
      field: ["title", "timestamp"],
    });
    expect(url).toContain("field=title");
    expect(url).toContain("field=timestamp");
  });

  test("omits query string when no params", () => {
    const url = resolveRequestUrl("projects/");
    expect(url).not.toContain("?");
  });

  test("merges params with an existing query string", () => {
    const url = resolveRequestUrl("attachments/?download=1", {
      mode: "raw",
    });
    expect(url).toContain("attachments/?download=1&mode=raw");
  });

  test("absolute URL dry-run preserves the regional origin", async () => {
    let output = "";
    const func = await apiCommand.loader();
    await func.call(
      {
        cwd: "/tmp",
        stdin: createMockStdin(""),
        stdout: {
          write(value: string | Uint8Array) {
            output += String(value);
            return true;
          },
        },
        stderr: { write: () => true },
      },
      {
        method: "GET",
        silent: false,
        verbose: false,
        "dry-run": true,
        json: true,
      },
      "https://de.sentry.io/sentry/api/0/organizations/acme/"
    );

    expect(JSON.parse(output).url).toBe(
      "https://de.sentry.io/sentry/api/0/organizations/acme/"
    );
  });
});
