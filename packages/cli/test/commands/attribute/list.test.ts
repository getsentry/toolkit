/**
 * Attribute List Command Tests
 *
 * Tests for `sentry attribute list` in src/commands/attribute/list.ts:
 * flag parsing, the API call it makes, JSON/human output, display names,
 * --limit trimming, --context, and footer hints.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildUsageTip,
  buildWithQuery,
  compareAttributes,
  dropLookAheadRows,
  listCommand,
  parseAttributeTypes,
  parseDataset,
  parseWithKeys,
} from "../../../src/commands/attribute/list.js";
import {
  describeAttribute,
  toAttributeListItem,
} from "../../../src/lib/formatters/attribute.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v as (...args: unknown[]) => unknown) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v as (...args: unknown[]) => unknown) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";
import { parsePeriod } from "../../../src/lib/time-range.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("attribute-list-");

type Attr = Parameters<typeof compareAttributes>[0];

function attr(
  name: string,
  attributeType: Attr["attributeType"] = "string",
  source: "sentry" | "user" = "sentry",
  extra: Partial<Attr> = {},
): Attr {
  // Custom non-string attributes come back with Sentry's typed key form.
  const key =
    source === "user" && attributeType !== "string"
      ? `tags[${name},${attributeType}]`
      : name;
  return {
    key,
    name,
    attributeType,
    attributeSource: { source_type: source },
    ...extra,
  };
}

const HTTP_METHOD = attr("http.method", "string", "sentry", {
  secondaryAliases: ["http.request.method"],
});
const CART_TOTAL = attr("cart.total", "number", "user");
const ATTRIBUTES = [HTTP_METHOD, CART_TOTAL];

/** A deprecated key with full context metadata. */
const CONTEXT_ATTRIBUTE = attr("http.method", "string", "sentry", {
  context: {
    isConvention: true,
    brief: "The HTTP request method.",
    isDeprecated: true,
    replacementAttribute: "http.request.method",
    examples: ["GET", "POST", "PUT", "PATCH"],
  },
});

function createMockContext() {
  const stdoutWrite = vi.fn((_chunk: string) => true);
  const stderrWrite = vi.fn((_chunk: string) => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

/** Flags as Stricli would hand them to func (defaults applied). */
function flags(overrides: Record<string, unknown> = {}) {
  return {
    dataset: "spans",
    period: parsePeriod("14d"),
    context: false,
    limit: 25,
    json: false,
    fresh: false,
    ...overrides,
  };
}

/** The loaded command function, typed for direct `.call` in tests. */
type ListFunc = (
  this: unknown,
  flags: Record<string, unknown>,
  ...args: unknown[]
) => Promise<void>;

async function run(
  flagOverrides: Record<string, unknown>,
  target?: string,
): Promise<string> {
  const { context, stdoutWrite } = createMockContext();
  const func = (await listCommand.loader()) as unknown as ListFunc;
  await func.call(context, flags(flagOverrides), target);
  return stdoutWrite.mock.calls.map((c) => c[0]).join("");
}

const listSpy = vi.mocked(apiClient.listTraceItemAttributes);
const resolveSpy = vi.mocked(resolveTarget.resolveOrgOptionalFromArg);

afterEach(() => {
  listSpy.mockReset();
  resolveSpy.mockReset();
});

describe("parseDataset", () => {
  test("maps user-facing names and aliases to API datasets", () => {
    expect(parseDataset("spans")).toBe("spans");
    expect(parseDataset("span")).toBe("spans");
    expect(parseDataset("LOGS")).toBe("logs");
    expect(parseDataset("metrics")).toBe("tracemetrics");
  });

  test("rejects unknown datasets", () => {
    expect(() => parseDataset("errors")).toThrow(ValidationError);
  });
});

describe("parseAttributeTypes", () => {
  test("accepts repeated and comma-separated values, deduplicated", () => {
    expect(
      parseAttributeTypes(["string,number", "NUMBER", " boolean "]),
    ).toEqual(["string", "number", "boolean"]);
  });

  test("returns undefined when no types are given", () => {
    expect(parseAttributeTypes(undefined)).toBeUndefined();
    expect(parseAttributeTypes([])).toBeUndefined();
    expect(parseAttributeTypes([","])).toBeUndefined();
  });

  test("rejects unknown types", () => {
    expect(() => parseAttributeTypes(["string,float"])).toThrow(
      ValidationError,
    );
  });
});

describe("parseWithKeys / buildWithQuery", () => {
  test("accepts repeated and comma-separated keys, deduplicated", () => {
    expect(
      parseWithKeys(["gen_ai.request.model,http.method", " http.method "]),
    ).toEqual(["gen_ai.request.model", "http.method"]);
  });

  test("keeps typed tags[...] keys intact", () => {
    expect(parseWithKeys(["tags[cart.total,number],http.method"])).toEqual([
      "tags[cart.total,number]",
      "http.method",
    ]);
  });

  test("returns undefined when no keys are given", () => {
    expect(parseWithKeys(undefined)).toBeUndefined();
    expect(parseWithKeys([" , "])).toBeUndefined();
  });

  test("rejects keys that look like search syntax", () => {
    expect(() => parseWithKeys(['span.op:"db"'])).toThrow(ValidationError);
    expect(() => parseWithKeys(["span.op db"])).toThrow(ValidationError);
  });

  test("builds has: filters for every key", () => {
    expect(buildWithQuery(["gen_ai.request.model", "http.method"])).toBe(
      "has:gen_ai.request.model has:http.method",
    );
  });
});

describe("buildUsageTip", () => {
  const items = [HTTP_METHOD, CART_TOTAL].map(toAttributeListItem);

  /**
   * Assert the tip's structure, not its prose: it must be a `Tip:` line (so
   * the tips preference can strip it) carrying a runnable command.
   */
  function expectTipWithCommand(tip: string | undefined, command: string) {
    expect(tip).toMatch(/^Tip: /);
    expect(tip).not.toContain("\n");
    expect(tip).toContain(command);
  }

  test("spans: suggests span list with a custom key, quoted for the shell", () => {
    const tip = buildUsageTip("spans", "my-org", "backend", items);
    expectTipWithCommand(tip, "sentry span list my-org/backend");
    expect(tip).toContain('-q "has:tags[cart.total,number]"');
    expect(tip).toContain("--fields 'tags[cart.total,number]'");
  });

  test("logs: suggests log list, with a <project> placeholder for org-wide listings", () => {
    const tip = buildUsageTip("logs", "my-org", undefined, [
      toAttributeListItem(HTTP_METHOD),
    ]);
    expectTipWithCommand(tip, "sentry log list my-org/<project>");
    expect(tip).toContain('-q "has:http.method"');
    expect(tip).toContain("--fields http.method");
  });

  test("metrics: points at explore", () => {
    expectTipWithCommand(
      buildUsageTip("tracemetrics", "my-org", undefined, items),
      "sentry explore my-org/ --dataset metrics",
    );
  });

  test("returns nothing for an empty page", () => {
    expect(buildUsageTip("spans", "my-org", undefined, [])).toBeUndefined();
  });
});

describe("dropLookAheadRows", () => {
  test("keeps at most `limit` rows per type, in server order", () => {
    const data = [
      attr("s1"),
      attr("s2"),
      attr("s3"), // look-ahead row for strings
      attr("n1", "number", "user"),
      attr("n2", "number", "user"),
    ];
    expect(dropLookAheadRows(data, 2).map((a) => a.name)).toEqual([
      "s1",
      "s2",
      "n1",
      "n2",
    ]);
  });
});

describe("compareAttributes", () => {
  test("sorts by display name (not the tags[] key), then type", () => {
    const sorted = [
      attr("zeta"),
      attr("alpha", "number", "user"),
      attr("alpha"),
      attr("beta", "boolean", "user"),
    ].sort(compareAttributes);
    expect(sorted.map((a) => `${a.name}:${a.attributeType}`)).toEqual([
      "alpha:number",
      "alpha:string",
      "beta:boolean",
      "zeta:string",
    ]);
  });
});

describe("describeAttribute", () => {
  test("puts the deprecation note and replacement before the brief", () => {
    expect(describeAttribute(CONTEXT_ATTRIBUTE.context!)).toBe(
      "Deprecated, use http.request.method. The HTTP request method.",
    );
  });

  test("handles deprecation without a replacement, and empty context", () => {
    expect(describeAttribute({ isDeprecated: true })).toBe("Deprecated.");
    expect(describeAttribute({ brief: "Cart total." })).toBe("Cart total.");
    expect(describeAttribute({})).toBe("");
  });
});

describe("listCommand.func", () => {
  test("lists span attributes for a project, 25 per page over 14d, sorted by name", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org", project: "backend" });
    listSpy.mockResolvedValue({ data: ATTRIBUTES });

    const output = await run({ json: true }, "my-org/backend");

    expect(listSpy).toHaveBeenCalledWith("my-org", {
      dataset: "spans",
      project: ["backend"],
      attributeTypes: undefined,
      substringMatch: undefined,
      query: undefined,
      context: false,
      perPage: 25,
      statsPeriod: "14d",
    });
    expect(JSON.parse(output)).toEqual({
      data: [
        {
          key: "tags[cart.total,number]",
          name: "cart.total",
          type: "number",
          source: "user",
        },
        {
          key: "http.method",
          name: "http.method",
          type: "string",
          source: "sentry",
          aliases: ["http.request.method"],
        },
      ],
      hasMore: false,
      hasPrev: false,
    });
  });

  test("passes dataset, types, search, --with, and limit through for an org-wide listing", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({ data: [] });

    await run(
      {
        json: true,
        dataset: "logs",
        type: ["string,boolean"],
        search: "http",
        with: ["gen_ai.request.model", "http.method"],
        period: parsePeriod("24h"),
        limit: 50,
      },
      "my-org/",
    );

    expect(listSpy).toHaveBeenCalledWith("my-org", {
      dataset: "logs",
      project: undefined,
      attributeTypes: ["string", "boolean"],
      substringMatch: "http",
      query: "has:gen_ai.request.model has:http.method",
      context: false,
      perPage: 50,
      statsPeriod: "24h",
    });
  });

  test("shows the exact key in the table, including typed tags[...] keys", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({ data: ATTRIBUTES });

    const output = await run({}, "my-org/");
    // Check the table rows only, not the Tip: line, which also prints a key.
    const table = output
      .split("\n")
      .filter((line) => !line.includes("Tip:"))
      .join("\n");

    expect(table).toContain("KEY");
    expect(table).toContain(CART_TOTAL.key);
    expect(table).toContain(HTTP_METHOD.key);
  });

  test("--fields selects flattened keys in JSON output", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({ data: ATTRIBUTES });

    const output = await run(
      { json: true, fields: ["name", "type"] },
      "my-org/",
    );

    expect(JSON.parse(output).data).toEqual([
      { name: "cart.total", type: "number" },
      { name: "http.method", type: "string" },
    ]);
  });

  test("renders a table and points at -n when the server has more", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({ data: ATTRIBUTES, nextCursor: "0:100:0" });

    const output = await run(
      { dataset: "logs", search: "http", type: ["string"], limit: 10 },
      "my-org/",
    );

    expect(output).toContain("TYPE");
    expect(output).toContain("SOURCE");
    expect(output).toContain("http.method");
    expect(output).toContain("-n 20");
  });

  test("drops the server's look-ahead row for a single type", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    // Sentry returns limit + 1 rows when more exist.
    listSpy.mockResolvedValue({
      data: [attr("a"), attr("b"), attr("c")],
      nextCursor: "0:2:0",
    });

    const json = JSON.parse(
      await run({ json: true, limit: 2, type: ["string"] }, "my-org/"),
    );
    expect(json.data.map((a: { name: string }) => a.name)).toEqual(["a", "b"]);
    expect(json.hasMore).toBe(true);
  });

  test("trims a page over --limit, keeps hasMore, and suggests -n or narrowing", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({
      data: [attr("c"), attr("a", "number", "user"), attr("b")],
      nextCursor: "0:2:0",
    });

    const json = JSON.parse(await run({ json: true, limit: 2 }, "my-org/"));
    expect(json.data.map((a: { name: string }) => a.name)).toEqual(["a", "b"]);
    expect(json.hasMore).toBe(true);

    const output = await run({ limit: 2 }, "my-org/");
    expect(output).toContain(
      "Showing 2 of 3+ spans attributes in my-org/. Use -n 4 for more, or narrow with --type or --search.",
    );
  });

  test("prints a usage tip on its own line after the count", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org", project: "backend" });
    listSpy.mockResolvedValue({ data: ATTRIBUTES });

    const output = await run({}, "my-org/backend");

    const count = output.indexOf(
      "Showing 2 spans attributes in my-org/backend.",
    );
    const tipLine = output.split("\n").find((line) => line.includes("Tip:"));
    expect(count).toBeGreaterThan(-1);
    expect(tipLine).toContain("sentry span list my-org/backend");
    // On its own line after the count, so `sentry cli defaults tips off`
    // strips only the tip and keeps the count text.
    expect(output.indexOf(tipLine!)).toBeGreaterThan(count);
    expect(tipLine).not.toContain("Showing");
  });

  test("says so when no attributes match", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({ data: [] });

    const output = await run({}, "my-org/");

    expect(output).toContain("No attributes found.");
  });

  test("--context requests metadata and includes it in JSON", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({
      data: [{ ...CART_TOTAL, context: {} }, CONTEXT_ATTRIBUTE],
    });

    const output = await run({ json: true, context: true }, "my-org/");

    expect(listSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ context: true }),
    );
    const { data } = JSON.parse(output);
    expect(data[0].context).toEqual({});
    expect(data[1].context).toEqual(CONTEXT_ATTRIBUTE.context);
  });

  test("omits context from JSON without --context", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({ data: ATTRIBUTES });

    const output = await run({ json: true }, "my-org/");

    for (const item of JSON.parse(output).data) {
      expect(item).not.toHaveProperty("context");
    }
  });

  test("--context adds description and example columns to the table", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockResolvedValue({
      data: [CONTEXT_ATTRIBUTE],
      nextCursor: "0:100:0",
    });
    const context = CONTEXT_ATTRIBUTE.context!;
    const examples = context.examples!.map(String);

    const withContext = await run({ context: true }, "my-org/");

    // The extra columns appear only with --context.
    for (const header of ["DESCRIPTION", "EXAMPLES"]) {
      expect(withContext).toContain(header);
    }
    // The row has entries from the attribute's context, whatever the wording:
    // the deprecation note's replacement key, and leading example values.
    expect(withContext).toContain(context.replacementAttribute);
    expect(withContext).toContain(examples[0]);
    // Long example lists are cut short.
    expect(withContext).not.toContain(examples.at(-1));
  });

  test("turns a Sentry query parse error into a --with validation error", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockRejectedValue(
      new ApiError(
        "Failed to list spans attributes",
        400,
        "Error parsing search query: Expected one of: ...",
      ),
    );

    await expect(run({ with: ["bad]key"] }, "my-org/")).rejects.toThrow(
      /Sentry rejected --with bad\]key/,
    );
  });

  test("rejects an invalid --type before calling the API", async () => {
    await expect(run({ type: ["text"] }, "my-org/")).rejects.toThrow(
      ValidationError,
    );
    expect(listSpy).not.toHaveBeenCalled();
  });
});
