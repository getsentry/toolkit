/**
 * Tests for the ID-arguments grammar (grammar/id-arguments.pegjs), through
 * src/lib/id-arguments.ts.
 */

import { describe, expect, test } from "vitest";
import { ContextError, ValidationError } from "../../src/lib/errors.js";
import {
  parseIdArguments,
  parseTraceOrProjectArguments,
} from "../../src/lib/id-arguments.js";

const ID = "aaaa1111bbbb2222cccc3333dddd4444";
const HINT = "sentry trace view [<org>/<project>/]<trace-id>";
const CONTEXT = { idLabel: "Trace ID", usageHint: HINT };

function trace(...args: string[]) {
  return parseIdArguments(args, "trace", CONTEXT);
}

describe("trace", () => {
  test.each([
    [[ID], { type: "none" }],
    [[`/${ID}`], { type: "none" }],
    [[`${ID}//`], { type: "none" }],
    [[`acme/${ID}`], { type: "org", org: "acme" }],
    [[`acme/web/${ID}`], { type: "org-project", org: "acme", project: "web" }],
    [[`acme/web/${ID}/`], { type: "org-project", org: "acme", project: "web" }],
    [[`acme/a/b/${ID}`], { type: "org-project", org: "acme", project: "a/b" }],
    [["acme/web", ID], { type: "target", target: "acme/web" }],
    [["My Project", ID], { type: "target", target: "My Project" }],
  ])("%j → %j", (args, scope) => {
    expect(trace(...args)).toEqual({ id: ID, scope, warnings: [] });
  });

  test("trims arguments and normalizes the ID", () => {
    expect(trace(` acme/${ID.toUpperCase()}\n`)).toEqual({
      id: ID,
      scope: { type: "org", org: "acme" },
      warnings: [],
    });
  });

  test("a trace URL wins over the other arguments", () => {
    expect(
      trace(`https://acme.sentry.io/explore/traces/trace/${ID}/`, "extra"),
    ).toEqual({
      id: ID,
      scope: { type: "org", org: "acme" },
      baseUrl: "https://acme.sentry.io",
      warnings: [],
    });
  });

  test("a trace ID path is not a target for a second trace ID", () => {
    const other = "bbbb2222cccc3333dddd4444eeee5555";
    expect(trace(`acme/web/${ID}`, other)).toEqual({
      id: ID,
      scope: { type: "org-project", org: "acme", project: "web" },
      warnings: [`Extra arguments ignored: ${other}. Expected: ${HINT}`],
    });
  });

  test("warns about arguments after the trace ID", () => {
    expect(trace("acme/web", ID, "a", "b").warnings).toEqual([
      `Extra arguments ignored: a b. Expected: ${HINT}`,
    ]);
  });

  test.each([[[]], [["acme/web/"]], [["acme/"]], [["/"]]])(
    "%j → missing trace ID",
    (args) => {
      expect(() => trace(...args)).toThrow(ContextError);
    },
  );

  test.each([
    [[""]],
    [["not-hex"]],
    [["acme/not-hex"]],
    [["acme/web", "not-hex"]],
    [[`acme//${ID}`]],
    [[`/web/${ID}`]],
  ])("%j → invalid", (args) => {
    expect(() => trace(...args)).toThrow(ValidationError);
  });

  test("rejects NUL in an argument", () => {
    expect(() => trace(`acme\0web`, ID)).toThrow(ValidationError);
  });
});

describe("tracePath", () => {
  test("does not read URLs", () => {
    expect(() =>
      parseIdArguments(
        [`https://acme.sentry.io/explore/traces/trace/${ID}`],
        "tracePath",
        CONTEXT,
      ),
    ).not.toThrow();
    expect(
      parseIdArguments([`acme/web/${ID}`], "tracePath", CONTEXT).scope,
    ).toEqual({ type: "org-project", org: "acme", project: "web" });
  });
});

describe("traceOrProject", () => {
  const parse = (...args: string[]) => parseTraceOrProjectArguments(args, HINT);

  test.each([
    [[], undefined],
    [["acme/web"], "acme/web"],
    [["acme/"], "acme/"],
    [["web", "not-a-trace"], "web"],
  ])("%j → project mode", (args, target) => {
    expect(parse(...args)).toEqual({ mode: "project", target });
  });

  test("a trailing trace ID selects trace mode", () => {
    expect(parse("acme/web", ID)).toEqual({
      mode: "trace",
      trace: {
        id: ID,
        scope: { type: "target", target: "acme/web" },
        warnings: [],
      },
    });
  });

  test("the trace ID is the last argument, the target the first", () => {
    // The mode and the trace ID come from the same argument; a subcommand
    // name or stray word in between is ignored, not read as the trace ID
    expect(parse("acme/web", "view", ID)).toEqual({
      mode: "trace",
      trace: {
        id: ID,
        scope: { type: "target", target: "acme/web" },
        warnings: [`Extra arguments ignored: view. Expected: ${HINT}`],
      },
    });
  });

  test("a trace ID path selects trace mode", () => {
    expect(parse(`acme/${ID}/`)).toMatchObject({
      mode: "trace",
      trace: { id: ID, scope: { type: "org", org: "acme" } },
    });
    expect(parse(`acme/web/${ID}`, "extra")).toMatchObject({
      mode: "trace",
      trace: {
        scope: { type: "org-project", org: "acme", project: "web" },
        warnings: [`Extra arguments ignored: extra. Expected: ${HINT}`],
      },
    });
  });

  test("a trace ID path wins over a trailing trace ID", () => {
    const other = "bbbb2222cccc3333dddd4444eeee5555";
    expect(parse(`acme/${ID}`, other)).toEqual({
      mode: "trace",
      trace: {
        id: ID,
        scope: { type: "org", org: "acme" },
        warnings: [`Extra arguments ignored: ${other}. Expected: ${HINT}`],
      },
    });
  });

  test("a trace URL selects trace mode", () => {
    expect(
      parse(`https://sentry.io/organizations/acme/traces/${ID}/`),
    ).toMatchObject({
      mode: "trace",
      trace: { id: ID, scope: { type: "org", org: "acme" } },
    });
  });
});
