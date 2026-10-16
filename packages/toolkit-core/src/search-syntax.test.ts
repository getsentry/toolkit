import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FilterType,
  getKeyName,
  type FilterToken,
  type KeyToken,
  parseSearch,
  parseSearchOrThrow,
  type SearchConfig,
  TermOperator,
  Token,
  TokenConverter,
} from "./search-syntax";

// Copied from getsentry/sentry `fixtures/search-syntax`. The frontend parser
// and the backend `event_search.py` grammar both test against these.
const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/search-syntax",
);

type FixtureCase = {
  query: string;
  result: unknown[];
  additionalConfig?: Partial<SearchConfig> & Record<string, unknown>;
  raisesError?: boolean;
};

// Location, text, `parsed` values, and validation results are frontend
// concerns the structural converter does not produce; compare everything else.
const STRIPPED_KEYS = new Set([
  "location",
  "text",
  "config",
  "parsed",
  "invalid",
  "warning",
]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !STRIPPED_KEYS.has(key))
        .map(([key, inner]) => [key, normalize(inner)]),
    );
  }
  return value;
}

const fixtureFiles = readdirSync(FIXTURES_DIR).filter((file) =>
  file.endsWith(".json"),
);

describe("search-syntax fixtures", () => {
  it("loads the shared fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThan(70);
  });

  for (const file of fixtureFiles) {
    const cases = JSON.parse(
      readFileSync(join(FIXTURES_DIR, file), "utf-8"),
    ) as FixtureCase[];

    describe(file.replace(/\.json$/, ""), () => {
      for (const testCase of cases) {
        it(`handles ${JSON.stringify(testCase.query)}`, () => {
          const result = parseSearch(testCase.query, {
            config: testCase.additionalConfig,
          });
          if (testCase.raisesError) {
            expect(result).toBeNull();
            return;
          }
          expect(result).not.toBeNull();
          expect(normalize(result)).toEqual(normalize(testCase.result));
        });
      }
    });
  }
});

describe("parseSearch", () => {
  it("keeps exact text and offsets on every token", () => {
    const query = "!level:error count():>10 (a OR b)";
    const result = parseSearchOrThrow(query);
    expect(result.map((token) => token.text).join("")).toBe(query);
    for (const token of result) {
      expect(
        query.slice(token.location.start.offset, token.location.end.offset),
      ).toBe(token.text);
    }
  });

  it("classifies typed filters from the default key sets", () => {
    const result = parseSearchOrThrow(
      "transaction.duration:>1s error.handled:true timestamp:-24h count():>10",
    );
    const filters = result.filter(
      (token): token is FilterToken => token.type === Token.FILTER,
    );
    expect(filters.map((filter) => filter.filter)).toEqual([
      FilterType.DURATION,
      FilterType.BOOLEAN,
      FilterType.RELATIVE_DATE,
      FilterType.AGGREGATE_NUMERIC,
    ]);
    expect(filters[0]?.operator).toBe(TermOperator.GREATER_THAN);
  });

  it("returns null for queries that do not parse, and throws from parseSearchOrThrow", () => {
    // The grammar falls back to free text for almost anything; a newline
    // outside quotes is one of the few inputs it rejects.
    expect(parseSearch("release:a\nrelease")).toBeNull();
    expect(() => parseSearchOrThrow("release:a\nrelease")).toThrow();
  });

  it("builds paren tokens instead of groups with flattenParenGroups", () => {
    const grouped = parseSearchOrThrow("(a:b)");
    expect(grouped.map((token) => token.type)).toContain(Token.LOGIC_GROUP);
    const flat = parseSearchOrThrow("(a:b)", {
      config: { flattenParenGroups: true },
    });
    expect(flat.map((token) => token.type)).toEqual([
      Token.SPACES,
      Token.L_PAREN,
      Token.SPACES,
      Token.FILTER,
      Token.SPACES,
      Token.R_PAREN,
      Token.SPACES,
    ]);
  });

  it("uses a converter subclass for validation", () => {
    class NoFreeText extends TokenConverter {
      override checkInvalidFreeText(value: string) {
        return { type: "free-text-not-allowed", reason: `no "${value}"` };
      }
    }
    const result = parseSearchOrThrow("hello", { converter: NoFreeText });
    const freeText = result.find((token) => token.type === Token.FREE_TEXT);
    expect(freeText).toMatchObject({
      invalid: { type: "free-text-not-allowed", reason: 'no "hello"' },
    });
  });
});

describe("getKeyName", () => {
  function firstKey(query: string): KeyToken {
    const filter = parseSearchOrThrow(query).find(
      (token): token is FilterToken => token.type === Token.FILTER,
    );
    if (!filter) {
      throw new Error(`no filter in ${query}`);
    }
    return filter.key;
  }

  it("names each key kind the way the API expects", () => {
    expect(getKeyName(firstKey("level:error"))).toBe("level");
    expect(getKeyName(firstKey("tags[foo]:bar"))).toBe("foo");
    expect(getKeyName(firstKey("tags[foo,number]:1"))).toBe("tags[foo,number]");
    expect(getKeyName(firstKey("flags[beta]:on"))).toBe("flags[beta]");
    expect(getKeyName(firstKey("foo[*]:bar"))).toBe("foo");
    expect(getKeyName(firstKey("count():>1"))).toBe("count");
    expect(
      getKeyName(firstKey("p95(span.duration):>1"), {
        aggregateWithArgs: true,
      }),
    ).toBe("p95(span.duration)");
  });
});
