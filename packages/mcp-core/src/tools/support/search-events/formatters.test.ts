import { describe, expect, it } from "vitest";

import { formatExecutedSearch, formatTimeSeriesResults } from "./formatters.js";

describe("formatExecutedSearch", () => {
  it("pads inline code values that start or end with backticks", () => {
    const result = formatExecutedSearch({
      dataset: "spans",
      query: "`release`",
      fields: ["tags[`weird`]", "`count()`", "count()`"],
      sort: "-count()",
    });

    expect(result).toContain("- Query: `` `release` ``");
    expect(result).toContain(
      "- Fields: ``tags[`weird`]``, `` `count()` ``, `` count()` ``",
    );
    expect(result).toContain("- Sort: `-count()`");
  });
});

it("preserves missing buckets as gaps instead of treating them as observed zero", () => {
  const result = formatTimeSeriesResults({
    inputQuery: "count over time",
    yAxis: "count()",
    interval: "1h",
    series: {
      timeSeries: [
        {
          yAxis: "count()",
          meta: { interval: 3600000 },
          values: [
            { timestamp: 1757548800000, value: null, incomplete: false },
            { timestamp: 1757552400000, value: -2, incomplete: false },
            { timestamp: 1757556000000, value: 0, incomplete: false },
          ],
        },
      ],
    },
  });

  expect(result).toContain("| 2025-09-11 00:00 | Gap |");
  expect(result).toContain("| 2025-09-11 02:00 | 0 |");
  expect(result).toContain("**Peak**: 0 at 2025-09-11 02:00");
});

it("labels transformed maxima and retains units, comparisons and false provenance flags", () => {
  const result = formatTimeSeriesResults({
    inputQuery: "smoothed duration",
    yAxis: "sum(span.duration)",
    interval: "1h",
    configuration: {
      axes: [
        { yAxis: "sum(span.duration)", transformations: ["smooth(sma,2)"] },
      ],
      interval: "1h",
    },
    series: {
      timeSeries: [
        {
          yAxis: "sum(span.duration)",
          meta: { interval: 3600000, valueUnit: "millisecond" },
          values: [
            {
              timestamp: 1757548800000,
              value: 2,
              comparisonValue: null,
              incomplete: false,
              filled: false,
              smoothed: true,
              comparisonFilled: false,
              comparisonSmoothed: false,
            },
          ],
        },
      ],
    },
  });

  expect(result).toMatchInlineSnapshot(`
    "# Search Results for "smoothed duration"

    ## sum(span.duration) over time
    - **Interval**: \`1h\`
    - **Time range**: Last 14d
    - **Unit**: millisecond
    - **Transformations**: \`smooth(sma,2)\`
    - **Derived maximum**: 2 at 2025-09-11 00:00

    ## Buckets

    | Time (UTC) | Value | Comparison | Filled | Smoothed | Comparison filled | Comparison smoothed |
    | --- | --- | --- | --- | --- | --- | --- |
    | 2025-09-11 00:00 | 2 | Gap | false | true | false | false |"
  `);
  expect(result).not.toContain("**Total**");
});
