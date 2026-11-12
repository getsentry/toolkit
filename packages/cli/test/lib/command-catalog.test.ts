/**
 * The generated command catalog matches the route tree's introspection.
 */

import { readFileSync } from "node:fs";
import type { CommandCatalog } from "@sentry/mcp-core/command-catalog";
import { describe, expect, test } from "vitest";
import { routes } from "../../src/app.js";
import generatedCommandApi from "../../src/generated/command-api.json";
import { extractCommandCatalog } from "../../src/lib/command-catalog.js";
import {
  choiceParser,
  parseFilePath,
  parseOrgSlug,
} from "../../src/lib/completion-target.js";
import {
  type Command,
  extractAllRoutes,
  type RouteMap,
} from "../../src/lib/introspect.js";

const tree = routes as unknown as RouteMap;

function committedCatalog(): CommandCatalog {
  return JSON.parse(
    readFileSync(
      new URL("../../../mcp-core/src/command-catalog.json", import.meta.url),
      "utf8",
    ),
  );
}

describe("command catalog", () => {
  test("the committed file is the catalog of the current route tree", () => {
    expect(committedCatalog()).toEqual(extractCommandCatalog(tree));
  });

  test("lists every public command that is not hidden, with its introspection", () => {
    const catalog = new Map(
      extractCommandCatalog(tree).commands.map((entry) => [entry.path, entry]),
    );
    const api: Record<string, unknown[]> = generatedCommandApi;
    const listed = extractAllRoutes(tree)
      .flatMap((route) => route.commands)
      .filter((info) => info.exposure !== "hidden");

    const byPath = (a: string, b: string) => a.localeCompare(b);
    expect([...catalog.keys()].sort(byPath)).toEqual(
      listed.map((info) => info.path).sort(byPath),
    );
    for (const info of listed) {
      const entry = catalog.get(info.path);
      const flags = info.flags.filter((flag) => !flag.hidden);
      expect({
        brief: entry?.brief,
        permission: entry?.permission,
        exposure: entry?.exposure,
        examples: entry?.examples,
        outputFields: entry?.outputFields,
        localPathFlags: entry?.localPathFlags ?? [],
        apiOperations: entry?.apiOperations,
      }).toEqual({
        brief: info.brief,
        permission: info.permission,
        exposure: info.exposure,
        examples: info.examples,
        outputFields: info.jsonFields,
        localPathFlags: flags
          .filter((flag) => flag.localPath)
          .map((flag) => flag.name),
        apiOperations: api[info.path] ?? [],
      });
      expect(
        Object.keys(entry?.parameters.properties?.flags?.properties ?? {}),
      ).toEqual(flags.map((flag) => flag.name));
      expect(
        entry?.parameters.properties?.positional?.prefixItems?.length ??
          (entry?.parameters.properties?.positional ? 1 : 0),
      ).toBe(info.positionals.length);
    }
  });

  test("gives every array an item schema, which VS Code Copilot requires", () => {
    const arraysWithoutItems = (schema: unknown, path: string): string[] => {
      if (!schema || typeof schema !== "object") return [];
      const node = schema as Record<string, unknown>;
      const own =
        node.type === "array" &&
        (typeof node.items !== "object" || node.items === null)
          ? [path]
          : [];
      return [
        ...own,
        ...Object.entries(node).flatMap(([key, value]) =>
          arraysWithoutItems(value, `${path}.${key}`),
        ),
      ];
    };
    expect(
      committedCatalog().commands.flatMap((entry) =>
        arraysWithoutItems(entry.parameters, entry.path),
      ),
    ).toEqual([]);
  });

  test("describes positionals and visible flags as JSON Schema", () => {
    const command: Command = {
      brief: "Do a thing",
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            { placeholder: "org", brief: "Organization", parse: parseOrgSlug },
            { placeholder: "name", optional: true },
          ],
        },
        flags: {
          limit: { kind: "parsed", brief: "Max items", default: "25" },
          sort: { kind: "enum", values: ["new", "old"], default: "new" },
          period: {
            kind: "parsed",
            brief: "Time range",
            parse: choiceParser(["24h", "7d"]),
            optional: true,
          },
          file: { kind: "parsed", brief: "Input", parse: parseFilePath },
          tag: { kind: "parsed", variadic: true, optional: true },
          dry: { kind: "boolean", default: false },
          secret: { kind: "boolean", hidden: true },
        },
      },
      __exposure: "stdio-only",
    };
    const hidden: Command = { ...command, __exposure: undefined };
    const thing: RouteMap = {
      brief: "Things",
      getAllEntries: () => [
        { name: { original: "do" }, target: command, hidden: false },
        { name: { original: "internal" }, target: hidden, hidden: false },
      ],
    };
    const root: RouteMap = {
      brief: "CLI",
      getAllEntries: () => [
        { name: { original: "thing" }, target: thing, hidden: false },
      ],
    };

    expect(
      extractCommandCatalog(root, { "sentry thing do": [{ fn: "doThing" }] }),
    ).toEqual({
      commands: [
        {
          path: "sentry thing do",
          brief: "Do a thing",
          permission: "read",
          exposure: "stdio-only",
          parameters: {
            type: "object",
            properties: {
              positional: {
                type: "array",
                prefixItems: [
                  { type: "string", title: "org", description: "Organization" },
                  { type: "string", title: "name" },
                ],
                items: { type: "string" },
                minItems: 1,
                maxItems: 2,
              },
              flags: {
                type: "object",
                properties: {
                  limit: {
                    type: "number",
                    description: "Max items",
                    default: 25,
                  },
                  sort: {
                    type: "string",
                    enum: ["new", "old"],
                    default: "new",
                  },
                  period: {
                    type: "string",
                    examples: ["24h", "7d"],
                    description: "Time range",
                  },
                  file: { type: "string", description: "Input" },
                  tag: { type: "array", items: { type: "string" } },
                  dry: { type: "boolean", default: false },
                },
                required: ["file"],
                additionalProperties: false,
              },
            },
            required: ["positional", "flags"],
            additionalProperties: false,
          },
          completions: {
            positional: ["org", null],
            flags: { sort: "choice", period: "choice", file: "file" },
          },
          localPathFlags: ["file"],
          examples: [],
          apiOperations: [{ fn: "doThing" }],
        },
      ],
    });
  });
});
