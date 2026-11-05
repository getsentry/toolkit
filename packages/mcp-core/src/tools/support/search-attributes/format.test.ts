import { describe, expect, it } from "vitest";
import type { TraceItemAttribute } from "../../../api-client";
import { formatFindResult, formatListResult } from "./format";

function attr(
  key: string,
  overrides: Partial<TraceItemAttribute> = {},
): TraceItemAttribute {
  return {
    key,
    name: key,
    type: "string",
    attributeSource: { source_type: "sentry" },
    ...overrides,
  };
}

const scope = {
  organizationSlug: "my-org",
  dataset: "spans",
  period: "14d",
} as const;

const spanDescription = attr("span.description", {
  secondaryAliases: ["description", "message"],
  context: {
    brief: "Description of the span's operation.",
    examples: ["GET /api/users", "SELECT * FROM users"],
    isDeprecated: false,
  },
});

const httpStatusCode = attr("http.status_code", {
  type: "number",
  context: {
    isConvention: true,
    brief: "The status code of the HTTP response.",
    isDeprecated: true,
    examples: [200, 404],
    replacementAttribute: "http.response.status_code",
  },
});

describe("formatFindResult", () => {
  it("shows the best match and a table of other candidates", () => {
    expect(
      formatFindResult({
        ...scope,
        query: "span description",
        totalAttributes: 40,
        matches: {
          best: spanDescription,
          candidates: [
            httpStatusCode,
            attr("span.status", {
              context: {
                brief:
                  'The span\'s status ("ok" or "error").\nOlder SDKs | send other values.',
              },
            }),
            attr("http.url", {
              context: {
                brief:
                  "The full URL of the resource that was fetched, including the scheme, host, port, path, and query string, but never including credentials or fragments.",
              },
            }),
            attr("custom.tier", {
              attributeSource: { source_type: "user" },
            }),
            attr("legacy.flag", {
              type: "boolean",
              context: { isDeprecated: true },
            }),
          ],
        },
      }),
    ).toMatchInlineSnapshot(`
      "# Span Attributes Matching "span description" in **my-org** (last 14d)

      ## Best Match: \`span.description\`

      **Type**: string
      **Added by Sentry**: yes
      **Description**: Description of the span's operation.
      **Examples**: GET /api/users, SELECT * FROM users
      **Aliases**: \`description\`, \`message\`

      ## Other Candidates

      | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
      | --- | --- | --- | --- | --- | --- |
      | \`http.status_code\` | number | The status code of the HTTP response. | yes | yes | http.response.status_code |
      | \`span.status\` | string | The span's status ("ok" or "error"). Older SDKs \\| send other values. | yes |  |  |
      | \`http.url\` | string | The full URL of the resource that was fetched, including the scheme, host, port, path, and query string, but never incl… | yes |  |  |
      | \`custom.tier\` | string |  |  |  |  |
      | \`legacy.flag\` | boolean |  | yes | yes |  |

      ## Response Notes

      - Use a key with \`search_traces\` to query its values."
    `);
  });

  it("shows the replacement when the best match is deprecated", () => {
    expect(
      formatFindResult({
        ...scope,
        query: "http.response.status_code",
        totalAttributes: 40,
        matches: { best: httpStatusCode, candidates: [] },
      }),
    ).toMatchInlineSnapshot(`
      "# Span Attributes Matching "http.response.status_code" in **my-org** (last 14d)

      ## Best Match: \`http.status_code\`

      **Type**: number
      **Added by Sentry**: yes
      **Description**: The status code of the HTTP response.
      **Examples**: 200, 404
      **Deprecated**: use \`http.response.status_code\` instead

      ## Response Notes

      - Use a key with \`search_traces\` to query its values."
    `);
  });

  it("lists possible matches when no single key wins", () => {
    expect(
      formatFindResult({
        ...scope,
        query: "status",
        totalAttributes: 40,
        matches: {
          candidates: [httpStatusCode, attr("span.status")],
        },
      }),
    ).toMatchInlineSnapshot(`
      "# Span Attributes Matching "status" in **my-org** (last 14d)

      ## Possible Matches

      | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
      | --- | --- | --- | --- | --- | --- |
      | \`http.status_code\` | number | The status code of the HTTP response. | yes | yes | http.response.status_code |
      | \`span.status\` | string |  | yes |  |  |

      ## Response Notes

      - Use a key with \`search_traces\` to query its values."
    `);
  });

  it("says nothing matched when attributes exist but none fit", () => {
    expect(
      formatFindResult({
        ...scope,
        query: "payment provider",
        totalAttributes: 40,
        matches: { candidates: [] },
      }),
    ).toMatchInlineSnapshot(`
      "# Span Attributes Matching "payment provider" in **my-org** (last 14d)

      None of the 40 span attributes seen in the last 14d match this query.

      ## Response Notes

      - Try other words, or omit \`query\` to list every attribute."
    `);
  });
});

describe("formatListResult", () => {
  const attributes = [
    attr("http.url"),
    attr("db.system"),
    attr("http.method"),
    attr("deviceMemory", { type: "number" }),
    attr("db.statement"),
    attr("custom.tier", { attributeSource: { source_type: "user" } }),
    attr("http.status_code", { type: "number" }),
  ];

  it("says how many are shown when the list is cut off", () => {
    expect(formatListResult({ ...scope, attributes, limit: 3 }))
      .toMatchInlineSnapshot(`
        "# Span Attributes in **my-org** (last 14d)

        | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
        | --- | --- | --- | --- | --- | --- |
        | \`custom.tier\` | string |  |  |  |  |
        | \`db.statement\` | string |  | yes |  |  |
        | \`db.system\` | string |  | yes |  |  |

        ## Response Notes

        - Showing 3 of 7. Pass a \`query\` to find specific attributes.
        - Use a key with \`search_traces\` to query its values."
      `);
  });

  it("leaves out the count when every attribute fits", () => {
    const output = formatListResult({
      ...scope,
      attributes,
      limit: 50,
      notes: ["A caller note."],
    });

    expect(output).not.toContain("Showing");
    expect(output).toContain("- A caller note.");
  });
});

it("says when no attributes were seen in the period", () => {
  expect(
    formatListResult({ ...scope, dataset: "logs", attributes: [], limit: 50 }),
  ).toMatchInlineSnapshot(`
    "# Log Attributes in **my-org** (last 14d)

    No log attributes were seen in the last 14d.

    ## Response Notes

    - Try a longer \`period\` or a different \`dataset\`."
  `);
  expect(
    formatFindResult({
      ...scope,
      dataset: "metrics",
      query: "region",
      totalAttributes: 0,
      matches: { candidates: [] },
    }),
  ).toMatchInlineSnapshot(`
    "# Metric Attributes Matching "region" in **my-org** (last 14d)

    No metric attributes were seen in the last 14d.

    ## Response Notes

    - Try a longer \`period\` or a different \`dataset\`."
  `);
});
