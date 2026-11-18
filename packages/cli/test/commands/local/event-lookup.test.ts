import { describe, expect, test } from "vitest";
import { matchEventIds } from "../../../src/commands/local/event-lookup.js";

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
