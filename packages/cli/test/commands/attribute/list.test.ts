/**
 * Attribute List Command Tests
 *
 * Tests for `sentry attribute list` in src/commands/attribute/list.ts:
 * flag parsing, the per-type API calls it makes, JSON/human output, display
 * names, --limit trimming, -c next/prev, --context, and footer hints.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildUsageTip,
  compareAttributes,
  listCommand,
  parseAttributeTypes,
  parseAttributeFilter,
  selectAcrossTypes,
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
    period: parsePeriod("7d"),
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
  filter?: string,
): Promise<string> {
  const { context, stdoutWrite } = createMockContext();
  const func = (await listCommand.loader()) as unknown as ListFunc;
  await func.call(context, flags(flagOverrides), target, filter);
  return stdoutWrite.mock.calls.map((c) => c[0]).join("");
}

const listSpy = vi.mocked(apiClient.listTraceItemAttributes);
const resolveSpy = vi.mocked(resolveTarget.resolveOrgOptionalFromArg);

/**
 * Serve `data` the way Sentry's attributes endpoint does: one type per
 * request, offset cursors, and the look-ahead row (perPage + 1) left in.
 */
function mockAttributes(data: Attr[]) {
  listSpy.mockImplementation(async (_org, options) => {
    const ofType = data.filter((a) =>
      options.attributeTypes?.includes(a.attributeType),
    );
    const offset = Number(options.cursor?.split(":")[1] ?? 0);
    const perPage = options.perPage ?? 100;
    const rows = ofType.slice(offset, offset + perPage + 1);
    return rows.length > perPage
      ? { data: rows, nextCursor: `0:${offset + perPage}:0` }
      : { data: rows };
  });
}

afterEach(() => {
  listSpy.mockReset();
  resolveSpy.mockReset();
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

describe("parseAttributeFilter", () => {
  test("keeps has: terms (deduplicated, typed keys intact) as the query and free text as the name", () => {
    expect(
      parseAttributeFilter(
        " has:gen_ai.request.model gen_ai has:tags[cart.total,number] has:gen_ai.request.model ",
      ),
    ).toEqual({
      query: "has:gen_ai.request.model has:tags[cart.total,number]",
      name: "gen_ai",
    });
    expect(parseAttributeFilter("http")).toEqual({ name: "http" });
  });

  test("returns nothing without a filter", () => {
    expect(parseAttributeFilter(undefined)).toEqual({});
    expect(parseAttributeFilter("  ")).toEqual({});
  });

  test("rejects values, negation, OR, and an empty has:", () => {
    for (const bad of [
      "span.op:db",
      "!has:http.method",
      "has:a OR has:b",
      "has:",
    ]) {
      expect(() => parseAttributeFilter(bad)).toThrow(ValidationError);
    }
  });

  test("rejects globs, since Sentry matches the text literally", () => {
    expect(() => parseAttributeFilter("gen_ai.*")).toThrow(
      /Globs aren't supported/,
    );
  });

  test("rejects more than one search term", () => {
    expect(() => parseAttributeFilter("gen_ai http")).toThrow(
      /single search term/,
    );
    expect(() => parseAttributeFilter("gen_ai has:x http")).toThrow(
      /single search term/,
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
    expect(tip).toContain("-q 'has:tags[cart.total,number]'");
    expect(tip).toContain("--fields 'tags[cart.total,number]'");
  });

  test("logs: suggests log list, with a <project> placeholder for org-wide listings", () => {
    const tip = buildUsageTip("logs", "my-org", undefined, [
      toAttributeListItem(HTTP_METHOD),
    ]);
    expectTipWithCommand(tip, "sentry log list my-org/<project>");
    expect(tip).toContain("-q 'has:http.method'");
    expect(tip).toContain("--fields 'http.method'");
  });

  test("metrics: points at explore", () => {
    expectTipWithCommand(
      buildUsageTip("tracemetrics", "my-org", undefined, items),
      "sentry explore my-org/ --dataset metrics -m <metric> -F 'tags[cart.total,number]'",
    );
  });

  test("returns nothing for an empty page", () => {
    expect(buildUsageTip("spans", "my-org", undefined, [])).toBeUndefined();
  });
});

describe("selectAcrossTypes", () => {
  // Server order (by usage), not by name
  const strings = {
    type: "string" as const,
    data: [attr("zeta"), attr("alpha"), attr("mid")],
  };
  const numbers = {
    type: "number" as const,
    data: [attr("beta", "number", "user")],
  };

  test("takes each type's rows in server order, then sorts for display", () => {
    // "alpha" sorts first but comes after "zeta" for its type, so it waits:
    // the rows shown of each type stay a prefix of what the server returned.
    expect(selectAcrossTypes([strings, numbers], 2).map((a) => a.name)).toEqual(
      ["beta", "zeta"],
    );
    expect(selectAcrossTypes([strings, numbers], 10)).toHaveLength(4);
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
  test("lists span attributes for a project, 25 per page over 7d, sorted by name", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org", project: "backend" });
    mockAttributes(ATTRIBUTES);

    const output = await run({ json: true }, "my-org/backend");

    // One request per attribute type, each paginated on its own
    expect(listSpy).toHaveBeenCalledTimes(4);
    expect(listSpy).toHaveBeenCalledWith("my-org", {
      dataset: "spans",
      project: ["backend"],
      attributeTypes: ["string"],
      query: undefined,
      context: false,
      perPage: 25,
      cursor: undefined,
      statsPeriod: "7d",
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

  test("passes dataset, types, the has: filter, and limit through for an org-wide listing", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes([]);

    await run(
      {
        json: true,
        dataset: "logs",
        type: ["string,boolean"],
        period: parsePeriod("24h"),
        limit: 50,
      },
      "my-org/",
      "has:gen_ai.request.model has:http.method",
    );

    expect(listSpy).toHaveBeenCalledTimes(2);
    for (const type of ["boolean", "string"]) {
      expect(listSpy).toHaveBeenCalledWith("my-org", {
        dataset: "logs",
        project: undefined,
        attributeTypes: [type],
        query: "has:gen_ai.request.model has:http.method",
        context: false,
        perPage: 50,
        cursor: undefined,
        statsPeriod: "24h",
      });
    }
  });

  test("shows the exact key in the table, including typed tags[...] keys", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes(ATTRIBUTES);

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
    mockAttributes(ATTRIBUTES);

    const output = await run(
      { json: true, fields: ["name", "type"] },
      "my-org/",
    );

    expect(JSON.parse(output).data).toEqual([
      { name: "cart.total", type: "number" },
      { name: "http.method", type: "string" },
    ]);
  });

  test("renders a table and points at -c next with the same flags when the server has more", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes([HTTP_METHOD, attr("http.route"), attr("http.status")]);

    const output = await run(
      { dataset: "logs", type: ["string"], limit: 2 },
      "my-org/",
    );

    expect(output).toContain("TYPE");
    expect(output).toContain("SOURCE");
    expect(output).toContain("http.method");
    expect(output).toContain(
      "Showing 2 logs attributes in my-org/; more are available.",
    );
    expect(output).toContain(
      "Next: sentry attribute list my-org/ -c next --dataset logs --type string -n 2",
    );
  });

  test("drops the server's look-ahead row for a single type", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    // Sentry returns limit + 1 rows when more exist.
    mockAttributes([attr("a"), attr("b"), attr("c")]);

    const json = JSON.parse(
      await run({ json: true, limit: 2, type: ["string"] }, "my-org/"),
    );
    expect(json.data.map((a: { name: string }) => a.name)).toEqual(["a", "b"]);
    expect(json.hasMore).toBe(true);
  });

  test("trims across types to --limit, then -c next resumes the rows it cut", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    // Server order for strings is c, b: only c fits on the first page.
    mockAttributes([attr("c"), attr("a", "number", "user"), attr("b")]);

    const first = JSON.parse(await run({ json: true, limit: 2 }, "my-org/"));
    expect(first.data.map((a: { name: string }) => a.name)).toEqual(["a", "c"]);
    expect(first.hasMore).toBe(true);
    // Types sorted: array|boolean|number|string; only strings remain.
    expect(first.nextCursor).toBe("|||0:1:0");

    listSpy.mockClear();
    const second = JSON.parse(
      await run({ json: true, limit: 2, cursor: "next" }, "my-org/"),
    );
    expect(second.data.map((a: { name: string }) => a.name)).toEqual(["b"]);
    expect(second.hasMore).toBe(false);
    expect(second.hasPrev).toBe(true);
    // Exhausted types aren't requested again.
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ attributeTypes: ["string"], cursor: "0:1:0" }),
    );

    const back = JSON.parse(
      await run({ json: true, limit: 2, cursor: "prev" }, "my-org/"),
    );
    expect(back.data.map((a: { name: string }) => a.name)).toEqual(["a", "c"]);
  });

  test("-c next without a previous listing explains how to start", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes(ATTRIBUTES);

    await expect(run({ cursor: "next" }, "my-org/")).rejects.toThrow(
      ValidationError,
    );
  });

  test("prints a usage tip on its own line after the count", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org", project: "backend" });
    mockAttributes(ATTRIBUTES);

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
    mockAttributes([]);

    const output = await run({}, "my-org/");

    expect(output).toContain("No attributes found.");
  });

  test("--context requests metadata and includes it in JSON", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes([{ ...CART_TOTAL, context: {} }, CONTEXT_ATTRIBUTE]);

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
    mockAttributes(ATTRIBUTES);

    const output = await run({ json: true }, "my-org/");

    for (const item of JSON.parse(output).data) {
      expect(item).not.toHaveProperty("context");
    }
  });

  test("--context adds description and example columns to the table", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes([CONTEXT_ATTRIBUTE]);
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

  test("turns a Sentry query parse error into a filter validation error", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    listSpy.mockRejectedValue(
      new ApiError(
        "Failed to list spans attributes",
        400,
        "Error parsing search query: Expected one of: ...",
      ),
    );

    await expect(run({}, "my-org/", "has:bad]key")).rejects.toThrow(
      /Sentry rejected the filter "has:bad\]key"/,
    );
  });

  test("rejects a value filter before calling the API", async () => {
    await expect(run({}, "my-org/", "span.op:db")).rejects.toThrow(
      ValidationError,
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  test("sends the name term as substringMatch and has: terms as the query", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes([]);

    await run({ json: true }, "my-org/", "has:http.method gen_ai");

    expect(listSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({
        substringMatch: "gen_ai",
        query: "has:http.method",
      }),
    );
  });

  test("pages a filtered listing with -c next, repeating the filter in the hint", async () => {
    resolveSpy.mockResolvedValue({ org: "my-org" });
    mockAttributes([attr("gen_ai.a"), attr("gen_ai.b"), attr("gen_ai.c")]);

    const output = await run({ limit: 2 }, "my-org/", "gen_ai has:http.method");
    expect(output).toContain(
      "Next: sentry attribute list my-org/ 'gen_ai has:http.method' -c next -n 2",
    );

    const next = JSON.parse(
      await run(
        { json: true, limit: 2, cursor: "next" },
        "my-org/",
        "gen_ai has:http.method",
      ),
    );
    expect(next.data.map((a: { name: string }) => a.name)).toEqual([
      "gen_ai.c",
    ]);
  });

  test("rejects an invalid --type before calling the API", async () => {
    await expect(run({ type: ["text"] }, "my-org/")).rejects.toThrow(
      ValidationError,
    );
    expect(listSpy).not.toHaveBeenCalled();
  });
});
