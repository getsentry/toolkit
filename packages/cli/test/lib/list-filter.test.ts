import { describe, expect, test } from "vitest";
import { filterByName, isGlobFilter } from "../../src/lib/list-filter.js";

type Item = { slug: string; name: string };

const ITEMS: Item[] = [
  { slug: "acme-prod", name: "Acme Production" },
  { slug: "acme-dev", name: "Acme Development" },
  { slug: "widgets", name: "Widget Co" },
];

const namesOf = (item: Item) => [item.slug, item.name];
const slugs = (items: Item[]) => items.map((item) => item.slug);

describe("filterByName", () => {
  test("an empty filter keeps every item", () => {
    expect(slugs(filterByName(ITEMS, undefined, namesOf))).toEqual(
      slugs(ITEMS),
    );
    expect(slugs(filterByName(ITEMS, "  ", namesOf))).toEqual(slugs(ITEMS));
  });

  test("a glob matches any whole name, ignoring case, in input order", () => {
    expect(slugs(filterByName(ITEMS, "ACME-*", namesOf))).toEqual([
      "acme-prod",
      "acme-dev",
    ]);
    expect(slugs(filterByName(ITEMS, "widget*", namesOf))).toEqual(["widgets"]);
    expect(filterByName(ITEMS, "acme?", namesOf)).toEqual([]);
  });

  test("plain text is a fuzzy search, best match first", () => {
    expect(slugs(filterByName(ITEMS, "acme-dev", namesOf))[0]).toBe("acme-dev");
    expect(slugs(filterByName(ITEMS, "widgts", namesOf))).toEqual(["widgets"]);
  });
});

describe("isGlobFilter", () => {
  test.each([
    ["acme-*", true],
    ["acme-?", true],
    ["{a,b}", true],
    ["acme", false],
  ])("%s → %s", (filter, expected) => {
    expect(isGlobFilter(filter)).toBe(expected);
  });
});
