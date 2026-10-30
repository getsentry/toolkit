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

/** Kinds without names: a token that is no ID is a target */
type UnnamedKind = "trace" | "event" | "replay" | "log" | "span";

/** An ID of each kind without names, and a second one */
const EXAMPLES: Record<UnnamedKind, readonly [string, string]> = {
  trace: [HEX, HEX2],
  event: [HEX, HEX2],
  replay: [HEX, HEX2],
  log: [HEX, HEX2],
  span: [SPAN, SPAN2],
};

const KINDS = (Object.keys(EXAMPLES) as UnnamedKind[]).map(
  (name) => [name, ID_KINDS[name] as IdKind, ...EXAMPLES[name]] as const,
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

  test("reads more IDs after reversed arguments", () => {
    expect(parse(kind, [id, "acme/web", other], { multiple: true })).toEqual({
      target: "acme/web",
      ids: [id, other],
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
    [["abc123"], undefined],
    [["acme/web/abc123"], "acme/web"],
    [["acme/web", "abc123"], "acme/web"],
    [["abc123", "acme/web"], "acme/web"],
  ])("%j → invalid ID, or raw ID and target %j", (args, target) => {
    expect(() => parse(kind, args)).toThrow(ValidationError);
    expect(parse(kind, args, { validate: false })).toMatchObject({
      target,
      ids: ["abc123"],
    });
  });

  test.each([
    [["login"]],
    [["login error"]],
    [["acme/web", "checkout"]],
    [["acme/web/checkout"]],
  ])("%j → not an ID, with a hint to search, if there is one", (args) => {
    if (!kind.search) {
      // `event list` lists an issue's events: there is no search to hint
      expect(() => parse(kind, args)).toThrow(/^Invalid /);
      return;
    }
    const label = kind.label.charAt(0).toLowerCase() + kind.label.slice(1);
    const text = args.at(-1)?.split("/").at(-1) ?? "";
    expect(() => parse(kind, args)).toThrow(
      `Not a ${label}: "${text}". To search, try \`${kind.search?.command} --query '${text}'\`.`,
    );
    // Unvalidated, it stays raw for the command to recover, then validate
    expect(parse(kind, args, { validate: false }).ids).toEqual([text]);
    expect(() => kind.validate(text)).toThrow(/^Not a .* To search, try/);
  });

  test.each([["--h"], ["<trace-id>"], ["{traceId}"], ["abc-123"]])(
    "%j is no search text: the ID's own error explains it",
    (arg) => {
      expect(() => parse(kind, [arg])).toThrow(/^Invalid /);
    },
  );

  test.each([
    [`acme/${id.slice(0, 12)}`, id.slice(0, 12)],
    [
      `acme/${id.slice(0, 8)}...${id.slice(-8)}`,
      `${id.slice(0, 8)}...${id.slice(-8)}`,
    ],
    [`acme/${id}xyz`, `${id}xyz`],
    // A URL fragment prefix, as in `#span-<id>`
    [`acme/trace-${id}`, `trace-${id}`],
    [`acme/span-${id.slice(0, 12)}`, `span-${id.slice(0, 12)}`],
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
    const eventUrl = `https://sentry.io/organizations/acme/issues/1/events/${HEX}/`;
    expect(parse(ID_KINDS.event, [eventUrl])).toEqual({
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

describe("kinds with names", () => {
  const dashboard = ID_KINDS.dashboard;
  const issue = ID_KINDS.issue;

  test.each([
    [["42"], { ids: ["42"] }],
    [["acme/42"], { target: "acme/", ids: ["42"] }],
    [["acme/web/42"], { target: "acme/web", ids: ["42"] }],
    [["My Dashboard"], { ids: [], name: "My Dashboard" }],
    // A name is never split at spaces, even before a number
    [["Top 10"], { ids: [], name: "Top 10" }],
    // Slashes stay in a name unless slugs come before an ID
    [["Latency/p95"], { ids: [], name: "Latency/p95" }],
    [["Errors.v2/123"], { ids: [], name: "Errors.v2/123" }],
    [["acme/"], { ids: [], name: "acme/" }],
  ])("%j → %j", (args, expected) => {
    expect(parse(dashboard, args)).toEqual({ warnings: [], ...expected });
  });

  test("a name takes every argument after the target", () => {
    expect(
      parse(dashboard, ["acme/", "API", "Latency", "by", "Region"]),
    ).toEqual({
      target: "acme/",
      ids: [],
      name: "API Latency by Region",
      warnings: [],
    });
    expect(
      parse(dashboard, ["acme/web", "Latency/p95", "by", "Region"]),
    ).toEqual({
      target: "acme/web",
      ids: [],
      name: "Latency/p95 by Region",
      warnings: [],
    });
  });

  test("an ID after the target keeps the rest as extra", () => {
    expect(parse(dashboard, ["acme/", "123", "extra"])).toEqual({
      target: "acme/",
      ids: ["123"],
      warnings: [`Extra arguments ignored: extra. Expected: ${HINT}`],
    });
  });

  test("a bare word before a name may be the name's first word", () => {
    // An org-scoped kind reads the bare word as an org
    expect(parse(dashboard, ["My", "Dashboard"])).toEqual({
      target: "My/",
      ids: [],
      name: "Dashboard",
      nameWithTarget: "My Dashboard",
      warnings: [],
    });
    expect(parse(dashboard, ["acme/", "Dashboard"]).nameWithTarget).toBe(
      undefined,
    );
  });

  test("a URL with no ID is a target before a name", () => {
    expect(
      parse(dashboard, ["https://acme.sentry.io/", "Backend", "Performance"]),
    ).toMatchObject({
      target: "https://acme.sentry.io/",
      ids: [],
      name: "Backend Performance",
    });
  });

  test("a URL with an ID names it", () => {
    expect(parse(dashboard, ["https://acme.sentry.io/dashboard/7/"])).toEqual({
      target: "acme/",
      ids: ["7"],
      baseUrl: "https://acme.sentry.io",
      warnings: [],
    });
  });

  test("an ID with its own syntax is a whole token", () => {
    for (const id of ["acme/cli-G", "acme/cli/G", "cli#CLI-G", "@latest"]) {
      expect(parse(issue, [id])).toEqual({ ids: [id], warnings: [] });
    }
  });

  test("a name is what cannot be an ID", () => {
    expect(parse(issue, ["login timeout"])).toEqual({
      ids: [],
      name: "login timeout",
      warnings: [],
    });
    // No space: a malformed identifier, which the kind rejects
    expect(parse(issue, ["acme/"], { validate: false })).toEqual({
      ids: ["acme/"],
      warnings: [],
    });
    expect(() => parse(issue, ["acme/"])).toThrow(ValidationError);
  });

  test("a kind with names has no search hint", () => {
    expect("search" in dashboard || "search" in issue).toBe(false);
  });
});

describe("org-scoped kinds without hex IDs", () => {
  const { conversation, integration } = ID_KINDS;

  test("any word may be a conversation ID; a bad one is rejected", () => {
    expect(parse(conversation, ["acme/conv_01H"])).toEqual({
      target: "acme/",
      ids: ["conv_01H"],
      warnings: [],
    });
    // Every word reads as an ID; the command picks out the org
    expect(parse(conversation, ["acme", "conv-1"], { multiple: true })).toEqual(
      { ids: ["acme", "conv-1"], warnings: [] },
    );
    for (const bad of ["conv?x=1", "acme/conv#a", "acme/conv%20"]) {
      expect(() => parse(conversation, [bad])).toThrow(ValidationError);
    }
  });

  test("integration IDs are numeric", () => {
    expect(parse(integration, ["acme", "42"])).toEqual({
      target: "acme/",
      ids: ["42"],
      warnings: [],
    });
    expect(() => parse(integration, ["acme/github"])).toThrow(
      "Use the numeric ID from 'sentry integration list'",
    );
    expect(() => parse(integration, ["acme/"])).toThrow(ContextError);
  });
});
