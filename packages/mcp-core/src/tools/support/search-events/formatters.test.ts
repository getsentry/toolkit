import { describe, expect, it } from "vitest";

import { formatExecutedSearch } from "./formatters.js";

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
