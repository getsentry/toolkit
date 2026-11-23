import { describe, expect, test } from "vitest";
import {
  matchEventIds,
  uniqueEventIdPrefixes,
} from "../../../src/commands/local/event-lookup.js";

const replayId = "aaaaaaaa1111111111111111111111a1";

describe("matchEventIds", () => {
  test("a bare replay ID opens its lowest segment, compared as a number", () => {
    expect(
      matchEventIds([`${replayId}:10`, `${replayId}:2`], replayId),
    ).toEqual([`${replayId}:2`]);
  });

  test("an exact ID wins over the replay segments it prefixes", () => {
    expect(
      matchEventIds([`${replayId}:0`, replayId, `${replayId}:1`], replayId),
    ).toEqual([replayId]);
  });

  test("a reference that also prefixes a non-segment ID stays ambiguous", () => {
    expect(matchEventIds([`${replayId}:0`, `${replayId}ff`], replayId)).toEqual(
      [`${replayId}:0`, `${replayId}ff`],
    );
  });

  test("upper-case hex matches lower-case IDs", () => {
    expect(
      matchEventIds([`${replayId}:0`], `${replayId.toUpperCase()}:0`),
    ).toEqual([`${replayId}:0`]);
    expect(matchEventIds([replayId], "AAAAAAAA")).toEqual([replayId]);
  });

  test("an upper-case stored ID opens from its prefix, as typed or folded", () => {
    const stored = replayId.toUpperCase();
    for (const reference of [stored.slice(0, 8), replayId.slice(0, 8)]) {
      expect(matchEventIds([stored], reference)).toEqual([stored]);
    }
    expect(matchEventIds([`${stored}:1`, `${stored}:0`], replayId)).toEqual([
      `${stored}:0`,
    ]);
  });

  test("a short non-hex key still matches only exactly", () => {
    expect(matchEventIds(["One", "one"], "One")).toEqual(["One"]);
  });
});

describe("uniqueEventIdPrefixes", () => {
  test("IDs that share a prefix in another case get prefixes that open only them", () => {
    const upper = "AAAAAAAA111111111111111111111111";
    const lower = "aaaaaaaa222222222222222222222222";
    const ids = [upper, lower];
    const prefixes = uniqueEventIdPrefixes(ids);
    expect(prefixes.get(upper)).toBe("AAAAAAAA1");
    expect(prefixes.get(lower)).toBe("aaaaaaaa2");
    expect(matchEventIds(ids, "AAAAAAAA1")).toEqual([upper]);
    expect(matchEventIds(ids, "aaaaaaaa2")).toEqual([lower]);
  });

  test("IDs that differ only in case show in full", () => {
    const upper = "AAAAAAAA111111111111111111111111";
    const lower = upper.toLowerCase();
    const prefixes = uniqueEventIdPrefixes([upper, lower]);
    expect(prefixes.get(upper)).toBe(upper);
    expect(prefixes.get(lower)).toBe(lower);
  });
});
