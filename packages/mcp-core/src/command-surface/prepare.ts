/**
 * Everything a command tool call is checked against before it runs:
 * exposure, refused flags, the parameter schema, read-only sessions, and the
 * session's constraints.
 */

import { UserInputError } from "../errors";
import type { CommandCatalogEntry } from "../command-catalog";
import type { ServerContext } from "../types";
import {
  API_WRITE_SKILLS,
  agentParameters,
  type CommandRuntime,
  callPermission,
  commandName,
  commandSegments,
  isInjectedFlag,
  refusedFlagReason,
} from "./commands";
import { pinConstraints, URL_PATTERN } from "./constraints";
import type { CommandCall } from "./types";
import { validateJsonSchema } from "./validate";

/**
 * Pagination keywords that need the CLI's stored cursor stack, with their
 * aliases (`last`, `previous`).
 */
const CURSOR_KEYWORDS = new Set(["next", "prev", "last", "previous"]);

export type SessionPolicy = {
  runtime: CommandRuntime;
  /** Refuse write and destructive calls (`--read-only`, hosted API Read). */
  readOnly: boolean;
};

/**
 * Why the session cannot run `entry` at all, or `undefined` when it can.
 * Per-call reasons (a refused flag, the method of `sentry api`) are checked
 * by {@link prepareCommandCall}.
 */
export function unavailableReason(
  entry: CommandCatalogEntry,
  policy: SessionPolicy,
): string | undefined {
  if (entry.exposure !== "exposed") {
    return "it needs the local machine";
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

/** The arguments of a command tool call, as its input schema accepts them. */
type CommandParams = {
  positional?: string[] | null;
  flags?: unknown;
};

/** Drop the injected `json` flag, and refuse flags the MCP does not pass through. */
function readFlags(
  entry: CommandCatalogEntry,
  rawFlags: unknown,
): Record<string, unknown> {
  if (rawFlags === undefined || rawFlags === null) {
    return {};
  }
  if (typeof rawFlags !== "object" || Array.isArray(rawFlags)) {
    throw new UserInputError(
      `Invalid arguments for \`${commandName(entry)}\`:\n- flags: must be an object`,
    );
  }
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
 * Check a command tool call and build the call to run.
 *
 * @throws {UserInputError} When the command is unavailable, the params fail
 *   the schema, a read-only session gets a write call, or a target is
 *   outside the session's constraints
 */
export function prepareCommandCall({
  entry,
  params,
  policy,
  context,
}: {
  entry: CommandCatalogEntry;
  params: CommandParams | undefined;
  policy: SessionPolicy;
  context: ServerContext;
}): CommandCall {
  const name = commandName(entry);
  const unavailable = unavailableReason(entry, policy);
  if (unavailable) {
    throw refuse(entry, unavailable);
  }

  // `null` (some clients send it for an unset field) means none.
  const positional = params?.positional ?? undefined;
  const flags = readFlags(entry, params?.flags);
  const errors = validateJsonSchema(
    agentParameters(entry),
    positional === undefined ? { flags } : { positional, flags },
  );
  if (errors.length > 0) {
    throw new UserInputError(
      `Invalid arguments for \`${name}\`:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  const permission = callPermission(entry, flags);
  if (policy.readOnly && permission !== "read") {
    throw refuse(
      entry,
      `this session is read-only, and this call is a ${permission} call`,
    );
  }
  // Write tools are listed only for their skills; `sentry api` is listed for
  // every skill, so its writes are checked here.
  const granted = context.grantedSkills;
  if (
    entry.permission === "method" &&
    permission !== "read" &&
    granted &&
    !API_WRITE_SKILLS.some((skill) => granted.has(skill))
  ) {
    throw refuse(
      entry,
      `this ${permission} call needs the ${API_WRITE_SKILLS.join(" or ")} skill`,
    );
  }

  // `sentry api` sends an absolute URL to that URL's own host.
  const endpoint = positional?.at(0);
  if (
    entry.permission === "method" &&
    endpoint !== undefined &&
    // The CLI drops whitespace and line breaks around an endpoint first.
    URL_PATTERN.test(endpoint.replace(/\s+/g, ""))
  ) {
    throw refuse(
      entry,
      "an absolute URL fetches a host the caller picks. Pass the path relative to /api/0/ instead, such as `organizations/<org>/issues/`",
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
