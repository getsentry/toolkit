import { expect, test } from "vitest";
import { decodeEnvelope } from "./spotlight.ts";
import { parseProfile } from "./profiles.ts";

const chunk = (id: string, name: string, start: number, profiler = "p") =>
  decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "profile_chunk" },
          {
            chunk_id: id,
            profiler_id: profiler,
            profile: {
              frames: [{ function: name }],
              stacks: [[0]],
              samples: [
                { thread_id: "main", stack_id: 0, timestamp: start },
                { thread_id: "main", stack_id: 0, timestamp: start + 0.01 },
              ],
            },
          },
        ],
      ],
    ]),
    id,
  )[0]!;

test("profile sessions combine retained chunks with distinct frame tables in timestamp order", () => {
  const first = chunk("a", "first", 1),
    second = chunk("b", "second", 1.02);
  const before = JSON.stringify([first, second]);
  const profile = parseProfile(first, undefined, [second, first]);
  expect(profile.sampleCount).toBe(4);
  expect(profile.functions.map((fn) => fn.name).toSorted()).toEqual([
    "first",
    "second",
  ]);
  expect(profile.durationMs).toBeCloseTo(20);
  expect(parseProfile(first, undefined, [first, second])).toEqual(profile);
  expect(JSON.stringify([first, second])).toBe(before);
});

test("profile session replay does not double count samples or mix profiler identities", () => {
  const first = chunk("a", "first", 1),
    second = chunk("b", "second", 1.02);
  const replay = { ...first, id: "replay" };
  const other = chunk("c", "unrelated", 1.01, "other");
  expect(
    parseProfile(first, undefined, [first, second, replay, other]).sampleCount,
  ).toBe(4);
  expect(
    parseProfile(first, undefined, [first, second, other]).functions.map(
      (fn) => fn.name,
    ),
  ).not.toContain("unrelated");
  expect(parseProfile(first).sampleCount).toBe(2);
});

test("continuous profiles default to the captured active thread without mixing thread intervals", () => {
  const item = chunk("a", "main", 1);
  const payload = item.payload as {
    profile: { samples: unknown[]; active_thread_id?: string };
  };
  payload.profile.active_thread_id = "main";
  payload.profile.samples.unshift({
    thread_id: "worker",
    stack_id: 0,
    timestamp: 0,
  });
  const profile = parseProfile(item, undefined, [item]);
  expect(profile.threadId).toBe("main");
  expect(profile.sampleCount).toBe(2);
  expect(profile.durationMs).toBeCloseTo(10);
  expect(parseProfile(item, "worker", [item]).sampleCount).toBe(1);
});

test("a later chunk update replaces the same captured chunk without changing unrelated chunks", () => {
  const first = chunk("a", "old", 1),
    updated = chunk("a", "updated", 1);
  const second = chunk("b", "second", 1.02);
  expect(
    parseProfile(first, undefined, [first, second, updated])
      .functions.map((fn) => fn.name)
      .toSorted(),
  ).toEqual(["second", "updated"]);
});

test("profile sessions do not count gaps between retained chunks as observed CPU time", () => {
  const first = chunk("a", "first", 1),
    second = chunk("b", "second", 10);
  expect(
    parseProfile(first, undefined, [first, second]).durationMs,
  ).toBeCloseTo(20);
});

test("shared boundary samples deduplicate despite JSON field order and keep the next observed interval", () => {
  const first = chunk("a", "same", 1),
    second = chunk("b", "same", 1.01);
  const payload = second.payload as {
    profile: { frames: unknown[]; samples: unknown[] };
  };
  payload.profile.frames = [{ function: "same" }];
  payload.profile.samples = [1.01, 1.02].map((timestamp) => ({
    timestamp,
    stack_id: 0,
    thread_id: "main",
  }));
  const profile = parseProfile(first, undefined, [first, second]);
  expect(profile.sampleCount).toBe(3);
  expect(profile.durationMs).toBeCloseTo(20);
});
