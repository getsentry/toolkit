/**
 * Unit Tests for INI Parser
 *
 * Note: Core invariants (round-trips, case insensitivity, duplicate handling)
 * are tested via property-based tests in ini.property.test.ts. These tests
 * focus on edge cases and specific formatting not covered by property generators.
 */

import { describe, expect, test } from "vitest";
import { parseIni } from "../../src/lib/ini.js";

describe("parseIni", () => {
  test("empty string returns empty global section", () => {
    const result = parseIni("");
    expect(result).toEqual({ "": {} });
  });

  test("comments-only file returns empty global section", () => {
    const result = parseIni("# comment\n; another comment\n");
    expect(result).toEqual({ "": {} });
  });

  test("strips UTF-8 BOM", () => {
    const result = parseIni("\uFEFF[defaults]\norg = my-org");
    expect(result.defaults?.org).toBe("my-org");
  });

  test("handles Windows line endings (CRLF)", () => {
    const result = parseIni(
      "[defaults]\r\norg = my-org\r\nproject = my-proj\r\n"
    );
    expect(result.defaults?.org).toBe("my-org");
    expect(result.defaults?.project).toBe("my-proj");
  });

  test("global keys (before any section header)", () => {
    const result = parseIni("key = value\n[section]\nother = data");
    expect(result[""]?.key).toBe("value");
    expect(result.section?.other).toBe("data");
  });

  test("section names are lowercased", () => {
    const result = parseIni("[Defaults]\nOrg = my-org");
    expect(result.defaults?.org).toBe("my-org");
    expect(result.Defaults).toBeUndefined();
  });

  test("key names are lowercased", () => {
    const result = parseIni("[auth]\nToken = secret123");
    expect(result.auth?.token).toBe("secret123");
    expect(result.auth?.Token).toBeUndefined();
  });

  test("strips matching double quotes from values", () => {
    const result = parseIni('[auth]\ntoken = "my-secret-token"');
    expect(result.auth?.token).toBe("my-secret-token");
  });

  test("strips matching single quotes from values", () => {
    const result = parseIni("[auth]\ntoken = 'my-secret-token'");
    expect(result.auth?.token).toBe("my-secret-token");
  });

  test("does not strip mismatched quotes", () => {
    const result = parseIni("[auth]\ntoken = \"my-secret-token'");
    expect(result.auth?.token).toBe("\"my-secret-token'");
  });

  test("preserves quotes in middle of value", () => {
    const result = parseIni(
      '[defaults]\nurl = https://example.com/path?foo="bar"'
    );
    expect(result.defaults?.url).toBe('https://example.com/path?foo="bar"');
  });

  test("empty value after = sign", () => {
    const result = parseIni("[defaults]\norg =\n");
    expect(result.defaults?.org).toBe("");
  });

  test("value with leading/trailing spaces is trimmed", () => {
    const result = parseIni("[defaults]\norg =   my-org   ");
    expect(result.defaults?.org).toBe("my-org");
  });

  test("duplicate keys: last value wins", () => {
    const result = parseIni("[defaults]\norg = first\norg = second");
    expect(result.defaults?.org).toBe("second");
  });

  test("duplicate sections: merged", () => {
    const result = parseIni(
      "[defaults]\norg = my-org\n[defaults]\nproject = my-proj"
    );
    expect(result.defaults?.org).toBe("my-org");
    expect(result.defaults?.project).toBe("my-proj");
  });

  test("duplicate section with duplicate key: last wins", () => {
    const result = parseIni(
      "[defaults]\norg = first\n[defaults]\norg = second"
    );
    expect(result.defaults?.org).toBe("second");
  });

  test("malformed line (no = sign) is skipped", () => {
    const result = parseIni("[defaults]\nthis is not valid\norg = works");
    expect(result.defaults?.org).toBe("works");
    expect(Object.keys(result.defaults ?? {})).toEqual(["org"]);
  });

  test("line with = but empty key is skipped", () => {
    const result = parseIni("[defaults]\n = value\norg = works");
    expect(result.defaults?.org).toBe("works");
    expect(Object.keys(result.defaults ?? {})).toEqual(["org"]);
  });

  test("unclosed section header is skipped", () => {
    const result = parseIni("[defaults\norg = my-org");
    // Falls through as a malformed line, org goes into global section
    expect(result[""]?.org).toBe("my-org");
  });

  test("section header with whitespace inside", () => {
    const result = parseIni("[ defaults ]\norg = my-org");
    expect(result.defaults?.org).toBe("my-org");
  });

  test("inline # in value is preserved (not treated as comment)", () => {
    const result = parseIni("[auth]\ntoken = abc#def");
    expect(result.auth?.token).toBe("abc#def");
  });

  test("inline ; in value is preserved (not treated as comment)", () => {
    const result = parseIni("[auth]\ntoken = abc;def");
    expect(result.auth?.token).toBe("abc;def");
  });

  test("real-world .sentryclirc from old sentry-cli", () => {
    const content = `[defaults]
url = https://sentry.io/
org = my-org
project = my-project

[auth]
token = sntrys_eyJpYXQiOjE3MTkzODM1MjQuNjQ0OTgyfQ==_abc123
`;

    const result = parseIni(content);
    expect(result.defaults?.url).toBe("https://sentry.io/");
    expect(result.defaults?.org).toBe("my-org");
    expect(result.defaults?.project).toBe("my-project");
    expect(result.auth?.token).toBe(
      "sntrys_eyJpYXQiOjE3MTkzODM1MjQuNjQ0OTgyfQ==_abc123"
    );
  });

  test("key with no spaces around = sign", () => {
    const result = parseIni("[defaults]\norg=my-org");
    expect(result.defaults?.org).toBe("my-org");
  });

  test("key with extra spaces around = sign", () => {
    const result = parseIni("[defaults]\norg   =   my-org");
    expect(result.defaults?.org).toBe("my-org");
  });

  test("value containing = sign", () => {
    const result = parseIni("[auth]\ntoken = abc=def=ghi");
    expect(result.auth?.token).toBe("abc=def=ghi");
  });
});
