/**
 * Dataset name tests
 *
 * Tests for src/lib/datasets.ts: the shared `--dataset` names, aliases, and
 * per-command subsets used by explore and attribute list.
 */

import { describe, expect, test } from "vitest";
import {
  buildDatasetParser,
  datasetDisplayName,
} from "../../src/lib/datasets.js";
import { ValidationError } from "../../src/lib/errors.js";

describe("datasetDisplayName", () => {
  test("maps API names to user-facing names", () => {
    expect(datasetDisplayName("tracemetrics")).toBe("metrics");
    expect(datasetDisplayName("spans")).toBe("spans");
  });

  test("returns unknown names unchanged", () => {
    expect(datasetDisplayName("transactions")).toBe("transactions");
  });
});

describe("buildDatasetParser", () => {
  const { parse, names } = buildDatasetParser(["spans", "tracemetrics"]);

  test("accepts user-facing names and aliases, case-insensitively", () => {
    expect(parse("spans")).toBe("spans");
    expect(parse(" Span ")).toBe("spans");
    expect(parse("metrics")).toBe("tracemetrics");
    expect(parse("METRIC")).toBe("tracemetrics");
    expect(parse("tracemetrics")).toBe("tracemetrics");
  });

  test("lists user-facing names in the given order", () => {
    expect(names).toEqual(["spans", "metrics"]);
  });

  test("rejects datasets outside the allowed set, naming the allowed ones", () => {
    expect(() => parse("errors")).toThrow(ValidationError);
    expect(() => parse("bogus")).toThrow(
      'Invalid dataset "bogus". Must be one of: spans, metrics',
    );
  });

  test("returns passthrough values as-is", () => {
    const withLegacy = buildDatasetParser(["spans"], ["transactions"]);
    expect(withLegacy.parse("Transactions")).toBe("transactions");
    expect(withLegacy.names).toEqual(["spans"]);
  });
});
