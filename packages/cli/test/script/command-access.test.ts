import { describe, expect, it } from "vitest";
import {
  allCommands,
  type CommandRequests,
  commandAccessProblems,
} from "../../script/lib/command-access.js";
import {
  analyzeSourceApiUsage,
  type SourceApiOperation,
} from "../../script/lib/source-api-usage.js";
import type { DeclaredPermission } from "../../src/lib/command-access.js";
import { buildCommand } from "../../src/lib/command.js";
import type { Command, RouteMap } from "../../src/lib/introspect.js";
import { buildRouteMap } from "../../src/lib/route-map.js";

const operations: SourceApiOperation[] = [
  {
    functionName: "listOrganizationEvents",
    method: "GET",
    path: "/api/0/organizations/{organization_id_or_slug}/events/",
  },
  {
    functionName: "updateOrganizationIssue",
    method: "PUT",
    path: "/api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/",
  },
];

/** Requests the analysis finds for each export of a planted command file. */
function plantedRequests(): Map<string, CommandRequests> {
  const sources = new Map([
    [
      "src/commands/planted.ts",
      `
      import { listOrganizationEvents, updateOrganizationIssue } from "@sentry/api";
      export const list = buildCommand({ func: () => listOrganizationEvents({}) });
      export const edit = buildCommand({ func: () => updateOrganizationIssue({}) });
      export const send = buildCommand({
        func: () => fetch("https://o1.ingest.sentry.io/api/1/envelope/", { method: "POST" }),
      });
      export const local = buildCommand({ func: () => readConfig() });
    `,
    ],
  ]);
  const usage = analyzeSourceApiUsage(sources, operations).exports.get(
    "src/commands/planted.ts",
  )!;
  return new Map(
    [...usage].map(([name, { methods, apiMethods }]) => [
      name,
      { methods, apiMethods },
    ]),
  );
}

function command(
  access: {
    exposure?: "exposed" | "stdio-only" | "hidden";
    permission?: DeclaredPermission;
    destructive?: boolean;
  } = {},
): Command {
  return buildCommand({
    exposure: "exposed",
    ...access,
    docs: { brief: "Planted command" },
    auth: false,
    async *func() {
      yield;
    },
  } as Parameters<typeof buildCommand>[0]) as unknown as Command;
}

describe("command access check", () => {
  const requests = plantedRequests();
  const problems = (
    name: string,
    access?: Parameters<typeof command>[0],
  ): string[] => commandAccessProblems(command(access), requests.get(name));

  it("fails a GET-only command marked write", () => {
    expect(problems("list", { permission: "write" })).toEqual([
      'declares `permission: "write"`, but its Sentry API requests are read-only',
    ]);
  });

  it("fails a write command marked read", () => {
    expect(problems("edit", { permission: "read" })).toEqual([
      'declares `permission: "read"`, but it sends PUT Sentry API requests',
    ]);
  });

  it("derives the class from API requests and rejects redundant declarations", () => {
    expect(problems("list")).toEqual([]);
    expect(problems("edit")).toEqual([]);
    expect(problems("edit", { permission: "write" })).toEqual([
      'declares `permission: "write"`, which its API requests already give; drop it',
    ]);
    expect(problems("local", { permission: "read" })).toEqual([
      'declares `permission: "read"`, which its requests already give; drop it',
    ]);
  });

  it("asks for a declaration where API requests can't settle the class", () => {
    expect(problems("send")).toEqual([
      'sends POST requests outside the Sentry API; declare `permission: "read"` or `"write"`',
    ]);
    expect(problems("send", { permission: "write" })).toEqual([]);
    expect(problems("unanalyzed")).toEqual([
      "has no source export the API analysis can follow; declare `permission`",
    ]);
    expect(problems("unanalyzed", { exposure: "hidden" })).toEqual([]);
    expect(problems("local", { permission: "method" })).toEqual([]);
    expect(problems("list", { permission: "method" })).toEqual([
      'declares `permission: "method"`, but its Sentry API requests are read-only',
    ]);
  });

  it("fails a command without exposure and a destructive command that declares a class", () => {
    expect(
      commandAccessProblems(
        { ...command(), __exposure: undefined },
        requests.get("list"),
      ),
    ).toEqual([
      "declares no exposure (exposed, stdio-only, hidden); pass `exposure` to its builder",
    ]);
    expect(
      problems("edit", { destructive: true, permission: "write" }),
    ).toEqual([
      'is destructive, which sets its class; drop `permission: "write"`',
    ]);
  });

  it("checks commands under hidden routes", () => {
    const visible = command();
    const hidden = command();
    const tree = buildRouteMap({
      routes: {
        group: buildRouteMap({
          routes: { visible },
          docs: { brief: "Group" },
        }),
        legacy: hidden,
      },
      docs: { brief: "CLI", hideRoute: { legacy: true } },
    }) as unknown as RouteMap;
    expect([...allCommands(tree).values()]).toEqual([
      "sentry group visible",
      "sentry legacy",
    ]);
  });
});
