/**
 * The command surface: one MCP tool per exposed CLI command in the generated
 * command catalog (`sentry issue list` → `sentry_issue_list`), instead of
 * hand-written tools. Harnesses search large tool lists themselves, so there
 * is no search or execute meta-tool.
 *
 * The tools only check and shape calls; a {@link CommandRunner} runs them.
 * The stdio server (`sentry mcp --commands`) runs them through the CLI SDK;
 * the hosted server will pass its own runner.
 */

import { z } from "zod";
import {
  type CommandCatalog,
  type CommandCatalogEntry,
  commandCatalog,
  type JsonSchema,
} from "../command-catalog";
import { defineTool } from "../internal/tool-helpers/define";
import type { ToolRegistry } from "../tools/catalog-runtime/availability";
import type { ToolConfig } from "../tools/types";
import {
  agentParameters,
  type CommandRuntime,
  commandName,
  commandSkills,
  refusedFlagReason,
} from "./commands";
import {
  prepareCommandCall,
  type SessionPolicy,
  unavailableReason,
} from "./prepare";
import { formatCommandResult } from "./result";
import type { CommandRunner } from "./types";

export type CommandSurfaceOptions = {
  run: CommandRunner;
  runtime: CommandRuntime;
  /** List only read tools, and refuse write calls of `sentry api`. */
  readOnly?: boolean;
  /** Defaults to the generated catalog. */
  catalog?: CommandCatalog;
  maxResultChars?: number;
};

/** The MCP tool name of a command: its path, with `_` for spaces and dashes. */
function commandToolName(entry: CommandCatalogEntry): string {
  return entry.path.replace(/[ -]/g, "_");
}

/** The display title of a command's tool: `sentry issue list` → `Issue List`. */
function commandToolTitle(entry: CommandCatalogEntry): string {
  return commandName(entry)
    .split(/[ -]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Hints from the command's permission class. `sentry api` takes the class of
 * each call's method, so it is marked destructive unless the session is
 * read-only, where it refuses everything but reads.
 */
function annotationsFor(
  entry: CommandCatalogEntry,
  policy: SessionPolicy,
): ToolConfig["annotations"] {
  const readOnly =
    entry.permission === "read" ||
    (entry.permission === "method" && policy.readOnly);
  return readOnly
    ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    : { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

const PIPE = / \| /;

/**
 * The command's examples an agent can follow: none that pipe output to
 * another program or pass a flag the MCP refuses.
 */
function usableExamples(entry: CommandCatalogEntry): string[] {
  const flagNames = Object.keys(
    entry.parameters.properties?.flags?.properties ?? {},
  );
  const refused = flagNames.filter((name) => refusedFlagReason(entry, name));
  return entry.examples.filter(
    (example) =>
      !PIPE.test(example) &&
      !refused.some((name) => example.includes(`--${name}`)),
  );
}

function describeCommand(
  entry: CommandCatalogEntry,
  policy: SessionPolicy,
): string {
  const flags = agentParameters(entry).properties?.flags?.properties ?? {};
  const examples = usableExamples(entry);
  return [
    entry.brief,
    "",
    "Pass positional arguments in `positional` and flags in `flags`, by CLI flag name. Returns JSON.",
    ...(flags.cursor
      ? ["Paginated: pass the result's nextCursor as flags.cursor."]
      : []),
    ...(entry.permission === "method"
      ? [
          policy.readOnly
            ? "This session is read-only: only GET, HEAD, and OPTIONS run."
            : "GET, HEAD, and OPTIONS read; other methods change data.",
        ]
      : []),
    ...(examples.length > 0 ? ["", "Examples, in CLI form:", ...examples] : []),
  ].join("\n");
}

/**
 * The tool's input shape, listed as the catalog's JSON Schema. The schema
 * rides along as metadata on permissive Zod types, so `tools/list` shows it
 * unchanged while {@link prepareCommandCall} checks calls against it (with
 * errors that name the allowed values) and no defaults are filled in.
 */
function inputShape(parameters: JsonSchema): Record<string, z.ZodType> {
  const required = new Set(parameters.required ?? []);
  return Object.fromEntries(
    Object.entries(parameters.properties ?? {}).map(([name, schema]) => {
      const field = z.unknown().meta(schema ?? {});
      return [name, required.has(name) ? field : field.optional()];
    }),
  );
}

function createCommandTool(
  entry: CommandCatalogEntry,
  policy: SessionPolicy,
  options: CommandSurfaceOptions,
) {
  return defineTool({
    name: commandToolName(entry),
    title: commandToolTitle(entry),
    skills: commandSkills(entry),
    requiredScopes: [],
    description: describeCommand(entry, policy),
    inputSchema: inputShape(agentParameters(entry)),
    annotations: annotationsFor(entry, policy),
    async handler(params, context) {
      const call = prepareCommandCall({ entry, params, policy, context });
      const output = await options.run(call, context);
      return formatCommandResult(
        commandName(entry),
        output,
        options.maxResultChars,
      );
    },
  });
}

/**
 * One tool per command this session can run, for `buildServer({ tools })`:
 * the catalog's exposed commands with JSON output, without write commands
 * when the session is read-only.
 */
export function createCommandTools(
  options: CommandSurfaceOptions,
): ToolRegistry {
  const catalog = options.catalog ?? commandCatalog;
  const policy: SessionPolicy = {
    runtime: options.runtime,
    readOnly: options.readOnly ?? false,
  };
  const tools: ToolRegistry = {};
  for (const entry of catalog.commands) {
    if (unavailableReason(entry, policy)) {
      continue;
    }
    const name = commandToolName(entry);
    if (Object.hasOwn(tools, name)) {
      throw new Error(`Two commands map to the MCP tool name ${name}`);
    }
    tools[name] = createCommandTool(entry, policy, options);
  }
  return tools;
}
