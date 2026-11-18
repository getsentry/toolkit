import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  string,
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
