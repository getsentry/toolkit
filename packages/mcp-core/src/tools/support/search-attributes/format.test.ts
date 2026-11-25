import { describe, expect, it } from "vitest";
import type { TraceItemAttribute } from "../../../api-client";
import { buildFindResult, buildListResult } from "./format";

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

describe("buildFindResult", () => {
  it("maps the best match's details and leaves the missing ones empty", () => {
    expect(
      buildFindResult({
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
          reason: null,
        },
      }),
    ).toMatchObject({
      resultType: "matches",
      best: {
        key: "log.legacy_level",
        type: "string",
        addedBySentry: true,
        description: null,
        examples: [],
        aliases: ["level"],
        deprecated: true,
        replacementKey: null,
      },
      attributes: [],
      notes: ["Use a key with `search_logs` to query its values."],
    });
  });

  it("says when nothing was seen, rather than that nothing matched", () => {
    const output = buildFindResult({
      dataset: "spans",
      period: "24h",
      query: "payment provider",
      totalAttributes: 0,
      matches: { candidates: [], reason: null },
    });

    expect(output.notes).toEqual([
      "No span attributes were seen in the last 24h.",
      "Try a longer `period` or a different `dataset`.",
    ]);
  });
});

describe("buildListResult", () => {
  it("keeps whole descriptions and example types", () => {
    const output = buildListResult({
      dataset: "spans",
      period: "14d",
      query: null,
      limit: 50,
      attributes: [
        attribute("app.note", {
          context: { brief: "First line\nsecond | part", examples: ["a|b"] },
        }),
        attribute("app.long", { context: { brief: "x".repeat(300) } }),
        attribute("app.retries", {
          type: "number",
          context: { examples: [3, 0] },
        }),
      ],
    });

    const byKey = new Map(output.attributes.map((a) => [a.key, a]));
    expect(byKey.get("app.long")?.description).toBe("x".repeat(300));
    // Line breaks are flattened
    expect(byKey.get("app.note")).toMatchObject({
      description: "First line second | part",
      examples: ["a|b"],
    });
    expect(byKey.get("app.retries")?.examples).toEqual([3, 0]);
  });

  it("puts the fallback note first, even when nothing was seen", () => {
    const output = buildListResult({
      dataset: "metrics",
      period: "7d",
      query: "retries",
      limit: 50,
      attributes: [],
      fallbackNote: "The AI provider couldn't match `query` right now.",
    });

    expect(output).toMatchObject({
      resultType: "list",
      query: "retries",
      presentationHint: null,
      notes: [
        "The AI provider couldn't match `query` right now.",
        "No metric attributes were seen in the last 7d.",
        "Try a longer `period` or a different `dataset`.",
      ],
    });
  });
});
