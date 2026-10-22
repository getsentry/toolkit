/**
 * Unit tests for the SDK invoke layer.
 *
 * Focuses on `applyFlagDefaults` and `applyPositionalParsers`, which
 * replicate Stricli's default application and positional parsing for the SDK
 * direct-invoke path (bypasses Stricli parsing).
 */

import { describe, expect, test } from "vitest";
import {
  applyFlagDefaults,
  applyPositionalParsers,
  buildInvoker,
  type FlagDef,
  parseOutput,
} from "../../src/lib/sdk-invoke.js";
import { parseOrgProjectPositional } from "../../src/lib/arg-parsing.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("sdk-invoke-");

// ---------------------------------------------------------------------------
// applyFlagDefaults — parsed flags with defaults
// ---------------------------------------------------------------------------

describe("applyFlagDefaults: parsed flags with defaults", () => {
  test("calls parse on string default when flag is missing", () => {
    const flagDefs: Record<string, FlagDef> = {
      period: {
        kind: "parsed",
        default: "7d",
        parse: (v: string) => ({ type: "relative", period: v }),
      },
    };
    const result = applyFlagDefaults({}, flagDefs);
    expect(result.period).toEqual({ type: "relative", period: "7d" });
  });

  test("calls parse on string default when flag value is undefined", () => {
    const flagDefs: Record<string, FlagDef> = {
      period: {
        kind: "parsed",
        default: "90d",
        parse: (v: string) => ({ type: "relative", period: v }),
      },
    };
    const result = applyFlagDefaults({ period: undefined }, flagDefs);
    expect(result.period).toEqual({ type: "relative", period: "90d" });
  });

  test("preserves caller-provided value over default", () => {
    const flagDefs: Record<string, FlagDef> = {
      period: {
        kind: "parsed",
        default: "7d",
        parse: (v: string) => ({ type: "relative", period: v }),
      },
    };
    const callerValue = { type: "relative", period: "24h" };
    const result = applyFlagDefaults({ period: callerValue }, flagDefs);
    expect(result.period).toBe(callerValue);
  });

  test("handles parse function that returns a number", () => {
    const flagDefs: Record<string, FlagDef> = {
      limit: {
        kind: "parsed",
        default: "25",
        parse: (v: string) => Number(v),
      },
    };
    const result = applyFlagDefaults({}, flagDefs);
    expect(result.limit).toBe(25);
  });

  test("re-throws if parse function rejects its own default", () => {
    const flagDefs: Record<string, FlagDef> = {
      period: {
        kind: "parsed",
        default: "invalid",
        parse: () => {
          throw new Error("parse error");
        },
      },
    };
    expect(() => applyFlagDefaults({}, flagDefs)).toThrow("parse error");
  });
});

// ---------------------------------------------------------------------------
// applyFlagDefaults — boolean flags
// ---------------------------------------------------------------------------

describe("applyFlagDefaults: boolean flags", () => {
  test("applies raw boolean default", () => {
    const flagDefs: Record<string, FlagDef> = {
      json: { kind: "boolean", default: false },
      fresh: { kind: "boolean", default: false },
    };
    const result = applyFlagDefaults({}, flagDefs);
    expect(result.json).toBe(false);
    expect(result.fresh).toBe(false);
  });

  test("preserves caller-provided boolean over default", () => {
    const flagDefs: Record<string, FlagDef> = {
      fresh: { kind: "boolean", default: false },
    };
    const result = applyFlagDefaults({ fresh: true }, flagDefs);
    expect(result.fresh).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyFlagDefaults — enum flags
// ---------------------------------------------------------------------------

describe("applyFlagDefaults: enum flags", () => {
  test("applies raw enum default", () => {
    const flagDefs: Record<string, FlagDef> = {
      sort: { kind: "enum", default: "date" },
    };
    const result = applyFlagDefaults({}, flagDefs);
    expect(result.sort).toBe("date");
  });
});

// ---------------------------------------------------------------------------
// applyFlagDefaults — optional flags without defaults
// ---------------------------------------------------------------------------

describe("applyFlagDefaults: optional flags without defaults", () => {
  test("does not inject value for optional flag with no default", () => {
    const flagDefs: Record<string, FlagDef> = {
      query: { kind: "parsed", optional: true },
    };
    const result = applyFlagDefaults({}, flagDefs);
    expect("query" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyFlagDefaults — strips undefined, preserves other falsy values
// ---------------------------------------------------------------------------

describe("applyFlagDefaults: undefined stripping", () => {
  test("strips undefined values from input flags", () => {
    const flagDefs: Record<string, FlagDef> = {};
    const result = applyFlagDefaults(
      { a: undefined, b: null, c: 0, d: "", e: false },
      flagDefs,
    );
    expect("a" in result).toBe(false);
    expect(result.b).toBeNull();
    expect(result.c).toBe(0);
    expect(result.d).toBe("");
    expect(result.e).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyFlagDefaults — multiple flags combined
// ---------------------------------------------------------------------------

describe("applyFlagDefaults: combined scenario", () => {
  test("applies defaults for missing flags while preserving provided ones", () => {
    const flagDefs: Record<string, FlagDef> = {
      period: {
        kind: "parsed",
        default: "7d",
        parse: (v: string) => ({ type: "relative", period: v }),
      },
      limit: {
        kind: "parsed",
        default: "25",
        parse: (v: string) => Number(v),
      },
      sort: { kind: "enum", default: "date" },
      fresh: { kind: "boolean", default: false },
      query: { kind: "parsed", optional: true },
    };
    const result = applyFlagDefaults({ limit: 50, query: undefined }, flagDefs);
    // period: default applied via parse
    expect(result.period).toEqual({ type: "relative", period: "7d" });
    // limit: caller value preserved
    expect(result.limit).toBe(50);
    // sort: default applied (raw)
    expect(result.sort).toBe("date");
    // fresh: default applied (raw)
    expect(result.fresh).toBe(false);
    // query: undefined stripped, no default → absent
    expect("query" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseOutput — binary vs textual capture
// ---------------------------------------------------------------------------

describe("parseOutput: binary output", () => {
  test("returns raw bytes when a chunk is a Uint8Array (no comma-decimal coercion)", () => {
    // PNG signature — a byte-for-byte round-trip is required so SDK/run()
    // callers downloading attachments get faithful data, not "137,80,78,71".
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = parseOutput<Uint8Array>(undefined, [png]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  test("concatenates mixed string and binary chunks as bytes", () => {
    const result = parseOutput<Uint8Array>(undefined, [
      "AB",
      new Uint8Array([0x00, 0xff]),
    ]);
    expect(Array.from(result)).toEqual([0x41, 0x42, 0x00, 0xff]);
  });

  test("still JSON-parses textual chunks", () => {
    const result = parseOutput<{ ok: boolean }>(undefined, ['{"ok":true}']);
    expect(result).toEqual({ ok: true });
  });

  test("prefers captured object over stdout chunks", () => {
    const obj = { id: 1 };
    expect(parseOutput(obj, ["ignored"])).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// applyPositionalParsers
// ---------------------------------------------------------------------------

describe("applyPositionalParsers", () => {
  test("runs tuple parsers by position", () => {
    const [target, name] = applyPositionalParsers(
      ["acme/web", "checkout"],
      {
        kind: "tuple",
        parameters: [{ parse: parseOrgProjectPositional }, { parse: String }],
      },
      {},
    );
    expect(target).toEqual(parseOrgProjectPositional("acme/web"));
    expect(name).toBe("checkout");
  });

  test("runs the array parser on every value", () => {
    const parsed = applyPositionalParsers(
      ["1", "2"],
      { kind: "array", parameter: { parse: Number } },
      {},
    );
    expect(parsed).toEqual([1, 2]);
  });

  test("passes the context as `this`, like Stricli", () => {
    const context = { name: "ctx" };
    const [seen] = applyPositionalParsers(
      ["x"],
      {
        kind: "tuple",
        parameters: [
          {
            parse(this: unknown) {
              return this;
            },
          },
        ],
      },
      context,
    );
    expect(seen).toBe(context);
  });

  test("leaves values without a parameter definition unchanged", () => {
    expect(applyPositionalParsers(["a"], undefined, {})).toEqual(["a"]);
    expect(
      applyPositionalParsers(["a", "b"], { kind: "tuple", parameters: [] }, {}),
    ).toEqual(["a", "b"]);
  });
});

describe("buildInvoker: positional parsing", () => {
  test("a command's target positional is parsed and validated", async () => {
    // Without positional parsing, project view would get the bare string
    // and silently fall back to auto-detection instead of rejecting it.
    const invoke = buildInvoker({ token: "sntrys_test" });
    await expect(
      invoke(["project", "view"], {}, ["@latest"]) as Promise<unknown>,
    ).rejects.toThrow("is an issue selector");
  });
});
