/**
 * Command names and the per-call rules that do not depend on the session:
 * which flags agents may pass, and the permission class of a call.
 */

import type { CommandCatalogEntry, JsonSchema } from "../command-catalog";

/** Where the server runs: the hosted one keeps no CLI state between calls. */
export type CommandRuntime = "stdio" | "hosted";

/** What one call may do to Sentry. */
type CallPermission = "read" | "write" | "destructive";

/**
 * Flags the executor sets itself: it always asks for JSON. Callers that pass
 * it are ignored rather than refused.
 */
const INJECTED_FLAGS = new Set(["json"]);

/** Flags that turn a command into a stream with no end. */
const STREAMING_FLAGS = new Set(["follow", "refresh", "watch"]);

/** Flags that open a browser on the machine that runs the command. */
const BROWSER_FLAGS = new Set(["web"]);

/** HTTP methods that only read. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The command name without `sentry ` (`issue list`). */
export function commandName(entry: CommandCatalogEntry): string {
  return entry.path.replace(/^sentry /, "");
}

/** Path segments for the SDK (`["issue", "list"]`). */
export function commandSegments(entry: CommandCatalogEntry): string[] {
  return commandName(entry).split(" ");
}

/** Why a flag cannot be passed through the MCP, or `undefined` when it can. */
export function refusedFlagReason(
  entry: CommandCatalogEntry,
  flag: string,
): string | undefined {
  if (entry.localPathFlags?.includes(flag)) {
    return "it reads or writes a path on the local machine";
  }
  if (STREAMING_FLAGS.has(flag)) {
    return "it streams output with no end";
  }
  if (BROWSER_FLAGS.has(flag)) {
    return "it opens a browser";
  }
  return;
}

/** Whether the executor drops `flag` because it sets the flag itself. */
export function isInjectedFlag(flag: string): boolean {
  return INJECTED_FLAGS.has(flag);
}

/** `entry`'s flag schemas, by flag name. */
function flagSchemas(entry: CommandCatalogEntry): Record<string, JsonSchema> {
  return entry.parameters.properties?.flags?.properties ?? {};
}

/**
 * The parameters schema agents see and calls are checked against: without
 * the injected flags and the flags the MCP refuses.
 */
export function agentParameters(entry: CommandCatalogEntry): JsonSchema {
  const { parameters } = entry;
  const flags = parameters.properties?.flags;
  if (!flags?.properties) {
    return parameters;
  }
  const kept = Object.fromEntries(
    Object.entries(flagSchemas(entry)).filter(
      ([name]) => !(isInjectedFlag(name) || refusedFlagReason(entry, name)),
    ),
  );
  return {
    ...parameters,
    properties: {
      ...parameters.properties,
      flags: { ...flags, properties: kept },
    },
  };
}

/**
 * The permission class of a call. A `method` command (`sentry api`) takes
 * the class of the HTTP method it sends: reads for GET, HEAD, and OPTIONS,
 * destructive for DELETE, and writes otherwise.
 */
export function callPermission(
  entry: CommandCatalogEntry,
  flags: Record<string, unknown>,
): CallPermission {
  if (entry.permission !== "method") {
    return entry.permission;
  }
  const declared = flagSchemas(entry).method?.default;
  const raw = flags.method ?? declared ?? "GET";
  if (typeof raw !== "string") {
    return "write";
  }
  const method = raw.trim().toUpperCase();
  if (READ_METHODS.has(method)) {
    return "read";
  }
  return method === "DELETE" ? "destructive" : "write";
}
