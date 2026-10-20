import { describe, expect, test } from "vitest";
import {
  filterByName,
  isGlobFilter,
  splitListTargetAndFilter,
} from "../../src/lib/list-filter.js";

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

  test("a glob's * also matches /, since names aren't paths", () => {
    const repos = [
      { name: "getsentry/sentry-python-sdk" },
      { name: "acme/web" },
    ];
    expect(
      filterByName(repos, "*-sdk", (repo) => [repo.name]).map((r) => r.name),
    ).toEqual(["getsentry/sentry-python-sdk"]);
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

describe("splitListTargetAndFilter", () => {
  test.each([
    [[undefined, undefined], {}],
    [["my-org/", undefined], { target: "my-org/" }],
    [["my-org/", " web-* "], { target: "my-org/", filter: "web-*" }],
    [["my-org/", "  "], { target: "my-org/" }],
    // A lone bare name is still a project search.
    [["web", undefined], { target: "web" }],
    // No slug has glob characters, so a lone glob is a filter.
    [["web-*", undefined], { filter: "web-*" }],
    [["my-org/web-*", undefined], { target: "my-org/", filter: "web-*" }],
    [["my-org/web,api", undefined], { target: "my-org/web,api" }],
    [["my-org/proj/x*", undefined], { target: "my-org/proj/x*" }],
  ] as const)("%j → %j", ([target, filter], expected) => {
    const result = splitListTargetAndFilter(target, filter);
    expect({
      ...(result.target !== undefined && { target: result.target }),
      ...(result.filter !== undefined && { filter: result.filter }),
    }).toEqual(expected);
  });
});
