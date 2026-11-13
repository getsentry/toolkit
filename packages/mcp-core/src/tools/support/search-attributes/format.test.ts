import { describe, expect, it } from "vitest";
import type { TraceItemAttribute } from "../../../api-client";
import { formatFindResult, formatListResult } from "./format";

function attribute(
  key: string,
  overrides: Partial<TraceItemAttribute> = {},
): TraceItemAttribute {
  return {
    key,
    name: key,
    type: "string",
    attributeSource: { source_type: "user" },
    ...overrides,
  };
}

describe("formatFindResult", () => {
  it("shows the best match's details and skips the ones it doesn't have", () => {
    expect(
      formatFindResult({
        organizationSlug: "my-org",
        dataset: "logs",
        period: "14d",
        query: "log level",
        totalAttributes: 12,
        matches: {
          best: attribute("log.legacy_level", {
            attributeSource: { source_type: "sentry" },
            secondaryAliases: ["level"],
            context: { isDeprecated: true },
          }),
          candidates: [],
          reason: "",
        },
      }),
    ).toMatchInlineSnapshot(`
      "# Log Attributes Matching "log level" in **my-org** (last 14d)

      ## Best Match: \`log.legacy_level\`

      **Type**: string
      **Added by Sentry**
      **Aliases**: \`level\`
      **Deprecated**

      ## Response Notes

      - Use a key with \`search_logs\` to query its values."
    `);
  });
});

describe("formatListResult", () => {
  it("keeps each table row on one line", () => {
    const output = formatListResult({
      organizationSlug: "my-org",
      dataset: "spans",
      period: "14d",
      limit: 50,
      attributes: [
        attribute("app.note", {
          context: { brief: "First line\nsecond | part", examples: ["a|b"] },
        }),
        attribute("app.long", { context: { brief: "x".repeat(300) } }),
      ],
    });

    const rows = output.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toEqual([
      // Long descriptions are cut to 255 characters.
      `| \`app.long\` | string | ${"x".repeat(254)}… |  |  |  |`,
      // Line breaks are flattened and pipes escaped, so the row stays intact.
      "| `app.note` | string | First line second \\| part EXAMPLE VALUES: a\\|b |  |  |  |",
    ]);
  });
});
