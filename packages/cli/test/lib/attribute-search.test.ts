/**
 * Attribute Search Tests
 *
 * Tests for the `sentry attribute list` input parsers in
 * src/lib/attribute-search.ts.
 */

import { describe, expect, test } from "vitest";
import {
  parseAttributeFilter,
  parseAttributeTypes,
} from "../../src/lib/attribute-search.js";
import { ValidationError } from "../../src/lib/errors.js";

describe("parseAttributeTypes", () => {
  test("accepts repeated and comma-separated values, deduplicated", () => {
    expect(
      parseAttributeTypes(["string,number", "NUMBER", " boolean "]),
    ).toEqual(["string", "number", "boolean"]);
  });

  test("returns undefined when no types are given", () => {
    expect(parseAttributeTypes(undefined)).toBeUndefined();
    expect(parseAttributeTypes([])).toBeUndefined();
    expect(parseAttributeTypes([","])).toBeUndefined();
  });

  test("rejects unknown types", () => {
    expect(() => parseAttributeTypes(["string,float"])).toThrow(
      ValidationError,
    );
  });
});

describe("parseAttributeFilter", () => {
  test("keeps has: terms (deduplicated, typed keys intact) as the query and free text as the name", () => {
    expect(
      parseAttributeFilter(
        " has:gen_ai.request.model gen_ai has:tags[cart.total,number] has:gen_ai.request.model ",
      ),
    ).toEqual({
      query: "has:gen_ai.request.model has:tags[cart.total,number]",
      name: "gen_ai",
    });
    expect(parseAttributeFilter("http")).toEqual({ name: "http" });
  });

  test("returns nothing without a filter", () => {
    expect(parseAttributeFilter(undefined)).toEqual({});
    expect(parseAttributeFilter("  ")).toEqual({});
  });

  test("accepts literal brackets in attribute name searches", () => {
    expect(parseAttributeFilter("tags[")).toEqual({ name: "tags[" });
    expect(parseAttributeFilter("tags[cart.total,number]")).toEqual({
      name: "tags[cart.total,number]",
    });
  });

  test("rejects values, negation, OR, and an empty has:", () => {
    for (const bad of [
      "span.op:db",
      "!has:http.method",
      "has:a OR has:b",
      "has:",
    ]) {
      expect(() => parseAttributeFilter(bad)).toThrow(ValidationError);
    }
  });

  test("rejects globs, since Sentry matches the text literally", () => {
    expect(() => parseAttributeFilter("gen_ai.*")).toThrow(
      /Globs aren't supported/,
    );
  });

  test("rejects more than one search term", () => {
    expect(() => parseAttributeFilter("gen_ai http")).toThrow(
      /single search term/,
    );
    expect(() => parseAttributeFilter("gen_ai has:x http")).toThrow(
      /single search term/,
    );
  });
});
