import type { GetOrganizationIssueTagResponse } from "@sentry/api";
import { describe, expect, test } from "vitest";
import { formatIssueTags } from "../../../src/lib/formatters/issue-tags.js";

/** A distribution with undisplayed events, rather than an exhaustive list. */
function distribution(
  count: number | null = 30,
): GetOrganizationIssueTagResponse {
  return {
    key: "release",
    name: "Release",
    totalValues: 100,
    topValues: [
      {
        key: "release",
        name: "1.2.3",
        value: "1.2.3",
        count,
        firstSeen: null,
        lastSeen: null,
      },
    ],
  };
}

describe("formatIssueTags", () => {
  test("does not turn an unknown count into zero or a fabricated remainder", () => {
    const output = formatIssueTags(distribution(null));
    expect(output).toContain("—");
    expect(output).not.toContain("0.0%");
    expect(output).not.toContain("Other values");
  });

  test.each([undefined, null, 0])(
    "does not divide by an unknown or zero total (%s)",
    (total) => {
      const output = formatIssueTags({ ...distribution(), totalValues: total });
      expect(output).not.toContain("%");
      expect(output).not.toContain("NaN");
      expect(output).not.toContain("Infinity");
    },
  );

  test("distinguishes empty values from unknown values and preserves literal tag text", () => {
    const tag = distribution();
    const value = tag.topValues![0]!;
    tag.topValues = [
      { ...value, value: "" },
      { ...value, value: null },
      { ...value, value: "build__id__|<test>*x*[link]" },
    ];
    const output = formatIssueTags(tag);
    expect(output).toContain("(empty or missing)");
    expect(output).toContain("(unknown)");
    expect(output).toContain("build__id__|<test>*x*[link]");
  });

  test("does not describe absent top-values data as zero events", () => {
    const output = formatIssueTags({
      key: "release",
      name: "Release",
      topValues: null,
    });
    expect(output).toContain("Total retained events: unknown");
    expect(output).toContain("No top values returned");
  });
});
