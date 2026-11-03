/**
 * Everything an execute call is checked against before it runs: exposure,
 * refused flags, the parameter schema, the permission class of the tool it
 * came through, and the session's constraints.
 */

import { UserInputError } from "../errors";
import type { CommandCatalogEntry } from "../command-catalog";
import type { ServerContext } from "../types";
import {
  agentParameters,
  type CallPermission,
  type CommandRuntime,
  callPermission,
  commandName,
  commandSegments,
  isInjectedFlag,
  refusedFlagReason,
} from "./commands";
import { pinConstraints } from "./constraints";
import type { CommandCall } from "./types";
import { validateJsonSchema } from "./validate";

/** The execute tools, by the permission classes they run. */
export type ExecuteToolKind = "read" | "write";

export const EXECUTE_TOOL_NAMES: Record<ExecuteToolKind, string> = {
  read: "execute_sentry_read",
  write: "execute_sentry_write",
};

/** Pagination keywords that need the CLI's stored cursor stack. */
const CURSOR_KEYWORDS = new Set(["next", "prev"]);

export type SessionPolicy = {
  runtime: CommandRuntime;
  /** Refuse write and destructive calls (`--read-only`, hosted API Read). */
  readOnly: boolean;
};

/** The execute tool for a permission class. */
export function executeToolFor(permission: CallPermission): ExecuteToolKind {
  return permission === "read" ? "read" : "write";
}

/**
 * Why the session cannot run `entry` at all, or `undefined` when it can.
 * Per-call reasons (a refused flag, the method of `sentry api`) are checked
 * by {@link prepareCommandCall}.
 */
export function unavailableReason(
  entry: CommandCatalogEntry,
  policy: SessionPolicy,
): string | undefined {
  if (entry.exposure === "stdio-only" && policy.runtime === "hosted") {
    return "it needs the local machine, so it runs only on the stdio server (`sentry mcp`)";
  }
  if (!entry.parameters.properties?.flags?.properties?.json) {
    return "it has no JSON output";
  }
  if (
    policy.readOnly &&
    entry.permission !== "read" &&
    entry.permission !== "method"
  ) {
    return "this session is read-only";
  }
  return;
}

function refuse(entry: CommandCatalogEntry, reason: string): UserInputError {
  return new UserInputError(
    `\`${commandName(entry)}\` cannot run here: ${reason}.`,
  );
}

/** The `params` of an execute call, as the tool's input schema accepts it. */
type ExecuteParams = {
  positional?: string[];
  flags?: Record<string, unknown>;
};

/** Drop the injected `json` flag, and refuse flags the MCP does not pass through. */
function readFlags(
  entry: CommandCatalogEntry,
  rawFlags: Record<string, unknown> = {},
): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawFlags)) {
    if (isInjectedFlag(name) || value === undefined || value === null) {
      continue;
    }
    const reason = refusedFlagReason(entry, name);
    if (reason) {
      // Turning a refused boolean flag off asks for nothing.
      if (value === false) {
        continue;
      }
      throw refuse(
        entry,
        `\`--${name}\` is not available to agents, because ${reason}`,
      );
    }
    flags[name] = value;
  }
  return flags;
}

/**
 * Check an execute call and build the call to run.
 *
 * @throws {UserInputError} When the command is unavailable, the params fail
 *   the schema, the permission class belongs to the other execute tool, or a
 *   target is outside the session's constraints
 */
export function prepareCommandCall({
  entry,
  params,
  tool,
  policy,
  context,
}: {
  entry: CommandCatalogEntry;
  params: ExecuteParams | undefined;
  tool: ExecuteToolKind;
  policy: SessionPolicy;
  context: ServerContext;
}): CommandCall {
  const name = commandName(entry);
  const unavailable = unavailableReason(entry, policy);
  if (unavailable) {
    throw refuse(entry, unavailable);
  }

  const positional = params?.positional;
  const flags = readFlags(entry, params?.flags);
  const errors = validateJsonSchema(
    agentParameters(entry),
    positional === undefined ? { flags } : { positional, flags },
    "params",
  );
  if (errors.length > 0) {
    throw new UserInputError(
      `Invalid params for \`${name}\`:\n${errors.map((error) => `- ${error}`).join("\n")}\nCall search_sentry with command "${name}" for its parameters.`,
    );
  }

  const permission = callPermission(entry, flags);
  const needed = executeToolFor(permission);
  if (policy.readOnly && needed === "write") {
    throw refuse(
      entry,
      `this session is read-only, and this call is a ${permission} call`,
    );
  }
  if (needed !== tool) {
    throw new UserInputError(
      `\`${name}\` is a ${permission} call here; run it with ${EXECUTE_TOOL_NAMES[needed]}, not ${EXECUTE_TOOL_NAMES[tool]}.`,
    );
  }

  const cursor = flags.cursor;
  if (
    policy.runtime === "hosted" &&
    typeof cursor === "string" &&
    CURSOR_KEYWORDS.has(cursor)
  ) {
    throw new UserInputError(
      `The cursor keyword "${cursor}" needs stored pagination state, which this server does not keep. Pass the nextCursor value from the previous result instead.`,
    );
  }

  const { organizationSlug, projectSlug } = context.constraints;
  return {
    path: commandSegments(entry),
    positional: pinConstraints(
      entry,
      positional ?? [],
      flags,
      context.constraints,
    ),
    flags: flags as CommandCall["flags"],
    ...(organizationSlug ? { org: organizationSlug } : {}),
    ...(organizationSlug && projectSlug ? { project: projectSlug } : {}),
  };
}
