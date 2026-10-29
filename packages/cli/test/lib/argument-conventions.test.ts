/**
 * Argument conventions across commands.
 *
 * `id-arguments.test.ts` checks the shared grammar for each kind of ID. This
 * file checks the commands built on it: the same input goes through each
 * command's own positional, as Stricli parses it, and every command must
 * read it the same way. Where a command legitimately differs, its row in
 * {@link ID_COMMANDS} says how, so a difference is a decision, not drift.
 */

import { ArgumentParseError } from "@stricli/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand as dashboardCreateCommand } from "../../src/commands/dashboard/create.js";
import { listCommand as dashboardListCommand } from "../../src/commands/dashboard/list.js";
import { restoreCommand as dashboardRestoreCommand } from "../../src/commands/dashboard/restore.js";
import { revisionsCommand as dashboardRevisionsCommand } from "../../src/commands/dashboard/revisions.js";
import { viewCommand as dashboardViewCommand } from "../../src/commands/dashboard/view.js";
import { addCommand as widgetAddCommand } from "../../src/commands/dashboard/widget/add.js";
import { deleteCommand as widgetDeleteCommand } from "../../src/commands/dashboard/widget/delete.js";
import { editCommand as widgetEditCommand } from "../../src/commands/dashboard/widget/edit.js";
import { listCommand as eventListCommand } from "../../src/commands/event/list.js";
import { viewCommand as eventViewCommand } from "../../src/commands/event/view.js";
import { resolveCommand as feedbackResolveCommand } from "../../src/commands/feedback/resolve.js";
import { spamCommand as feedbackSpamCommand } from "../../src/commands/feedback/spam.js";
import { unresolveCommand as feedbackUnresolveCommand } from "../../src/commands/feedback/unresolve.js";
import { viewCommand as feedbackViewCommand } from "../../src/commands/feedback/view.js";
import { initCommand } from "../../src/commands/init.js";
import { archiveCommand } from "../../src/commands/issue/archive.js";
import { eventsCommand as issueEventsCommand } from "../../src/commands/issue/events.js";
import { linkCommand as issueLinkCommand } from "../../src/commands/issue/link.js";
import { planCommand as issuePlanCommand } from "../../src/commands/issue/plan.js";
import { resolveCommand as issueResolveCommand } from "../../src/commands/issue/resolve.js";
import { tagsCommand as issueTagsCommand } from "../../src/commands/issue/tags.js";
import { unlinkCommand as issueUnlinkCommand } from "../../src/commands/issue/unlink.js";
import { unresolveCommand as issueUnresolveCommand } from "../../src/commands/issue/unresolve.js";
import { listCommand as logListCommand } from "../../src/commands/log/list.js";
import { viewCommand as logViewCommand } from "../../src/commands/log/view.js";
import { createCommand as projectCreateCommand } from "../../src/commands/project/create.js";
import { archiveCommand as releaseArchiveCommand } from "../../src/commands/release/archive.js";
import { createCommand as releaseCreateCommand } from "../../src/commands/release/create.js";
import { deleteCommand as releaseDeleteCommand } from "../../src/commands/release/delete.js";
import { deployCommand as releaseDeployCommand } from "../../src/commands/release/deploy.js";
import { deploysCommand as releaseDeploysCommand } from "../../src/commands/release/deploys.js";
import { finalizeCommand as releaseFinalizeCommand } from "../../src/commands/release/finalize.js";
import { restoreCommand as releaseRestoreCommand } from "../../src/commands/release/restore.js";
import { setCommitsCommand as releaseSetCommitsCommand } from "../../src/commands/release/set-commits.js";
import { viewCommand as releaseViewCommand } from "../../src/commands/release/view.js";
import { downloadCommand as replayDownloadCommand } from "../../src/commands/replay/download.js";
import { viewCommand as replayViewCommand } from "../../src/commands/replay/view.js";
import { listCommand as spanListCommand } from "../../src/commands/span/list.js";
import { viewCommand as spanViewCommand } from "../../src/commands/span/view.js";
import { logsCommand as traceLogsCommand } from "../../src/commands/trace/logs.js";
import { viewCommand as traceViewCommand } from "../../src/commands/trace/view.js";
import { ContextError } from "../../src/lib/errors.js";
import {
  applyBoundPositionals,
  BoundPositional,
} from "../../src/lib/positional-parse.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as sentryUrlParser from "../../src/lib/sentry-url-parser.js";

const ID = "aaaa1111bbbb2222cccc3333dddd4444";
const ID2 = "bbbb2222cccc3333dddd4444eeee5555";
const SPAN_ID = "aaaa1111bbbb2222";
const SERVER = "https://sentry.example.com";
const TRACE_URL = `${SERVER}/organizations/acme/explore/traces/trace/${ID}/`;
const REPLAY_URL = `${SERVER}/organizations/acme/explore/replays/${ID}/`;
const EVENT_URL = `${SERVER}/organizations/acme/issues/123/events/${ID}/`;

const REVERSED = /^Arguments appear reversed/;
const EXTRA = /^Extra arguments ignored/;

/** How a command read its arguments, the same way for every command. */
type Reading = {
  /**
   * `auto`, `org:<org>`, `project:<project>` (found in any org), or
   * `<org>/<project>`
   */
  readonly target: string;
  readonly ids: readonly string[];
  readonly warnings: readonly string[];
  readonly baseUrl?: string;
};

/** A parsed `[<org>/][<project>]` target, as the parsers return it. */
type ParsedTarget = {
  readonly type: string;
  readonly org?: string;
  readonly project?: string;
  readonly projectSlug?: string;
};

/** A parsed trace target, from `parseTraceArgumentsInput` and friends. */
type TraceInput = {
  readonly parsed: ParsedTarget & { readonly traceId: string };
  readonly warnings: readonly string[];
  readonly baseUrl?: string;
};

/** A `log list` or `span list` parse: a project's items, or a trace's. */
type DualInput =
  | { readonly mode: "trace"; readonly trace: TraceInput }
  | { readonly mode: "project"; readonly target: ParsedTarget };

function describeTarget(target: ParsedTarget): string {
  switch (target.type) {
    case "auto-detect":
      return "auto";
    case "explicit":
      return `${target.org}/${target.project}`;
    case "project-search":
      return `project:${target.projectSlug}`;
    default:
      return `org:${target.org}`;
  }
}

function readTrace(input: TraceInput, extraIds: readonly string[] = []) {
  return {
    target: describeTarget(input.parsed),
    ids: [input.parsed.traceId, ...extraIds],
    warnings: input.warnings,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  };
}

function readDual(input: DualInput): Reading {
  return input.mode === "trace"
    ? readTrace(input.trace)
    : { target: describeTarget(input.target), ids: [], warnings: [] };
}

function readReplay(input: {
  readonly replayId: string;
  readonly target: ParsedTarget;
  readonly warnings: readonly string[];
  readonly baseUrl?: string;
}): Reading {
  return {
    target: describeTarget(input.target),
    ids: [input.replayId],
    warnings: input.warnings,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  };
}

/** A command that takes `[<org>/[<project>/]]<id>`, and how it differs. */
type IdCommand = {
  readonly name: string;
  readonly command: unknown;
  readonly read: (parsed: unknown) => Reading;
  /**
   * What `<x>/<id>` names: org `<x>`, or project `<x>` for commands that
   * need a project
   */
  readonly slashTarget: "org" | "project";
  /** Whether more IDs are taken, not ignored with a warning */
  readonly multiple: boolean;
  /** Whether the ID may be left out, to list a project's items instead */
  readonly optional: boolean;
  /** A Sentry URL with this command's ID, if the command takes one */
  readonly url?: string;
  /** Arguments every input gets after the ID, such as `span view`'s span ID */
  readonly trailing?: readonly string[];
  /**
   * Whether `<org>/<project> <id>` works. `span view` reads its first
   * argument as the trace, so the target must be joined to it
   */
  readonly separateTarget: boolean;
};

const ID_COMMANDS: readonly IdCommand[] = [
  {
    name: "trace view",
    command: traceViewCommand,
    read: (parsed) => readTrace((parsed as { trace: TraceInput }).trace),
    slashTarget: "org",
    multiple: false,
    optional: false,
    url: TRACE_URL,
    separateTarget: true,
  },
  {
    name: "trace logs",
    command: traceLogsCommand,
    read: (parsed) => readTrace(parsed as TraceInput),
    slashTarget: "org",
    multiple: false,
    optional: false,
    url: TRACE_URL,
    separateTarget: true,
  },
  {
    name: "span view",
    command: spanViewCommand,
    read: (parsed) => {
      const input = parsed as {
        trace: TraceInput;
        rawSpanIds: readonly string[];
      };
      return readTrace(input.trace, input.rawSpanIds);
    },
    slashTarget: "project",
    multiple: true,
    optional: false,
    url: TRACE_URL,
    trailing: [SPAN_ID],
    separateTarget: false,
  },
  {
    name: "span list",
    command: spanListCommand,
    read: (parsed) => readDual(parsed as DualInput),
    slashTarget: "project",
    multiple: false,
    optional: true,
    url: TRACE_URL,
    separateTarget: true,
  },
  {
    name: "log list",
    command: logListCommand,
    read: (parsed) => readDual(parsed as DualInput),
    slashTarget: "org",
    multiple: false,
    optional: true,
    url: TRACE_URL,
    separateTarget: true,
  },
  {
    name: "log view",
    command: logViewCommand,
    read: (parsed) => {
      const input = parsed as {
        rawLogIds: readonly string[];
        warnings: readonly string[];
        target: { parsed: ParsedTarget; baseUrl?: string };
      };
      return {
        target: describeTarget(input.target.parsed),
        ids: input.rawLogIds,
        warnings: input.warnings,
        ...(input.target.baseUrl ? { baseUrl: input.target.baseUrl } : {}),
      };
    },
    slashTarget: "project",
    multiple: true,
    optional: false,
    // Logs have no URL of their own
    separateTarget: true,
  },
  {
    name: "event view",
    command: eventViewCommand,
    read: (parsed) => {
      const input = parsed as {
        eventId: string;
        target: ParsedTarget;
        extraEventIds?: readonly string[];
        warnings: readonly string[];
        baseUrl?: string;
      };
      return {
        target: describeTarget(input.target),
        ids: [input.eventId, ...(input.extraEventIds ?? [])],
        warnings: input.warnings,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      };
    },
    slashTarget: "project",
    multiple: true,
    optional: false,
    url: EVENT_URL,
    separateTarget: true,
  },
  {
    name: "replay view",
    command: replayViewCommand,
    read: (parsed) => readReplay(parsed as Parameters<typeof readReplay>[0]),
    slashTarget: "org",
    multiple: false,
    optional: false,
    url: REPLAY_URL,
    separateTarget: true,
  },
  {
    name: "replay download",
    command: replayDownloadCommand,
    read: (parsed) => readReplay(parsed as Parameters<typeof readReplay>[0]),
    slashTarget: "org",
    multiple: false,
    optional: false,
    url: REPLAY_URL,
    separateTarget: true,
  },
];

/** Context Stricli passes to the parsers and resolvers. */
const CONTEXT = { cwd: "/tmp", commandPrefix: ["sentry"] };

function positionalOf(command: unknown): unknown {
  return (command as { parameters: { positional: unknown } }).parameters
    .positional;
}

/** Parse `args` with the command's positional, as Stricli would. */
function bind(command: unknown, args: readonly string[]): unknown[] {
  return applyBoundPositionals(args, positionalOf(command), CONTEXT);
}

function parseWith(entry: IdCommand, args: readonly string[]): Reading {
  const [bound] = bind(entry.command, [...args, ...(entry.trailing ?? [])]);
  expect(bound).toBeInstanceOf(BoundPositional);
  return entry.read((bound as BoundPositional<unknown, unknown>).parsed);
}

function parseError(command: unknown, args: readonly string[]): unknown {
  try {
    bind(command, args);
  } catch (error) {
    return error;
  }
  throw new Error(`Expected ${args.join(" ")} to fail to parse`);
}

/** The IDs a command reads for `ids`, plus its trailing arguments. */
function idsOf(entry: IdCommand, ...ids: string[]): string[] {
  return [...ids, ...(entry.trailing ?? [])];
}

/** Thrown by the stubbed `applySentryUrlContext`, to stop resolving there. */
class UrlApplied extends Error {}

let applyUrl: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  applyUrl = vi
    .spyOn(sentryUrlParser, "applySentryUrlContext")
    .mockImplementation(() => {
      throw new UrlApplied();
    });
  return () => applyUrl.mockRestore();
});

describe.each(ID_COMMANDS)("$name", (entry) => {
  test("a bare ID auto-detects the target", () => {
    expect(parseWith(entry, [ID])).toEqual({
      target: "auto",
      ids: idsOf(entry, ID),
      warnings: [],
    });
  });

  test("<x>/<id> names the org, or the project when one is needed", () => {
    expect(parseWith(entry, [`my-org/${ID}`]).target).toBe(
      entry.slashTarget === "org" ? "org:my-org" : "project:my-org",
    );
  });

  test("<org>/<project>/<id> names both", () => {
    expect(parseWith(entry, [`my-org/web/${ID}`])).toEqual({
      target: "my-org/web",
      ids: idsOf(entry, ID),
      warnings: [],
    });
  });

  test.runIf(entry.separateTarget)(
    "<org>/<project> <id> reads the same as <org>/<project>/<id>",
    () => {
      expect(parseWith(entry, ["my-org/web", ID])).toEqual(
        parseWith(entry, [`my-org/web/${ID}`]),
      );
    },
  );

  test.runIf(!entry.separateTarget)(
    "<org>/<project> <id> is not a target: the first argument is the ID",
    () => {
      const error = parseError(entry.command, ["my-org/web", ID, SPAN_ID]);
      expect(error).toBeInstanceOf(ArgumentParseError);
      expect((error as ArgumentParseError).exception).toBeInstanceOf(
        ContextError,
      );
    },
  );

  test.runIf(entry.separateTarget)(
    "reversed arguments are swapped back, with a warning",
    () => {
      const reading = parseWith(entry, [ID, "my-org/web"]);
      expect(reading.target).toBe("my-org/web");
      expect(reading.ids).toEqual(idsOf(entry, ID));
      expect(reading.warnings).toEqual([expect.stringMatching(REVERSED)]);
    },
  );

  test(
    entry.multiple
      ? "takes more than one ID"
      : "ignores extra arguments, with a warning",
    () => {
      const reading = parseWith(entry, [ID, ID2]);
      if (entry.multiple) {
        expect(reading.ids).toEqual([ID, ID2, ...(entry.trailing ?? [])]);
        expect(reading.warnings).toEqual([]);
      } else {
        expect(reading.ids).toEqual([ID]);
        expect(reading.warnings).toEqual([expect.stringMatching(EXTRA)]);
      }
    },
  );

  test(
    entry.optional
      ? "no ID lists the auto-detected project's items"
      : "a missing ID fails to parse, before the command runs",
    () => {
      if (entry.optional) {
        expect(parseWith({ ...entry, trailing: [] }, [])).toEqual({
          target: "auto",
          ids: [],
          warnings: [],
        });
        return;
      }
      const error = parseError(entry.command, []);
      expect(error).toBeInstanceOf(ArgumentParseError);
      expect((error as ArgumentParseError).exception).toBeInstanceOf(
        ContextError,
      );
    },
  );

  test.runIf(entry.url !== undefined)(
    "a pasted URL names the org; its server is applied on resolve, not parse",
    async () => {
      const url = entry.url ?? "";
      const [bound] = bind(entry.command, [url, ...(entry.trailing ?? [])]);
      const reading = entry.read(
        (bound as BoundPositional<unknown, unknown>).parsed,
      );
      expect(reading).toMatchObject({
        target: "org:acme",
        ids: idsOf(entry, ID),
        baseUrl: SERVER,
      });
      expect(applyUrl).not.toHaveBeenCalled();

      await expect(
        (bound as BoundPositional<unknown, unknown>).resolved,
      ).rejects.toBeInstanceOf(UrlApplied);
      expect(applyUrl).toHaveBeenCalledWith(SERVER);
    },
  );

  test.runIf(entry.url === undefined)(
    "a pasted URL without this kind of ID fails to parse",
    () => {
      const error = parseError(entry.command, [TRACE_URL]);
      expect(error).toBeInstanceOf(ArgumentParseError);
    },
  );
});

/** Commands that take one issue, through `issuePositional` or alike. */
const ISSUE_COMMANDS: readonly (readonly [string, unknown])[] = [
  ["issue resolve", issueResolveCommand],
  ["issue unresolve", issueUnresolveCommand],
  ["issue archive", archiveCommand],
  ["issue events", issueEventsCommand],
  ["issue plan", issuePlanCommand],
  ["issue tags", issueTagsCommand],
  ["issue link", issueLinkCommand],
  ["issue unlink", issueUnlinkCommand],
  ["event list", eventListCommand],
  ["feedback view", feedbackViewCommand],
  ["feedback resolve", feedbackResolveCommand],
  ["feedback spam", feedbackSpamCommand],
  ["feedback unresolve", feedbackUnresolveCommand],
];

const ISSUE_INPUTS = [
  "CLI-K9",
  "my-org/CLI-K9",
  "my-org/web/CLI-K9",
  "123456",
  "my-org/123456",
  "@latest",
  "my-org/@most_frequent",
  `${SERVER}/organizations/acme/issues/123456/`,
  // Text with spaces cannot be an identifier: it is a search
  "login timeout",
];

/** The issue argument a command parsed, from its first positional. */
function parseIssue(command: unknown, input: string) {
  const [bound] = bind(command, [input]);
  expect(bound).toBeInstanceOf(BoundPositional);
  return bound as BoundPositional<unknown, unknown>;
}

describe("issue arguments", () => {
  const [[, reference], ...others] = ISSUE_COMMANDS;

  test.each(
    ISSUE_INPUTS.flatMap((input) =>
      others.map(([name, command]) => [input, name, command] as const),
    ),
  )("%s reads the same in %s as in issue resolve", (input, _name, command) => {
    expect(parseIssue(command, input).parsed).toEqual(
      parseIssue(reference, input).parsed,
    );
  });

  test("text with spaces is a search", () => {
    expect(parseIssue(reference, "login timeout").parsed).toMatchObject({
      parsed: { type: "search", query: "login timeout" },
    });
  });

  test.each(ISSUE_COMMANDS)(
    "%s applies a pasted issue URL's server on resolve, not parse",
    async (_name, command) => {
      const bound = parseIssue(
        command,
        `${SERVER}/organizations/acme/issues/123456/`,
      );
      expect(bound.parsed).toMatchObject({ baseUrl: SERVER });
      expect(applyUrl).not.toHaveBeenCalled();

      await expect(bound.resolved).rejects.toBeInstanceOf(UrlApplied);
      expect(applyUrl).toHaveBeenCalledWith(SERVER);
    },
  );
});

/**
 * Commands that take one dashboard, through `dashboardArguments` or alike:
 * `[<org/project>] <dashboard-id-or-title>`.
 */
type DashboardCommand = {
  readonly name: string;
  readonly command: unknown;
  /** Arguments every input gets after the dashboard, such as a widget title */
  readonly trailing?: readonly string[];
  /** How many arguments the dashboard may take, if fewer than any */
  readonly maxArgs?: number;
};

/** The command the others must read dashboards like */
const DASHBOARD_VIEW: DashboardCommand = {
  name: "dashboard view",
  command: dashboardViewCommand,
};

const DASHBOARD_COMMANDS: readonly DashboardCommand[] = [
  DASHBOARD_VIEW,
  { name: "dashboard restore", command: dashboardRestoreCommand },
  { name: "dashboard revisions", command: dashboardRevisionsCommand },
  { name: "dashboard widget edit", command: widgetEditCommand },
  { name: "dashboard widget delete", command: widgetDeleteCommand },
  // The last argument is the widget title, and there are at most three
  {
    name: "dashboard widget add",
    command: widgetAddCommand,
    trailing: ["My Widget"],
    maxArgs: 2,
  },
];

const DASHBOARD_URL = `${SERVER}/organizations/acme/dashboard/42/`;

const DASHBOARD_INPUTS: readonly (readonly string[])[] = [
  ["42"],
  ["My Dashboard"],
  ["my-org/42"],
  ["my-org/web/42"],
  ["my-org/", "42"],
  ["my-org", "42"],
  ["my-org/web", "42"],
  ["my-org/", "My Dashboard"],
  // A bare word before a title: an org, or the start of the title
  ["My", "Dashboard"],
  // After a target, the rest of the arguments are one title
  ["my-org/", "My", "Dashboard"],
  ["42", "my-org/"],
  ["42", "43"],
  [DASHBOARD_URL],
  [`${SERVER}/organizations/acme/dashboards/`, "Errors"],
];

/** A parsed dashboard argument, without what is particular to a command. */
function parseDashboard(
  entry: DashboardCommand,
  args: readonly string[],
): Record<string, unknown> {
  const [bound] = bind(entry.command, [...args, ...(entry.trailing ?? [])]);
  expect(bound).toBeInstanceOf(BoundPositional);
  const { title: _title, ...input } = (
    bound as BoundPositional<Record<string, unknown>, unknown>
  ).parsed;
  return {
    ...input,
    // Warnings name the command's own usage
    warnings: (input.warnings as readonly string[]).map((warning) =>
      warning.replace(/ Expected: .*$/s, ""),
    ),
  };
}

describe("dashboard arguments", () => {
  test.each(
    DASHBOARD_INPUTS.flatMap((args) =>
      DASHBOARD_COMMANDS.slice(1)
        .filter((entry) => args.length <= (entry.maxArgs ?? args.length))
        .map((entry) => [args.join(" "), entry.name, args, entry] as const),
    ),
  )(
    "%s reads the same in %s as in dashboard view",
    (_input, _name, args, entry) => {
      expect(parseDashboard(entry, args)).toEqual(
        parseDashboard(DASHBOARD_VIEW, args),
      );
    },
  );

  test.each([
    [["42"], { ref: "42", target: { type: "auto-detect" } }],
    [
      ["My Dashboard"],
      { ref: "My Dashboard", target: { type: "auto-detect" } },
    ],
    [["my-org/42"], { ref: "42", target: { type: "org-all", org: "my-org" } }],
    [
      ["my-org/web", "42"],
      {
        ref: "42",
        target: { type: "explicit", org: "my-org", project: "web" },
      },
    ],
    [
      ["my-org/", "My", "Dashboard"],
      { ref: "My Dashboard", target: { type: "org-all", org: "my-org" } },
    ],
    [
      ["My", "Dashboard"],
      {
        ref: "Dashboard",
        target: { type: "org-all", org: "My" },
        orgOrTitle: { org: "My", title: "My Dashboard" },
      },
    ],
  ])("dashboard view reads %j as %j", (args, expected) => {
    expect(parseDashboard(DASHBOARD_VIEW, args)).toMatchObject(expected);
  });

  test("reversed arguments are swapped back, with a warning", () => {
    expect(parseDashboard(DASHBOARD_VIEW, ["42", "my-org/"])).toEqual({
      ref: "42",
      target: { type: "org-all", org: "my-org" },
      warnings: [expect.stringMatching(REVERSED)],
    });
  });

  test("extra arguments after an ID are ignored, with a warning", () => {
    expect(parseDashboard(DASHBOARD_VIEW, ["42", "43"])).toMatchObject({
      ref: "42",
      warnings: [expect.stringMatching(EXTRA)],
    });
  });

  test.each(DASHBOARD_COMMANDS)(
    "$name: a missing dashboard fails to parse, before the command runs",
    (entry) => {
      const error = parseError(entry.command, [...(entry.trailing ?? [])]);
      expect(error).toBeInstanceOf(ArgumentParseError);
    },
  );

  test.each(DASHBOARD_COMMANDS)(
    "$name: a pasted URL's server is applied on resolve, not parse",
    async (entry) => {
      const [bound] = bind(entry.command, [
        DASHBOARD_URL,
        ...(entry.trailing ?? []),
      ]);
      const parsed = (bound as BoundPositional<unknown, unknown>).parsed;
      expect(parsed).toMatchObject({
        ref: "42",
        target: { type: "org-all", org: "acme" },
        baseUrl: SERVER,
      });
      expect(applyUrl).not.toHaveBeenCalled();

      await expect(
        (bound as BoundPositional<unknown, unknown>).resolved,
      ).rejects.toBeInstanceOf(UrlApplied);
      expect(applyUrl).toHaveBeenCalledWith(SERVER);
    },
  );

  test("widget add takes its last argument as the widget title", () => {
    const [bound] = bind(widgetAddCommand, ["my-org/", "42", "My Widget"]);
    expect((bound as BoundPositional<unknown, unknown>).parsed).toMatchObject({
      ref: "42",
      target: { type: "org-all", org: "my-org" },
      title: "My Widget",
    });
  });

  test("widget add with more than three arguments fails to parse", () => {
    const error = parseError(widgetAddCommand, [
      "my-org/",
      "My",
      "Dashboard",
      "My Widget",
    ]);
    expect(error).toBeInstanceOf(ArgumentParseError);
  });
});

/**
 * `dashboard list` takes a target and a title filter, not a dashboard: a
 * bare word is a filter, and so is what follows `<org>/<project>/`.
 */
describe("dashboard list arguments", () => {
  function parseList(args: readonly string[]): unknown {
    const [bound] = bind(dashboardListCommand, args);
    expect(bound).toBeInstanceOf(BoundPositional);
    return (bound as BoundPositional<unknown, unknown>).parsed;
  }

  test.each([
    [[], { target: { type: "auto-detect" } }],
    [["Errors"], { target: { type: "auto-detect" }, titleFilter: "Errors" }],
    [["my-org/"], { target: { type: "org-all", org: "my-org" } }],
    [
      ["my-org/", "My", "Dashboard"],
      {
        target: { type: "org-all", org: "my-org" },
        titleFilter: "My Dashboard",
      },
    ],
    [
      ["my-org", "Errors"],
      { target: { type: "org-all", org: "my-org" }, titleFilter: "Errors" },
    ],
    [
      ["my-org/web/Err*"],
      {
        target: { type: "explicit", org: "my-org", project: "web" },
        titleFilter: "Err*",
      },
    ],
  ])("reads %j as %j", (args, expected) => {
    expect(parseList(args)).toMatchObject(expected);
  });

  test("a dashboard URL fails to parse, suggesting dashboard view", () => {
    const error = parseError(dashboardListCommand, [DASHBOARD_URL]);
    expect(error).toBeInstanceOf(ArgumentParseError);
    expect(String((error as ArgumentParseError).exception)).toContain(
      "sentry dashboard view acme/ 42",
    );
  });
});

/** Commands that take a `[<org>/]<version>` release. */
const RELEASE_COMMANDS: readonly (readonly [string, unknown])[] = [
  ["release view", releaseViewCommand],
  ["release archive", releaseArchiveCommand],
  ["release create", releaseCreateCommand],
  ["release delete", releaseDeleteCommand],
  ["release deploy", releaseDeployCommand],
  ["release deploys", releaseDeploysCommand],
  ["release finalize", releaseFinalizeCommand],
  ["release restore", releaseRestoreCommand],
  ["release set-commits", releaseSetCommitsCommand],
];

describe.each(RELEASE_COMMANDS)("%s", (_name, command) => {
  test.each([
    ["1.0.0", { version: "1.0.0" }],
    ["my-org/1.0.0", { orgSlug: "my-org", version: "1.0.0" }],
    // A prefix that is not a slug is part of the version
    ["sentry-cli@2.0.0", { version: "sentry-cli@2.0.0" }],
    ["my-org/feature/x", { orgSlug: "my-org", version: "feature/x" }],
  ])("parses %s before the command runs", (input, expected) => {
    const [bound] = bind(command, [input]);
    expect(bound).toBeInstanceOf(BoundPositional);
    expect((bound as BoundPositional<unknown, unknown>).parsed).toEqual(
      expected,
    );
  });

  test("a blank version fails to parse", () => {
    expect(() => bind(command, ["  "])).toThrow(ContextError);
  });
});

const ORG_URL = `${SERVER}/organizations/acme/`;

/**
 * Commands that take an optional `[<org>/][<project>]` target, then other
 * positionals of their own.
 */
const TARGET_THEN_POSITIONALS: readonly {
  readonly name: string;
  readonly command: unknown;
  /** Arguments that name org `acme` */
  readonly args: readonly string[];
  /** The org the command parsed */
  readonly org: (parsed: unknown) => string | undefined;
  /** Arguments that fail to parse */
  readonly invalid: readonly string[];
  /** Whether the target may be a pasted Sentry URL */
  readonly url: boolean;
}[] = [
  {
    name: "init",
    command: initCommand,
    args: ["acme/", "./app"],
    org: (parsed) => (parsed as { target: ParsedTarget }).target.org,
    // Two targets, and no directory
    invalid: ["acme/", "other/"],
    url: true,
  },
  {
    name: "dashboard create",
    command: dashboardCreateCommand,
    args: ["acme/", "My", "Dashboard"],
    org: (parsed) => (parsed as { target: ParsedTarget }).target.org,
    // No title
    invalid: [],
    url: true,
  },
  {
    name: "project create",
    command: projectCreateCommand,
    args: ["acme/web:node", "acme/api:python"],
    org: (parsed) => (parsed as { explicitOrg?: string }).explicitOrg,
    // No platform
    invalid: ["acme/web"],
    url: false,
  },
];

describe.each(TARGET_THEN_POSITIONALS)("$name", (entry) => {
  test("parses its arguments before the command runs", () => {
    const [bound] = bind(entry.command, entry.args);
    expect(bound).toBeInstanceOf(BoundPositional);
    expect(entry.org((bound as BoundPositional<unknown, unknown>).parsed)).toBe(
      "acme",
    );
  });

  test("invalid arguments fail to parse, before the command runs", () => {
    expect(parseError(entry.command, entry.invalid)).toBeInstanceOf(
      ArgumentParseError,
    );
  });

  test.runIf(entry.url)(
    "a pasted URL names the org; its server is applied on resolve, not parse",
    async () => {
      const [, ...rest] = entry.args;
      const [bound] = bind(entry.command, [ORG_URL, ...rest]);
      // Reading `resolved` starts the resolver, so only read `parsed` first
      const value = bound as BoundPositional<unknown, unknown>;
      expect(entry.org(value.parsed)).toBe("acme");
      expect(value.parsed).toMatchObject({ baseUrl: SERVER });
      expect(applyUrl).not.toHaveBeenCalled();

      await expect(value.resolved).rejects.toBeInstanceOf(UrlApplied);
      expect(applyUrl).toHaveBeenCalledWith(SERVER);
    },
  );
});

describe("init target and directory", () => {
  test.each([
    [["./app"], { directory: "./app", target: { type: "auto-detect" } }],
    [
      ["acme/web"],
      { target: { type: "explicit", org: "acme", project: "web" } },
    ],
    [["acme/", "./app"], { directory: "./app" }],
    [
      ["./app", "acme/"],
      { directory: "./app", warning: expect.stringMatching(REVERSED) },
    ],
  ])("tells the target from the directory in %j", (args, expected) => {
    const [bound] = bind(initCommand, args);
    expect((bound as BoundPositional<unknown, unknown>).parsed).toMatchObject(
      expected,
    );
  });
});
