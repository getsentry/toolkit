/**
 * Tests for the ID-arguments grammar (grammar/id-arguments.pegjs), through
 * src/lib/id-arguments.ts.
 *
 * The grammar does not know any kind of ID, so the same table runs for every
 * kind in `ID_KINDS`: the syntax cannot drift between commands.
 */

import { describe, expect, test } from "vitest";
import { ContextError, ValidationError } from "../../src/lib/errors.js";
import {
  ID_KINDS,
  type IdArgumentsOptions,
  type IdKind,
  parseIdArgument,
  parseIdArguments,
} from "../../src/lib/id-arguments.js";

const HEX = "aaaa1111bbbb2222cccc3333dddd4444";
const HEX2 = "bbbb2222cccc3333dddd4444eeee5555";
const SPAN = "aaaa1111bbbb2222";
const SPAN2 = "cccc3333dddd4444";
const HINT = "sentry thing view [<org>/<project>/]<id>";

/** An ID of each kind, and a second one */
const EXAMPLES: Record<keyof typeof ID_KINDS, readonly [string, string]> = {
  trace: [HEX, HEX2],
  replay: [HEX, HEX2],
  log: [HEX, HEX2],
  span: [SPAN, SPAN2],
};

const KINDS = Object.entries(ID_KINDS).map(
  ([name, kind]) =>
    [name, kind, ...EXAMPLES[name as keyof typeof ID_KINDS]] as const,
);

function parse(
  kind: IdKind,
  args: readonly string[],
  options: Partial<IdArgumentsOptions> = {},
) {
  return parseIdArguments(args, kind, { usageHint: HINT, ...options });
}

describe.each(KINDS)("%s IDs", (_name, kind, id, other) => {
  test.each([
    [[id], undefined],
    [[`/${id}`], undefined],
    [[`${id}//`], undefined],
    [[`acme/${id}`], "acme/"],
    [[`acme/web/${id}`], "acme/web"],
    [[`acme/web/${id}/`], "acme/web"],
    [["acme/web", id], "acme/web"],
    [["web", id], "web"],
    [["My Project", id], "My Project"],
    [["", id], undefined],
  ])("%j → target %j", (args, target) => {
    expect(parse(kind, args)).toEqual({ target, ids: [id], warnings: [] });
  });

  test("normalizes the ID and trims arguments", () => {
    expect(parse(kind, [` acme/${id.toUpperCase()}\n`])).toEqual({
      target: "acme/",
      ids: [id],
      warnings: [],
    });
  });

  test("reads reversed arguments, with a warning", () => {
    expect(parse(kind, [id, "acme/web"])).toEqual({
      target: "acme/web",
      ids: [id],
      warnings: [`Arguments appear reversed. Interpreting as: acme/web ${id}`],
    });
  });

  test("splits IDs off a target at spaces, and at line breaks", () => {
    const expected = { target: "acme/web", ids: [id, other], warnings: [] };
    const multiple = { multiple: true };
    expect(parse(kind, [`acme/web ${id} ${other}`], multiple)).toEqual(
      expected,
    );
    expect(parse(kind, ["acme/web", `${id}\n${other}\n`], multiple)).toEqual(
      expected,
    );
    // A display name keeps its spaces
    expect(parse(kind, [`My Project ${id}`])).toEqual({
      target: "My Project",
      ids: [id],
      warnings: [],
    });
  });

  test("more IDs may repeat the target", () => {
    expect(
      parse(kind, [`acme/web/${id}`, `acme/web/${other}`], { multiple: true }),
    ).toEqual({ target: "acme/web", ids: [id, other], warnings: [] });
    expect(
      parse(kind, ["acme/web", `acme/web/${other}`], { multiple: true }),
    ).toEqual({ target: "acme/web", ids: [other], warnings: [] });
  });

  test("IDs from different targets are an error", () => {
    expect(() =>
      parse(kind, [`acme/web/${id}`, `acme/api/${other}`], { multiple: true }),
    ).toThrow(ValidationError);
  });

  test("keeps one ID, ignoring the rest with a warning", () => {
    expect(parse(kind, ["web", "extra", id])).toEqual({
      target: "web",
      ids: [id],
      warnings: [`Extra arguments ignored: extra. Expected: ${HINT}`],
    });
    expect(parse(kind, [`acme/web/${id}`, other])).toEqual({
      target: "acme/web",
      ids: [id],
      warnings: [`Extra arguments ignored: ${other}. Expected: ${HINT}`],
    });
  });

  test.each([[[]], [[""]], [["acme/web"]], [["acme/web/"]], [["/"]]])(
    "%j → missing ID",
    (args) => {
      expect(() => parse(kind, args)).toThrow(ContextError);
    },
  );

  test.each([[[`acme//${id}`]], [[`/web/${id}`]]])(
    "%j → empty org or project",
    (args) => {
      expect(() => parse(kind, args)).toThrow(ValidationError);
    },
  );

  test.each([
    [["not-hex"], undefined],
    [["acme/web/not-hex"], "acme/web"],
    [["acme/web", "not-hex"], "acme/web"],
    [["not-hex", "acme/web"], "acme/web"],
  ])("%j → invalid ID, or raw ID and target %j", (args, target) => {
    expect(() => parse(kind, args)).toThrow(ValidationError);
    expect(parse(kind, args, { validate: false })).toMatchObject({
      target,
      ids: ["not-hex"],
    });
  });

  test.each([
    [`acme/${id.slice(0, 12)}`, id.slice(0, 12)],
    [
      `acme/${id.slice(0, 8)}...${id.slice(-8)}`,
      `${id.slice(0, 8)}...${id.slice(-8)}`,
    ],
    [`acme/${id}xyz`, `${id}xyz`],
  ])("%j → invalid ID, or raw ID %j after the org", (arg, raw) => {
    expect(() => parse(kind, [arg])).toThrow(ValidationError);
    expect(parse(kind, [arg], { validate: false })).toEqual({
      target: "acme/",
      ids: [raw],
      warnings: [],
    });
  });

  test.each([["acme/abc123"], ["acme/deadbeef-app"], ["acme/null"]])(
    "%j does not look like an ID → missing ID",
    (arg) => {
      expect(() => parse(kind, [arg])).toThrow(ContextError);
    },
  );

  test("a command that needs a project reads `<x>/<id>` as the project", () => {
    expect(parse(kind, [`web/${id}`], { needsProject: true })).toEqual({
      target: "web",
      ids: [id],
      warnings: [],
    });
  });

  describe("optional IDs", () => {
    const optional = { optional: true };

    test.each([
      [[], undefined],
      [["web"], "web"],
      [["acme/"], "acme/"],
      [["acme/web"], "acme/web"],
      [["acme/web/"], "acme/web/"],
      [[`acme/${id.slice(0, 12)}`], `acme/${id.slice(0, 12)}`],
    ])("%j → target %j, no ID", (args, target) => {
      expect(parse(kind, args, optional)).toEqual({
        target,
        ids: [],
        warnings: [],
      });
    });

    test.each([
      [[id], undefined],
      [[`acme/${id}`], "acme/"],
      [["acme/web", id], "acme/web"],
    ])("%j → target %j and the ID", (args, target) => {
      expect(parse(kind, args, optional)).toEqual({
        target,
        ids: [id],
        warnings: [],
      });
    });

    test("an argument after the target is an ID", () => {
      expect(() => parse(kind, ["web", "not-hex"], optional)).toThrow(
        ValidationError,
      );
    });
  });
});

describe("parseIdArgument", () => {
  test("returns the one ID", () => {
    expect(
      parseIdArgument(["acme/web", HEX], ID_KINDS.trace, { usageHint: HINT }),
    ).toEqual({ target: "acme/web", id: HEX, warnings: [] });
  });
});

describe("URLs", () => {
  const traceUrl = `https://acme.sentry.io/explore/traces/trace/${HEX}/`;
  const replayUrl = `https://sentry.io/organizations/acme/explore/replays/${HEX}/`;

  test("a URL with the command's kind of ID names the ID and its org", () => {
    expect(parse(ID_KINDS.trace, [traceUrl])).toEqual({
      target: "acme/",
      ids: [HEX],
      baseUrl: "https://acme.sentry.io",
      warnings: [],
    });
    expect(parse(ID_KINDS.replay, [replayUrl])).toEqual({
      target: "acme/",
      ids: [HEX],
      baseUrl: "https://sentry.io",
      warnings: [],
    });
  });

  test("a URL without one is missing the ID, with an example URL", () => {
    try {
      parse(ID_KINDS.replay, [traceUrl]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain(
        "Pass a replay URL: https://sentry.io/organizations/{org}/explore/replays/{replayId}/",
      );
    }
  });

  test("a URL with no ID of any kind is a target when IDs are optional", () => {
    const projectUrl = "https://sentry.io/organizations/acme/projects/web/";
    expect(parse(ID_KINDS.trace, [projectUrl], { optional: true })).toEqual({
      target: projectUrl,
      ids: [],
      warnings: [],
    });
  });
});

describe("tokens", () => {
  test("rejects NUL", () => {
    expect(() => parse(ID_KINDS.trace, [`a\0b`])).toThrow(ValidationError);
  });

  test("a span ID's trace is its target", () => {
    expect(
      parse(ID_KINDS.span, [`acme/web/${HEX}/${SPAN}`, SPAN2], {
        multiple: true,
      }),
    ).toEqual({ target: `acme/web/${HEX}`, ids: [SPAN, SPAN2], warnings: [] });
    expect(
      parse(ID_KINDS.span, [`${HEX} ${SPAN}`], {
        multiple: true,
        optional: true,
      }),
    ).toEqual({ target: HEX, ids: [SPAN], warnings: [] });
  });
});
