/**
 * DSN resolution for `sentry event send`.
 *
 * Ingest still authenticates with a DSN. The first positional may be a DSN,
 * project, or org/project target. Without one, the command falls back to
 * `SENTRY_DSN` and project-directory detection.
 */

import { isAbsolute } from "node:path";
import { getProjectKeys } from "../api/projects.js";
import { getAuthConfig } from "../db/auth.js";
import { ConfigError } from "../errors.js";
import { logger } from "../logger.js";
import { resolveProjectBoundFromArg } from "../resolve-target.js";
import { resolveIngestDsn } from "./transport.js";

const log = logger.withTag("event.send");
const DSN_PREFIX_RE = /^https?:\/\//i;

/** Usage example shown on missing-DSN errors. */
export const EVENT_SEND_DSN_HINT = "sentry event send <dsn> -m 'My message'";

/** User-facing missing-DSN message covering every resolution source. */
export const EVENT_SEND_NO_DSN_MESSAGE =
  "No DSN found. Pass <dsn>, <project>, or <org>/<project> as the first argument, set SENTRY_DSN, or run from a project where a DSN can be detected.";

export type EventSendTarget =
  | { kind: "dsn"; dsn: string }
  | { kind: "project"; target: string };

/**
 * Peel an optional DSN/project target from the leading positional.
 *
 * Target-shaped values take precedence. Event files should use an explicit
 * path (`./event`, `/tmp/event`) or a dotted filename (`event.json`).
 *
 * @param files - Positional arguments as received by `event send`.
 * @returns The optional target and the remaining file arguments.
 */
export function peelEventSendTarget(files: readonly string[]): {
  target: EventSendTarget | undefined;
  files: string[];
} {
  const first = files[0];
  if (!first) {
    return { target: undefined, files: [...files] };
  }
  if (looksLikeDsn(first)) {
    return {
      target: { kind: "dsn", dsn: first },
      files: files.slice(1),
    };
  }
  if (looksLikeFileArgument(first)) {
    return { target: undefined, files: [...files] };
  }
  return {
    target: { kind: "project", target: first },
    files: files.slice(1),
  };
}

/**
 * Resolve the ingest DSN for `event send`.
 *
 * Priority: positional DSN/project target → `SENTRY_DSN` → project scan.
 *
 * @param cwd - Directory to scan when explicit sources are absent.
 * @param target - Optional positional DSN or project target.
 * @returns The resolved ingest DSN.
 * @throws {ConfigError} When no DSN can be resolved.
 */
export async function resolveEventSendDsn(
  cwd: string,
  target: EventSendTarget | undefined
): Promise<string> {
  if (target?.kind === "dsn") {
    return target.dsn.trim();
  }
  if (target?.kind === "project") {
    return dsnFromProjectTarget(target.target, cwd);
  }
  const scanned = await resolveIngestDsn({}, cwd);
  if (scanned) {
    return scanned;
  }
  throw new ConfigError(EVENT_SEND_NO_DSN_MESSAGE, EVENT_SEND_DSN_HINT);
}

function looksLikeDsn(value: string): boolean {
  return DSN_PREFIX_RE.test(value);
}

/**
 * Distinguish explicit file paths from project targets.
 * Dots are not valid in Sentry project slugs, so dotted final segments are
 * files. Prefix extensionless relative files with `./`.
 */
function looksLikeFileArgument(value: string): boolean {
  if (value.startsWith(".") || isAbsolute(value)) {
    return true;
  }
  const slashCount = value.split("/").length - 1;
  if (slashCount > 1) {
    return true;
  }
  const finalSegment = value.slice(value.lastIndexOf("/") + 1);
  return finalSegment.includes(".");
}

/**
 * Resolve a project target and look up its sole active public DSN.
 *
 * A refreshable OAuth session remains usable after its access token expires.
 * The session is used only for the key lookup; ingest authenticates with the
 * resulting DSN.
 */
async function dsnFromProjectTarget(
  target: string,
  cwd: string
): Promise<string> {
  if (!getAuthConfig()) {
    throw new ConfigError(
      `Cannot resolve project '${target}' without a logged-in session. Pass the DSN as the first argument or run sentry auth login.`,
      "sentry auth login"
    );
  }
  const { org, project } = await resolveProjectBoundFromArg(
    target,
    cwd,
    "event send"
  );
  const keys = await getProjectKeys(org, project, { status: "active" });
  const activeDsns = [
    ...new Set(
      keys
        .filter((key) => key.isActive)
        .map((key) => key.dsn.public)
        .filter(Boolean)
    ),
  ];
  if (activeDsns.length > 1) {
    throw new ConfigError(
      `Project ${org}/${project} has multiple active DSNs. Pass the desired DSN as the first argument.`,
      EVENT_SEND_DSN_HINT
    );
  }
  const dsn = activeDsns[0];
  if (!dsn) {
    throw new ConfigError(
      `No active DSN found for ${org}/${project}. Pass a DSN as the first argument.`,
      EVENT_SEND_DSN_HINT
    );
  }
  log.debug(`Using DSN from ${org}/${project} client keys`);
  return dsn;
}
