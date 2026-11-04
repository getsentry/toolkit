import { expect, test } from "vitest";
import { readonlyCopy } from "./readonly.ts";

test("copies deep graphs without recursion while preserving aliases and cycles", () => {
  type Link = { next?: Link; root?: Link };
  const root: Link = {};
  let tail = root;
  for (let i = 0; i < 10000; i++) {
    tail.next = {};
    tail = tail.next;
  }
  tail.root = root;
  const input = { root, aliases: new Map([[root, new Set([tail])]]) };
  const copied = readonlyCopy(input);
  let current = copied.root;
  for (let i = 0; i < 10000; i++) {
    expect(Object.isFrozen(current)).toBe(true);
    current = current.next!;
  }
  expect(current.root === copied.root).toBe(true);
  expect(copied.aliases.get(copied.root)?.has(current)).toBe(true);
  expect(() => (copied.aliases as Map<Link, Set<Link>>).clear()).toThrow(
    TypeError,
  );
  expect(() =>
    (copied.aliases.get(copied.root) as Set<Link>).add(root),
  ).toThrow(TypeError);
  expect(root === copied.root).toBe(false);
  expect(Object.isFrozen(root)).toBe(false);
});
