/**
 * The command surface: `search_sentry`, `execute_sentry_read`, and
 * `execute_sentry_write`, which find and run CLI commands from the generated
 * command catalog instead of hand-written tools.
 *
 * The tools only check and shape calls; a {@link CommandRunner} runs them.
 * The stdio server (`sentry mcp --commands`) runs them through the CLI SDK;
 * the hosted server will pass its own runner.
 */

import { z } from "zod";
import { UserInputError } from "../errors";
import {
  type CommandCatalog,
  type CommandCatalogEntry,
  commandCatalog,
} from "../command-catalog";
import { defineTool } from "../internal/tool-helpers/define";
import { ALL_SKILLS } from "../skills";
import type { ToolRegistry } from "../tools/catalog-runtime/availability";
import {
  agentParameters,
  type CommandRuntime,
  commandName,
  findCommand,
} from "./commands";
import {
  EXECUTE_TOOL_NAMES,
  type ExecuteToolKind,
  executeToolFor,
  prepareCommandCall,
  type SessionPolicy,
  unavailableReason,
} from "./prepare";
import { formatCommandResult } from "./result";
import { searchCommands } from "./search";
import type { CommandCompleter, CommandRunner } from "./types";

const SEARCH_TOOL_NAME = "search_sentry";

/** Most commands a query returns. */
const SEARCH_LIMIT = 8;

export type CommandSurfaceOptions = {
  run: CommandRunner;
  runtime: CommandRuntime;
  /** List only the read tool and refuse write calls. */
  readOnly?: boolean;
  /**
   * Completes parameter values for `search_sentry`'s `complete` mode. Until
   * the completion work (#1895) passes one, the mode is not offered.
   */
  complete?: CommandCompleter;
  /** Defaults to the generated catalog. */
  catalog?: CommandCatalog;
  maxResultChars?: number;
};

/** Which execute tool runs `entry`, or how `sentry api` picks one. */
function toolFor(entry: CommandCatalogEntry, policy: SessionPolicy): string {
  if (entry.permission === "method") {
    return policy.readOnly
      ? `${EXECUTE_TOOL_NAMES.read} (GET, HEAD, OPTIONS only)`
      : `${EXECUTE_TOOL_NAMES.read} for GET, HEAD, OPTIONS; ${EXECUTE_TOOL_NAMES.write} otherwise`;
  }
  return EXECUTE_TOOL_NAMES[executeToolFor(entry.permission)];
}

/** Where to send `entry`: its tool, or why this session cannot run it. */
function availability(
  entry: CommandCatalogEntry,
  policy: SessionPolicy,
): { tool: string } | { unavailable: string } {
  const reason = unavailableReason(entry, policy);
  return reason ? { unavailable: reason } : { tool: toolFor(entry, policy) };
}

function describeCommand(entry: CommandCatalogEntry, policy: SessionPolicy) {
  return {
    command: commandName(entry),
    brief: entry.brief,
    permission: entry.permission,
    ...availability(entry, policy),
    params: agentParameters(entry),
    examples: entry.examples,
    ...(entry.outputFields ? { outputFields: entry.outputFields } : {}),
  };
}

function unknownCommand(input: string): UserInputError {
  return new UserInputError(
    `No command "${input}" is available to agents. Search for one with search_sentry({ query }).`,
  );
}

function createSearchTool(
  catalog: CommandCatalog,
  policy: SessionPolicy,
  complete: CommandCompleter | undefined,
) {
  const baseInput = {
    query: z.string().trim().optional().describe("Words describing the task"),
    command: z
      .string()
      .trim()
      .optional()
      .describe("A command name, such as `issue list`"),
  };
  const completeInput = {
    ...baseInput,
    complete: z
      .object({
        parameter: z
          .string()
          .describe("`positional[0]`, or a flag name such as `query`"),
        value: z.string().default("").describe("The value typed so far"),
      })
      .optional()
      .describe("With command: complete a parameter value"),
  };
  // The complete mode is listed only when something can answer it.
  const inputSchema: typeof baseInput = complete ? completeInput : baseInput;
  return defineTool({
    name: SEARCH_TOOL_NAME,
    skills: ALL_SKILLS,
    requiredScopes: [],
    description: [
      "Find Sentry CLI commands to run with execute_sentry_read or execute_sentry_write.",
      "",
      "- query: words describing the task. Returns matching commands and the tool that runs each.",
      "- command: a command name such as `issue list`. Returns its params schema (positional arguments and flags, by CLI flag name), examples, and output fields.",
      "",
      "<examples>",
      "search_sentry(query='unresolved issues in a project')",
      "search_sentry(command='issue list')",
      "</examples>",
    ].join("\n"),
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async handler(params, context) {
      const { query, command } = params;
      const completion = (params as z.infer<z.ZodObject<typeof completeInput>>)
        .complete;
      if (command) {
        const entry = findCommand(catalog, command);
        if (!entry) {
          throw unknownCommand(command);
        }
        if (completion && complete) {
          const candidates = await complete(
            { command: commandName(entry), ...completion },
            context,
          );
          return JSON.stringify({ command: commandName(entry), candidates });
        }
        return JSON.stringify(describeCommand(entry, policy));
      }
      if (!query) {
        throw new UserInputError(
          "Pass query (words describing the task) or command (a command name).",
        );
      }
      const commands = searchCommands(catalog, query, SEARCH_LIMIT).map(
        (entry) => ({
          command: commandName(entry),
          brief: entry.brief,
          permission: entry.permission,
          ...availability(entry, policy),
        }),
      );
      return JSON.stringify({
        commands,
        ...(commands.length === 0
          ? {
              hint: "No command matched. Try other words, such as the resource (issue, trace, release) and the action (list, view, create).",
            }
          : {}),
      });
    },
  });
}

const EXECUTE_DESCRIPTIONS: Record<ExecuteToolKind, string> = {
  read: "Run a read-only Sentry CLI command found with search_sentry, such as `issue list`.",
  write:
    "Run a Sentry CLI command that changes data (write or destructive), found with search_sentry, such as `issue resolve`.",
};

function createExecuteTool(
  kind: ExecuteToolKind,
  catalog: CommandCatalog,
  policy: SessionPolicy,
  options: CommandSurfaceOptions,
) {
  const other = EXECUTE_TOOL_NAMES[kind === "read" ? "write" : "read"];
  return defineTool({
    name: EXECUTE_TOOL_NAMES[kind],
    skills: ALL_SKILLS,
    requiredScopes: [],
    description: [
      EXECUTE_DESCRIPTIONS[kind],
      "",
      `- command: the command name. ${policy.readOnly ? "This session is read-only." : `Calls of the other class go to ${other}.`}`,
      "- params: `positional` (an array) and `flags` (an object keyed by CLI flag name, such as `dry-run`), as search_sentry returns them. Output is always JSON.",
      "- Paginated results include nextCursor; pass it as the cursor flag for the next page.",
      "",
      "<examples>",
      kind === "read"
        ? `${EXECUTE_TOOL_NAMES.read}(command='issue list', params={ positional: ['my-org/my-project'], flags: { query: 'is:unresolved', limit: 10 } })`
        : `${EXECUTE_TOOL_NAMES.write}(command='issue resolve', params={ positional: ['MY-PROJECT-1A'] })`,
      "</examples>",
    ].join("\n"),
    inputSchema: {
      command: z
        .string()
        .trim()
        .min(1)
        .describe("Command name, such as `issue list`"),
      params: z
        .object({
          positional: z.array(z.string()).optional(),
          flags: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .optional()
        .describe(
          "Positional arguments and flags, as search_sentry describes them",
        ),
    },
    annotations:
      kind === "read"
        ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
        : { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async handler({ command, params }, context) {
      const entry = findCommand(catalog, command);
      if (!entry) {
        throw unknownCommand(command);
      }
      const call = prepareCommandCall({
        entry,
        params,
        tool: kind,
        policy,
        context,
      });
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
 * The command surface's tools, for `buildServer({ tools })`. A read-only
 * session gets no write tool.
 */
export function createCommandTools(
  options: CommandSurfaceOptions,
): ToolRegistry {
  const catalog = options.catalog ?? commandCatalog;
  const policy: SessionPolicy = {
    runtime: options.runtime,
    readOnly: options.readOnly ?? false,
  };
  return {
    [SEARCH_TOOL_NAME]: createSearchTool(catalog, policy, options.complete),
    [EXECUTE_TOOL_NAMES.read]: createExecuteTool(
      "read",
      catalog,
      policy,
      options,
    ),
    ...(policy.readOnly
      ? {}
      : {
          [EXECUTE_TOOL_NAMES.write]: createExecuteTool(
            "write",
            catalog,
            policy,
            options,
          ),
        }),
  };
}
