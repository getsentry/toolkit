import { describe, expect, it } from "vitest";
import type { TraceItemAttribute } from "../../../api-client";
import {
  type AttributeMatches,
  buildShortlistPrompt,
  toAttributeMatches,
} from "./agent";

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

function keys({ best, candidates }: AttributeMatches) {
  return {
    best: best?.key,
    candidates: candidates.map((attribute) => attribute.key),
  };
}

describe("toAttributeMatches", () => {
  const attributes = [
    attr("http.response.status_code", { type: "number" }),
    attr("http.status_code", { type: "number" }),
    attr("span.status"),
    attr("custom.tier"),
  ];

  it("keeps only fetched keys, in the agent's order", () => {
    expect(
      keys(
        toAttributeMatches(
          {
            best: "http.response.status_code",
            candidates: ["span.status", "http.statuscode", "http.status_code"],
          },
          attributes,
          10,
        ),
      ),
    ).toEqual({
      best: "http.response.status_code",
      candidates: ["span.status", "http.status_code"],
    });
  });

  it("drops a best key that wasn't fetched", () => {
    expect(
      keys(
        toAttributeMatches(
          { best: "HTTP.Response.Status_Code", candidates: ["span.status"] },
          attributes,
          10,
        ),
      ),
    ).toEqual({ best: undefined, candidates: ["span.status"] });
  });

  it("removes the best key and repeats from the candidates", () => {
    expect(
      keys(
        toAttributeMatches(
          {
            best: "span.status",
            candidates: ["span.status", "custom.tier", "custom.tier"],
          },
          attributes,
          10,
        ),
      ),
    ).toEqual({ best: "span.status", candidates: ["custom.tier"] });
  });

  it("counts the best match toward the limit", () => {
    const candidates = ["http.status_code", "span.status", "custom.tier"];

    expect(
      keys(
        toAttributeMatches(
          { best: "http.response.status_code", candidates },
          attributes,
          2,
        ),
      ),
    ).toEqual({
      best: "http.response.status_code",
      candidates: ["http.status_code"],
    });
    expect(
      keys(toAttributeMatches({ best: null, candidates }, attributes, 2)),
    ).toEqual({
      best: undefined,
      candidates: ["http.status_code", "span.status"],
    });
  });
});

describe("buildShortlistPrompt", () => {
  it("lists each attribute with its type, description, aliases, and deprecation", () => {
    expect(
      buildShortlistPrompt({
        query: "HTTP status code",
        dataset: "spans",
        limit: 10,
        attributes: [
          attr("http.status_code", {
            type: "number",
            context: {
              isConvention: true,
              brief: "The status code of the HTTP response.",
              isDeprecated: true,
              examples: [200, 404],
              replacementAttribute: "http.response.status_code",
            },
          }),
          attr("span.description", {
            secondaryAliases: ["description", "message"],
            context: {
              brief: "Description of the span's operation.",
              isDeprecated: false,
            },
          }),
          attr("legacy.flag", {
            type: "boolean",
            context: { brief: "An old flag.", isDeprecated: true },
          }),
          attr("custom.tier"),
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Dataset: spans
      Question: HTTP status code
      Return at most 10 keys in total, counting best.

      Attributes:
      - http.status_code (number): The status code of the HTTP response. Examples: 200, 404. Deprecated, replaced by http.response.status_code.
      - span.description (string): Description of the span's operation. Aliases: description, message.
      - legacy.flag (boolean): An old flag. Deprecated.
      - custom.tier (string): custom.tier"
    `);
  });
});
