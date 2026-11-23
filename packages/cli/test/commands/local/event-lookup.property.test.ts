import {
  array,
  boolean,
  constantFrom,
  assert as fcAssert,
  nat,
  oneof,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  EVENT_ID_PREFIX_MIN_LENGTH,
  matchEventIds,
  uniqueEventIdPrefixes,
} from "../../../src/commands/local/event-lookup.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Few hex digits, so generated IDs often share long prefixes. */
const eventIdArb = string({
  unit: constantFrom("0", "a", "f"),
  minLength: 1,
  maxLength: 32,
});
const eventIdsArb = array(eventIdArb, { maxLength: 30 });

/** Hex IDs in mixed case, with few digits so they often share prefixes. */
const mixedCaseHexIdArb = string({
  unit: constantFrom("0", "a", "A", "f", "F"),
  minLength: 1,
  maxLength: 32,
});
/** Replay segment keys: `<replay_id>:<segment_id>`. */
const replayKeyArb = tuple(mixedCaseHexIdArb, nat({ max: 12 })).map(
  ([replayId, segment]) => `${replayId}:${segment}`,
);
/** Lookup keys that are not hex, which match only in their own case. */
const nonHexIdArb = string({
  unit: constantFrom("0", "a", "A", "-", "x"),
  minLength: 1,
  maxLength: 16,
});

function swapCase(id: string): string {
  return id.replace(/[a-z]/gi, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  );
}

/**
 * IDs that share one base of 8+ characters in random case and end in short
 * tails that differ, like `AAAAAAAA1…` and `aaaaaaaa2…`.
 */
const nearTwinIdsArb = tuple(
  string({
    unit: constantFrom("0", "a", "A", "f", "F"),
    minLength: EVENT_ID_PREFIX_MIN_LENGTH,
    maxLength: 12,
  }),
  array(
    tuple(
      boolean(),
      oneof(
        string({ unit: constantFrom("1", "2", "f", "F"), maxLength: 3 }),
        nat({ max: 3 }).map((segment) => `:${segment}`),
      ),
    ),
    { minLength: 2, maxLength: 4 },
  ),
).map(([base, tails]) =>
  tails.map(([flip, tail]) => `${flip ? swapCase(base) : base}${tail}`),
);

/** Stored IDs of every kind, some also stored again in the other case. */
const storedIdsArb = tuple(
  array(tuple(oneof(mixedCaseHexIdArb, replayKeyArb, nonHexIdArb), boolean()), {
    maxLength: 30,
  }),
  nearTwinIdsArb,
).map(([entries, nearTwins]) => [
  ...entries.flatMap(([id, twin]) => (twin ? [id, swapCase(id)] : [id])),
  ...nearTwins,
]);

describe("property: Local event ID prefixes", () => {
  test("the prefix shown for each event opens that event and no other", () => {
    fcAssert(
      property(eventIdsArb, (ids) => {
        for (const [id, prefix] of uniqueEventIdPrefixes(ids)) {
          expect(id.startsWith(prefix)).toBe(true);
          expect(
            prefix.length >= EVENT_ID_PREFIX_MIN_LENGTH || prefix === id,
          ).toBe(true);
          expect(matchEventIds(ids, prefix)).toEqual([id]);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("each shown prefix of mixed-case, replay and non-hex IDs opens only its own event", () => {
    fcAssert(
      property(storedIdsArb, (ids) => {
        for (const [id, prefix] of uniqueEventIdPrefixes(ids)) {
          expect(id.startsWith(prefix)).toBe(true);
          expect(
            prefix.length >= EVENT_ID_PREFIX_MIN_LENGTH || prefix === id,
          ).toBe(true);
          expect(matchEventIds(ids, prefix)).toEqual([id]);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("IDs that differ only in case show in full", () => {
    fcAssert(
      property(storedIdsArb, (ids) => {
        const prefixes = uniqueEventIdPrefixes(ids);
        for (const id of ids) {
          const hasCaseTwin = ids.some(
            (other) => other !== id && other.toLowerCase() === id.toLowerCase(),
          );
          if (hasCaseTwin) {
            expect(prefixes.get(id)).toBe(id);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("a prefix of the minimum length or longer matches every ID it starts", () => {
    fcAssert(
      property(eventIdsArb, eventIdArb, (ids, reference) => {
        const matches = matchEventIds(ids, reference);
        if (ids.includes(reference)) {
          expect(matches).toEqual([reference]);
        } else if (reference.length < EVENT_ID_PREFIX_MIN_LENGTH) {
          expect(matches).toEqual([]);
        } else {
          expect(new Set(matches)).toEqual(
            new Set(ids.filter((id) => id.startsWith(reference))),
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
