/**
 * sentry issue archive (aliased: ignore)
 *
 * Archive (ignore) an issue, suppressing alerts until an optional
 * condition is met. This maps to the "ignored" status in the Sentry API.
 */

import type { SentryContext } from "../../context.js";
import {
  type IgnoreStatusDetails,
  updateIssueStatus,
} from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { ValidationError } from "../../lib/errors.js";
import { formatIssueDetails, muted } from "../../lib/formatters/index.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { parseRelativeParts, UNIT_SECONDS } from "../../lib/time-range.js";
import type { SentryIssue } from "../../types/index.js";
import type { IssueSubstatus } from "../../types/sentry.js";
import { issueIdPositional, resolveIssue } from "./utils.js";

const log = logger.withTag("issue.archive");

const COMMAND = "archive";

// ── --until parser ─────────────────────────────────────────────────

/** Verbose aliases for duration units. Short forms are handled by parseRelativeParts. */
const DURATION_ALIASES: Record<string, string> = {
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  hour: "h",
  hours: "h",
  day: "d",
  days: "d",
  week: "w",
  weeks: "w",
};

/** Verbose aliases for count/user suffixes. */
const COUNT_ALIASES: Record<string, "x" | "u"> = {
  events: "x",
  event: "x",
  users: "u",
  user: "u",
};

/** Matches `<digits><word>` for verbose durations and counts. */
const NUMERIC_WORD_RE = /^(\d+)\s*([a-z]+)$/i;

/** Parsed result of a --until value. */
export type UntilSpec =
  | { kind: "forever" }
  | { kind: "escalating" }
  | { kind: "duration"; minutes: number }
  | { kind: "count"; count: number; windowMinutes?: number }
  | { kind: "users"; users: number; windowMinutes?: number };

/** Try parsing as a short-form duration (e.g. "30m", "1h"). */
function tryShortDuration(raw: string): number | undefined {
  const parts = parseRelativeParts(raw);
  if (!parts) {
    return;
  }
  const secs = UNIT_SECONDS[parts.unit];
  if (secs === undefined) {
    return;
  }
  const totalMinutes = Math.ceil((parts.value * secs) / 60);
  return totalMinutes >= 1 ? totalMinutes : undefined;
}

/** Try parsing as a verbose duration (e.g. "30minutes", "2hours"). */
function tryVerboseDuration(raw: string): number | undefined {
  const m = NUMERIC_WORD_RE.exec(raw);
  if (!m) {
    return;
  }
  const num = Number(m[1]);
  const word = m[2]?.toLowerCase() ?? "";
  const unit = DURATION_ALIASES[word];
  if (!(unit && Number.isInteger(num)) || num < 1) {
    return;
  }
  const secs = UNIT_SECONDS[unit];
  return secs !== undefined ? Math.ceil((num * secs) / 60) : undefined;
}

/** Try parsing as an absolute ISO date, returning delta in minutes from now. */
function tryAbsoluteDate(raw: string): number | undefined {
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) {
    return;
  }
  const deltaMinutes = Math.ceil((ts - Date.now()) / 60_000);
  if (deltaMinutes < 1) {
    throw new ValidationError(
      `--until date must be in the future, got '${raw}'`
    );
  }
  return deltaMinutes;
}

/**
 * Parse a duration string into minutes.
 *
 * Accepts short (`30m`, `1h`, `7d`), verbose (`30minutes`, `2hours`),
 * and ISO date strings resolved relative to now.
 */
function parseDurationMinutes(raw: string): number | undefined {
  return (
    tryShortDuration(raw) ?? tryVerboseDuration(raw) ?? tryAbsoluteDate(raw)
  );
}

/** Try parsing a single-char count suffix: "10x", "10u". */
function tryShortCount(
  raw: string
): { type: "x" | "u"; value: number } | undefined {
  const lastChar = raw.at(-1)?.toLowerCase();
  if (lastChar !== "x" && lastChar !== "u") {
    return;
  }
  const num = Number(raw.slice(0, -1));
  if (Number.isInteger(num) && num >= 1) {
    return { type: lastChar, value: num };
  }
  return;
}

/** Try parsing a verbose count: "10events", "10users". */
function tryVerboseCount(
  raw: string
): { type: "x" | "u"; value: number } | undefined {
  const m = NUMERIC_WORD_RE.exec(raw);
  if (!m) {
    return;
  }
  const num = Number(m[1]);
  const word = m[2]?.toLowerCase() ?? "";
  const suffix = COUNT_ALIASES[word];
  if (suffix && Number.isInteger(num) && num >= 1) {
    return { type: suffix, value: num };
  }
  return;
}

/**
 * Parse a single atom: count (`10x`), user count (`10u`), or duration.
 */
function parseAtom(
  raw: string
):
  | { type: "x" | "u"; value: number }
  | { type: "duration"; minutes: number }
  | undefined {
  const count = tryShortCount(raw) ?? tryVerboseCount(raw);
  if (count) {
    return count;
  }
  const minutes = parseDurationMinutes(raw);
  if (minutes !== undefined) {
    return { type: "duration", minutes };
  }
  return;
}

/** Parse a slash-separated pair like "10x/5m" into a count+window spec. */
function parseSlashPair(raw: string, trimmed: string): UntilSpec {
  const slashIdx = trimmed.indexOf("/");
  const left = trimmed.slice(0, slashIdx).trim();
  const right = trimmed.slice(slashIdx + 1).trim();
  if (!(left && right)) {
    throw new ValidationError(
      `invalid --until format: '${raw}' (expected '<count>/<window>', e.g., '10x/5m')`
    );
  }

  const leftAtom = parseAtom(left);
  const rightAtom = parseAtom(right);

  if (!(leftAtom && rightAtom)) {
    throw new ValidationError(
      `invalid --until format: '${raw}' (expected '<count>/<window>', e.g., '10x/5m')`
    );
  }

  if (leftAtom.type === "duration") {
    throw new ValidationError(
      `invalid --until format: '${raw}' (left of '/' must be a count like '10x' or '10u', not a duration)`
    );
  }
  if (rightAtom.type !== "duration") {
    throw new ValidationError(
      `invalid --until format: '${raw}' (right of '/' must be a duration like '5m' or '2h', not a count)`
    );
  }

  if (leftAtom.type === "x") {
    return {
      kind: "count",
      count: leftAtom.value,
      windowMinutes: rightAtom.minutes,
    };
  }
  return {
    kind: "users",
    users: leftAtom.value,
    windowMinutes: rightAtom.minutes,
  };
}

/** Build the error for unrecognized --until values with usage hints. */
function throwUnrecognizedUntil(raw: string): never {
  throw new ValidationError(
    `invalid --until value: '${raw}'\n\n` +
      "Expected one of:\n" +
      "  forever           Archive forever (same as omitting --until)\n" +
      "  auto             Archive until Sentry detects a spike\n" +
      "  30m, 1h, 7d      Archive for a duration\n" +
      "  2026-05-15        Archive until a date\n" +
      "  10x               Archive until 10 more events\n" +
      "  10u               Archive until 10 more users\n" +
      "  10x/5m            10 events within 5 minutes\n" +
      "  10events/2hours   Same, verbose form"
  );
}

/**
 * Parse the `--until` flag value into a structured spec.
 *
 * Grammar:
 * ```
 * until := "auto" | "escalating" | atom | atom "/" atom
 * atom  := <n>"x" | <n>"u" | <n>"events" | <n>"users"
 *        | <duration> | <iso-date>
 * ```
 */
export function parseUntilSpec(raw: string): UntilSpec {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "forever") {
    return { kind: "forever" };
  }

  if (lower === "auto" || lower === "escalating") {
    return { kind: "escalating" };
  }

  if (trimmed.includes("/")) {
    return parseSlashPair(raw, trimmed);
  }

  const atom = parseAtom(trimmed);
  if (!atom) {
    throwUnrecognizedUntil(raw);
  }

  if (atom.type === "duration") {
    return { kind: "duration", minutes: atom.minutes };
  }
  if (atom.type === "x") {
    return { kind: "count", count: atom.value };
  }
  return { kind: "users", users: atom.value };
}

// ── Command ────────────────────────────────────────────────────────

type ArchiveFlags = {
  readonly json: boolean;
  readonly fields?: string[];
  readonly until?: string;
};

function formatArchived(issue: SentryIssue): string {
  return `${muted("Archived")}\n\n${formatIssueDetails(issue)}`;
}

/** Convert a parsed --until spec into API parameters. */
function specToApiOptions(spec: UntilSpec): {
  substatus: IssueSubstatus;
  statusDetails?: IgnoreStatusDetails;
} {
  switch (spec.kind) {
    case "forever":
      return { substatus: "archived_forever" };
    case "escalating":
      return { substatus: "archived_until_escalating" };
    case "duration":
      return {
        substatus: "archived_until_condition_met",
        statusDetails: { ignoreDuration: spec.minutes },
      };
    case "count":
      return {
        substatus: "archived_until_condition_met",
        statusDetails: {
          ignoreCount: spec.count,
          ...(spec.windowMinutes !== undefined
            ? { ignoreWindow: spec.windowMinutes }
            : {}),
        },
      };
    case "users":
      return {
        substatus: "archived_until_condition_met",
        statusDetails: {
          ignoreUserCount: spec.users,
          ...(spec.windowMinutes !== undefined
            ? { ignoreUserWindow: spec.windowMinutes }
            : {}),
        },
      };
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

export const archiveCommand = buildCommand({
  docs: {
    brief: "Archive (ignore) an issue",
    fullDescription:
      "Archive an issue, suppressing alerts until an optional condition is met.\n\n" +
      "Without --until, the issue is archived forever (equivalent to 'Archive Forever'\n" +
      "in the Sentry UI). Use --until to control when the issue automatically unarchives.\n\n" +
      "Modes:\n" +
      "  (no --until)     Archive forever — fully silenced, no automatic unarchival\n" +
      "  --until auto     Smart detection — unarchives when Sentry detects a spike in\n" +
      "                   event frequency (recommended for most use cases)\n" +
      "  --until <time>   Duration-based — unarchives after a fixed time period\n" +
      "  --until <N>x     Count-based — unarchives after N more events occur\n" +
      "  --until <N>u     User-based — unarchives after N more users are affected\n\n" +
      "Time formats: 30m (minutes), 1h (hours), 7d (days), 1w (weeks),\n" +
      "              or ISO dates like 2026-12-31\n\n" +
      "Compound conditions — add a time window with /:\n" +
      "  --until 10x/5m   Unarchive when 10 events occur within 5 minutes\n" +
      "  --until 5u/1h    Unarchive when 5 users are affected within 1 hour\n\n" +
      "Verbose forms are also accepted: 10events, 10users, 30minutes, 2hours, 7days\n\n" +
      "Examples:\n" +
      "  sentry issue archive CLI-12Z                  # Archive forever\n" +
      "  sentry issue archive CLI-12Z --until auto     # Smart spike detection\n" +
      "  sentry issue archive CLI-12Z -u auto          # Same (short alias)\n" +
      "  sentry issue archive CLI-12Z --until 1h       # Archive for 1 hour\n" +
      "  sentry issue archive CLI-12Z --until 7d       # Archive for 7 days\n" +
      "  sentry issue archive CLI-12Z --until 100x     # Until 100 more events\n" +
      "  sentry issue archive CLI-12Z --until 100x/1h  # 100 events within 1 hour\n" +
      "  sentry issue archive CLI-12Z --until 10u/1d   # 10 users within 1 day\n" +
      "  sentry issue ignore CLI-12Z --until auto      # 'ignore' alias works too",
  },
  output: {
    human: formatArchived,
  },
  parameters: {
    positional: issueIdPositional,
    flags: {
      until: {
        kind: "parsed",
        parse: String,
        brief:
          "Condition for unarchival: forever, auto, 30m, 10x, 10u, 10x/5m, etc.",
        optional: true,
      },
    },
    aliases: { u: "until" },
  },
  async *func(this: SentryContext, flags: ArchiveFlags, issueArg: string) {
    let substatus: IssueSubstatus = "archived_forever";
    let statusDetails: IgnoreStatusDetails | undefined;

    if (flags.until !== undefined) {
      const spec = parseUntilSpec(flags.until);
      const opts = specToApiOptions(spec);
      substatus = opts.substatus;
      statusDetails = opts.statusDetails;
    }

    const { org, issue } = await resolveIssue({
      issueArg,
      cwd: this.cwd,
      command: COMMAND,
    });

    const updated = await updateIssueStatus(issue.id, "ignored", {
      statusDetails,
      substatus,
      orgSlug: org,
    });

    log.debug(`Archived ${updated.shortId}`);
    yield new CommandOutput<SentryIssue>(updated);
  },
});
