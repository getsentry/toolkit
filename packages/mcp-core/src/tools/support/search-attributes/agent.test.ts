import { describe, expect, it } from "vitest";
import type { TraceItemAttribute } from "../../../api-client";
import {
  buildShortlistPrompt,
  cleanKeyHints,
  toAttributeMatches,
} from "./agent";

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

const ATTRIBUTES = [
  attribute("http.request.method"),
  attribute("http.method"),
  attribute("span.op"),
  attribute("app.tier"),
];

function keys(attributes: TraceItemAttribute[]): string[] {
  return attributes.map(({ key }) => key);
}

describe("toAttributeMatches", () => {
  it("returns the fetched attributes in the agent's order", () => {
    const matches = toAttributeMatches(
      {
        best: "http.request.method",
        candidates: ["span.op", "http.method"],
        reason: "",
      },
      ATTRIBUTES,
      10,
    );

    expect(matches.best).toBe(ATTRIBUTES[0]);
    expect(keys(matches.candidates)).toEqual(["span.op", "http.method"]);
  });

  it("drops made-up and repeated keys before applying the limit", () => {
    const matches = toAttributeMatches(
      {
        best: "http.request.method",
        candidates: [
          "http.verb", // never fetched
          "Span.Op", // case changed
          "http.request.method", // already best
          "span.op",
          "span.op",
          "http.method",
          "app.tier",
        ],
        reason: "",
      },
      ATTRIBUTES,
      3,
    );

    // The limit counts best, so two candidates fit.
    expect(keys(matches.candidates)).toEqual(["span.op", "http.method"]);
  });

  it("gives the whole limit to candidates when there's no usable best", () => {
    const madeUpBest = toAttributeMatches(
      {
        best: "http.verb",
        candidates: ["span.op", "app.tier", "http.method"],
        reason: "",
      },
      ATTRIBUTES,
      2,
    );
    expect(madeUpBest.best).toBeUndefined();
    expect(keys(madeUpBest.candidates)).toEqual(["span.op", "app.tier"]);

    expect(
      toAttributeMatches(
        { best: null, candidates: [], reason: "" },
        ATTRIBUTES,
        2,
      ),
    ).toEqual({ best: undefined, candidates: [] });
  });
});

describe("buildShortlistPrompt", () => {
  it("lists each attribute with only the details it has", () => {
    expect(
      buildShortlistPrompt({
        query: "HTTP method",
        dataset: "spans",
        limit: 5,
        attributes: [
          attribute("http.method", {
            secondaryAliases: ["method"],
            context: {
              brief: "The HTTP method used.",
              examples: ["GET", "POST"],
              isDeprecated: true,
              replacementAttribute: "http.request.method",
            },
          }),
          attribute("legacy.flag", {
            type: "boolean",
            context: { isDeprecated: true },
          }),
          attribute("app.tier", { context: { examples: ["gold"] } }),
          attribute("app.region"),
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Dataset: spans
      Question: HTTP method
      Return at most 5 keys in total, counting best.

      Attributes:
      - http.method (string): The HTTP method used. Examples: GET, POST. Aliases: method. Deprecated, replaced by http.request.method.
      - legacy.flag (boolean): Deprecated.
      - app.tier (string): Examples: gold.
      - app.region (string)"
    `);
  });
});

describe("cleanKeyHints", () => {
  it("trims, drops short and repeated hints, and keeps the first five", () => {
    // Case is kept, since substring matching is case-sensitive.
    expect(
      cleanKeyHints([
        " status ",
        "id",
        "status",
        "http",
        "",
        "code",
        "response",
        "userAgent",
        "extra",
      ]),
    ).toEqual(["status", "http", "code", "response", "userAgent"]);
  });
});
