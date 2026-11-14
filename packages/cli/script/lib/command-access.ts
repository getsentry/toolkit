/**
 * Rules for `check:command-access`: every command declares where agents may
 * run it, and its permission class agrees with the requests it sends.
 *
 * A command's class comes from its Sentry API requests (`apiAccess`), so a
 * declaration is accepted only where those can't settle it:
 * - it also sends a write method outside the Sentry API (DSN ingest, the docs
 *   service), and must say whether that writes;
 * - the analysis can't follow its source, or can't read a request's method;
 * - `method`, for a command whose `--method` flag sets each call's class
 *   (`sentry api`). Its fixed requests may only read, like the org region
 *   lookup `sentry api` makes before the call.
 * Hidden commands never run for agents, so they need no declaration, but a
 * declaration they make is still checked.
 */

import {
  apiAccess,
  COMMAND_EXPOSURES,
  isWriteMethod,
} from "../../src/lib/command-access.js";
import {
  type Command,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../../src/lib/introspect.js";

/** Requests the source analysis found for one command. */
export type CommandRequests = {
  /** Every method found, including requests outside the Sentry API. */
  methods: readonly string[];
  /** Methods of its Sentry API requests; `undefined` when unknown. */
  apiMethods: readonly (string | undefined)[];
};

/** Every command in the tree, hidden routes included, with its first path. */
export function allCommands(
  routeMap: RouteMap,
  prefix: readonly string[] = [],
  found = new Map<Command, string>(),
): Map<Command, string> {
  for (const entry of routeMap.getAllEntries()) {
    const path = [...prefix, entry.name.original];
    if (isRouteMap(entry.target)) {
      allCommands(entry.target, path, found);
    } else if (isCommand(entry.target) && !found.has(entry.target)) {
      found.set(entry.target, `sentry ${path.join(" ")}`);
    }
  }
  return found;
}

/**
 * Problems with one command's exposure and permission. `requests` is
 * undefined when the analysis found no source export for the command.
 */
export function commandAccessProblems(
  command: Command,
  requests: CommandRequests | undefined,
): string[] {
  const problems: string[] = [];
  const exposure = command.__exposure;
  if (!(exposure && COMMAND_EXPOSURES.includes(exposure))) {
    problems.push(
      `declares no exposure (${COMMAND_EXPOSURES.join(", ")}); pass \`exposure\` to its builder`,
    );
  }
  const declared = command.__permission;
  if (command.__destructive) {
    if (declared) {
      problems.push(
        `is destructive, which sets its class; drop \`permission: "${declared}"\``,
      );
    }
    return problems;
  }
  const required = exposure !== "hidden";
  if (!requests) {
    if (!declared && required) {
      problems.push(
        "has no source export the API analysis can follow; declare `permission`",
      );
    }
    return problems;
  }

  const api = apiAccess(requests.apiMethods);
  const apiWrites = unique(
    requests.apiMethods.filter(
      (method): method is string =>
        method !== undefined && isWriteMethod(method),
    ),
  );
  const otherWrites = unique(
    requests.methods.filter(
      (method) =>
        isWriteMethod(method) && !requests.apiMethods.includes(method),
    ),
  );
  if (api === "write") {
    if (declared) {
      problems.push(
        declared === "write"
          ? 'declares `permission: "write"`, which its API requests already give; drop it'
          : `declares \`permission: "${declared}"\`, but it sends ${apiWrites.join("/")} Sentry API requests`,
      );
    }
  } else if (api === "unknown") {
    if (!declared && required) {
      problems.push(
        "sends a Sentry API request whose method the analysis can't read; declare `permission`",
      );
    }
  } else if (declared === "method") {
    if (!command.parameters.flags?.method) {
      problems.push(
        'declares `permission: "method"`, but has no `--method` flag to take the class from',
      );
    } else if (otherWrites.length > 0) {
      problems.push(
        `declares \`permission: "method"\`, but it sends ${otherWrites.join("/")} requests outside the Sentry API; declare \`permission: "read"\` or \`"write"\``,
      );
    }
  } else if (otherWrites.length > 0) {
    if (!declared && required) {
      problems.push(
        `sends ${otherWrites.join("/")} requests outside the Sentry API; declare \`permission: "read"\` or \`"write"\``,
      );
    }
  } else if (declared) {
    problems.push(
      declared === "write"
        ? `declares \`permission: "write"\`, but ${api === "read" ? "its Sentry API requests are read-only" : "it sends no request"}`
        : 'declares `permission: "read"`, which its requests already give; drop it',
    );
  }
  return problems;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
