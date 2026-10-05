/**
 * Constructs a Sentry Event from `sentry event send` CLI flags.
 *
 * Mirrors the behaviour of the old Rust sentry-cli `send-event` command
 * tags/extras as KEY:VALUE pairs, user fields with known routing
 * (id, email, ip_address, username → top-level; everything else → user.data),
 * environment variables optionally included as `extra.environ`.
 */

import { readFile, stat } from "node:fs/promises";
import type { Breadcrumb, Event, SeverityLevel, User } from "@sentry/core";
import { uuid4 } from "@sentry/core";
import { ValidationError } from "../errors.js";

/** CLI flags accepted by `sentry event send`. */
export type SendEventFlags = {
  message?: string[];
  "message-arg"?: string[];
  level?: string;
  release?: string;
  dist?: string;
  env?: string;
  platform?: string;
  tag?: string[];
  extra?: string[];
  user?: string[];
  fingerprint?: string[];
  timestamp?: string;
  logfile?: string;
  "with-categories"?: boolean;
  "no-environ"?: boolean;
};

const KNOWN_USER_FIELDS = new Set(["id", "email", "ip_address", "username"]);

/**
 * Parse a single KEY:VALUE (or KEY=VALUE) string, splitting on the first
 * `:` or `=`, whichever appears first.
 *
 * Values may contain further separators (e.g. `url:https://example.com`).
 * Throws ValidationError if the format is wrong.
 */
export function parseKeyValue(pair: string): [string, string] {
  const colonIdx = pair.indexOf(":");
  const equalsIdx = pair.indexOf("=");
  const found = [colonIdx, equalsIdx].filter((i) => i >= 0);
  const idx = found.length > 0 ? Math.min(...found) : -1;
  if (idx <= 0) {
    throw new ValidationError(
      `Expected KEY:VALUE format, got: ${JSON.stringify(pair)}`,
      "tag/extra"
    );
  }
  return [pair.slice(0, idx), pair.slice(idx + 1)];
}

/**
 * Parse an array of KEY:VALUE strings into a plain object.
 */
function parseKeyValuePairs(
  pairs: string[] | undefined
): Record<string, string> {
  if (!pairs?.length) {
    return {};
  }
  return Object.fromEntries(pairs.map(parseKeyValue));
}

/**
 * Parse `--user` KEY:VALUE pairs into a Sentry User object.
 *
 * Known fields (id, email, ip_address, username) map directly to User
 * properties. Unknown keys go into `user.data` for custom attributes.
 */
export function parseUserFields(pairs: string[]): User {
  const user: User & { data?: Record<string, string> } = {};
  for (const pair of pairs) {
    const [key, value] = parseKeyValue(pair);
    if (KNOWN_USER_FIELDS.has(key)) {
      (user as Record<string, string>)[key] = value;
    } else {
      user.data ??= {};
      user.data[key] = value;
    }
  }
  return user;
}

/**
 * Parse a timestamp string into a Unix epoch float (seconds).
 *
 * Accepts: Unix integer/float, ISO 8601, RFC 2822.
 * Returns undefined for falsy input (caller uses Date.now()).
 * Throws ValidationError for non-empty strings that cannot be parsed.
 */
function parseTimestamp(ts: string | undefined): number | undefined {
  if (!ts || ts.trim().length === 0) {
    return;
  }
  // Unix numeric
  const num = Number(ts);
  if (Number.isFinite(num)) {
    return num;
  }
  // ISO / RFC 2822
  const parsed = Date.parse(ts);
  if (!Number.isNaN(parsed)) {
    return parsed / 1000;
  }
  throw new ValidationError(
    `Invalid --timestamp value: '${ts}'. Use a Unix epoch number, ISO 8601, or RFC 2822 date.`,
    "timestamp"
  );
}

/** Maximum number of breadcrumbs to attach from a logfile. */
const MAX_BREADCRUMBS = 100;

/** Regex to split a log line into `CATEGORY: message` when --with-categories is set. */
const CATEGORY_RE = /^([^:]+):\s*(.*)$/;

/**
 * Parse a logfile into an array of breadcrumbs.
 *
 * Reads the file line by line, optionally parsing `CATEGORY: message`
 * prefixes. Uses the file's mtime as the breadcrumb timestamp (matching
 * the old sentry-cli behaviour). Keeps the last {@link MAX_BREADCRUMBS}
 * entries.
 */
export async function parseBreadcrumbsFromLogfile(
  logfilePath: string,
  withCategories: boolean
): Promise<Breadcrumb[]> {
  let content: string;
  let mtimeSeconds: number;
  try {
    content = await readFile(logfilePath, "utf-8");
    const fileStat = await stat(logfilePath);
    mtimeSeconds = fileStat.mtimeMs / 1000;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(`Logfile not found: ${logfilePath}`, "logfile");
    }
    throw new ValidationError(
      `Cannot read logfile ${logfilePath}: ${(err as Error).message}`,
      "logfile"
    );
  }

  const lines = content.split("\n").filter((l) => l.length > 0);
  const breadcrumbs: Breadcrumb[] = lines.map((line) => {
    if (withCategories) {
      const match = CATEGORY_RE.exec(line);
      if (match) {
        return {
          timestamp: mtimeSeconds,
          category: (match[1] ?? "log").trim(),
          message: (match[2] ?? "").trim(),
        };
      }
    }
    return {
      timestamp: mtimeSeconds,
      category: "log",
      message: line,
    };
  });

  // Keep only the last MAX_BREADCRUMBS entries
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    return breadcrumbs.slice(-MAX_BREADCRUMBS);
  }
  return breadcrumbs;
}

/**
 * Build a Sentry Event from CLI flag values.
 *
 * The returned object is ready to be wrapped in an EventEnvelope and
 * serialized for posting to the ingest endpoint.
 */
export async function buildEventFromFlags(
  flags: SendEventFlags
): Promise<Event> {
  const tags = parseKeyValuePairs(flags.tag);
  // environ goes first so explicit --extra environ:val overrides it
  const extra: Record<string, unknown> = {
    ...(flags["no-environ"] ? {} : { environ: process.env }),
    ...parseKeyValuePairs(flags.extra),
  };

  return {
    event_id: uuid4(),
    level: (flags.level ?? "error") as SeverityLevel,
    platform: flags.platform ?? "other",
    timestamp: parseTimestamp(flags.timestamp) ?? Date.now() / 1000,
    release: flags.release,
    dist: flags.dist,
    environment: flags.env,
    logentry:
      flags.message && flags.message.length > 0
        ? {
            message: flags.message.join("\n"),
            ...(flags["message-arg"]?.length
              ? { params: flags["message-arg"] as unknown[] }
              : {}),
          }
        : undefined,
    tags: Object.keys(tags).length > 0 ? tags : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    user: flags.user?.length ? parseUserFields(flags.user) : undefined,
    fingerprint: flags.fingerprint,
    breadcrumbs: flags.logfile
      ? await parseBreadcrumbsFromLogfile(
          flags.logfile,
          flags["with-categories"] ?? false
        )
      : undefined,
  };
}
