import { describe, expect, test, vi } from "vitest";
import {
  fetchByName,
  filterByName,
  isGlobFilter,
  orgFilterTarget,
  serverSearchText,
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

describe("serverSearchText", () => {
  test.each([
    ["frontend", "frontend"],
    [" web ", "web"],
    // A glob sends its longest literal part: every match contains it.
    ["web-*", "web-"],
    ["*-sdk", "-sdk"],
    ["getsentry/*", "getsentry/"],
    ["api-?-prod*", "-prod"],
    ["{web,api}-front*", "-front"],
    ["[ab]ackend", "ackend"],
    // Too little literal text to narrow anything.
    ["*", undefined],
    ["a*", undefined],
    // Search syntax, negation, extglobs, and escapes aren't sent.
    ["team:backend", undefined],
    ['"quoted"', undefined],
    ["!web-*", undefined],
    ["web-+(a|b)", undefined],
    ["web\\*", undefined],
  ] as const)("%j → %j", (filter, expected) => {
    expect(serverSearchText(filter)).toBe(expected);
  });
});

describe("fetchByName", () => {
  /** A server `?query=`: case-insensitive substring on slug or name. */
  const search = vi.fn((query: string) =>
    Promise.resolve(
      ITEMS.filter((item) =>
        namesOf(item).some((name) =>
          name.toLowerCase().includes(query.toLowerCase()),
        ),
      ),
    ),
  );
  const fetchAll = vi.fn(() => Promise.resolve(ITEMS));

  test("lets the server narrow a direct match", async () => {
    search.mockClear();
    fetchAll.mockClear();
    const items = await fetchByName({
      filter: "acme",
      namesOf,
      fetchAll,
      search,
    });
    expect(slugs(items).sort()).toEqual(["acme-dev", "acme-prod"]);
    expect(search).toHaveBeenCalledWith("acme");
    expect(fetchAll).not.toHaveBeenCalled();
  });

  test("falls back to fuzzy matching when nothing matches directly", async () => {
    search.mockClear();
    fetchAll.mockClear();
    const items = await fetchByName({
      filter: "widgtes",
      namesOf,
      fetchAll,
      search,
    });
    expect(slugs(items)).toEqual(["widgets"]);
    expect(search).toHaveBeenCalledWith("widgtes");
    expect(fetchAll).toHaveBeenCalledOnce();
  });

  test("a glob trusts the server's narrowing, even when empty", async () => {
    search.mockClear();
    fetchAll.mockClear();
    const items = await fetchByName({
      filter: "nope-*",
      namesOf,
      fetchAll,
      search,
    });
    expect(items).toEqual([]);
    expect(search).toHaveBeenCalledWith("nope-");
    expect(fetchAll).not.toHaveBeenCalled();
  });

  test("without search, matches over every item", async () => {
    fetchAll.mockClear();
    const items = await fetchByName({ filter: "acme-d*", namesOf, fetchAll });
    expect(slugs(items)).toEqual(["acme-dev"]);
    expect(fetchAll).toHaveBeenCalledOnce();
  });
});

describe("orgFilterTarget", () => {
  test.each([
    [undefined, "acme/"],
    ["web-*", "acme/web-*"],
    ["frontend", "acme/ frontend"],
  ] as const)("%j → %j", (filter, expected) => {
    expect(orgFilterTarget("acme", filter)).toBe(expected);
  });

  test("quotes each argument", () => {
    const quote = (arg: string) => `'${arg}'`;
    expect(orgFilterTarget("acme", "web-*", quote)).toBe("'acme/web-*'");
    expect(orgFilterTarget("acme", "front end", quote)).toBe(
      "acme/ 'front end'",
    );
  });
});
