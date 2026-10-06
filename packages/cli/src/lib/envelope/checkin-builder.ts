/**
 * Constructs cron monitor check-in payloads for `sentry monitor run`.
 *
 * Mirrors the behaviour of the legacy Rust sentry-cli `monitors run` command:
 * an `in_progress` check-in is sent when the wrapped command starts, then an
 * `ok`/`error` check-in (with duration) is sent on completion. The optional
 * `monitor_config` (built from `--schedule` and dependent flags) upserts the
 * monitor and is only attached to the opening `in_progress` check-in.
 *
 * The payloads are `SerializedCheckIn` objects (the snake_case wire format),
 * ready to be wrapped via `createCheckInEnvelope` and serialized for posting
 * to the ingest endpoint.
 */

import type { SerializedCheckIn } from "@sentry/core";
import { ValidationError } from "../errors.js";

/**
 * CLI flags accepted by `sentry monitor run` that affect the monitor config.
 *
 * `schedule` is a crontab string (matching the legacy CLI, which only supports
 * crontab schedules — not intervals). The remaining flags require `schedule`
 * to be set and are forwarded to the monitor's upsert config.
 */
export type CheckInConfigFlags = {
  schedule?: string;
  "check-in-margin"?: number;
  "max-runtime"?: number;
  timezone?: string;
  "failure-issue-threshold"?: number;
  "recovery-threshold"?: number;
};

/** Non-undefined `monitor_config` shape of {@link SerializedCheckIn}. */
type MonitorConfig = NonNullable<SerializedCheckIn["monitor_config"]>;

/**
 * Build a monitor upsert config from `--schedule` and its dependent flags.
 *
 * Returns `undefined` when `--schedule` is not provided (no upsert requested).
 * Throws {@link ValidationError} when a dependent flag (`--check-in-margin`,
 * `--max-runtime`, `--timezone`, `--failure-issue-threshold`,
 * `--recovery-threshold`) is set without `--schedule`, matching the legacy
 * CLI's `requires("schedule")` constraint.
 */
export function buildMonitorConfig(
  flags: CheckInConfigFlags
): MonitorConfig | undefined {
  const dependentFlags: [keyof CheckInConfigFlags, string][] = [
    ["check-in-margin", "--check-in-margin"],
    ["max-runtime", "--max-runtime"],
    ["timezone", "--timezone"],
    ["failure-issue-threshold", "--failure-issue-threshold"],
    ["recovery-threshold", "--recovery-threshold"],
  ];

  if (!flags.schedule) {
    for (const [key, flagName] of dependentFlags) {
      if (flags[key] !== undefined) {
        throw new ValidationError(
          `${flagName} requires --schedule to be set.`,
          "schedule"
        );
      }
    }
    return;
  }

  const config: MonitorConfig = {
    schedule: { type: "crontab", value: flags.schedule },
  };

  if (flags["check-in-margin"] !== undefined) {
    config.checkin_margin = flags["check-in-margin"];
  }
  if (flags["max-runtime"] !== undefined) {
    config.max_runtime = flags["max-runtime"];
  }
  if (flags.timezone !== undefined) {
    config.timezone = flags.timezone;
  }
  if (flags["failure-issue-threshold"] !== undefined) {
    config.failure_issue_threshold = flags["failure-issue-threshold"];
  }
  if (flags["recovery-threshold"] !== undefined) {
    config.recovery_threshold = flags["recovery-threshold"];
  }

  return config;
}

/** Options for {@link buildCheckIn}. */
export type BuildCheckInOptions = {
  /** Shared check-in ID linking the open and close check-ins. */
  checkInId: string;
  /** The monitor's distinct slug. */
  monitorSlug: string;
  /** Check-in status. */
  status: SerializedCheckIn["status"];
  /** Environment name (e.g. "production"). */
  environment?: string;
  /** Duration in seconds — only meaningful for `ok`/`error` (close) check-ins. */
  duration?: number;
  /** Monitor upsert config — only attached to the opening `in_progress` check-in. */
  monitorConfig?: MonitorConfig;
};

/**
 * Assemble a {@link SerializedCheckIn} payload.
 *
 * The caller generates a single `checkInId` (via `uuid4()`) and passes it to
 * both the opening and closing check-ins so Sentry links them. `duration` is
 * only set for close check-ins; `monitorConfig` only for the open one.
 */
export function buildCheckIn(opts: BuildCheckInOptions): SerializedCheckIn {
  const checkIn: SerializedCheckIn = {
    check_in_id: opts.checkInId,
    monitor_slug: opts.monitorSlug,
    status: opts.status,
  };

  if (opts.environment !== undefined) {
    checkIn.environment = opts.environment;
  }
  if (opts.duration !== undefined) {
    checkIn.duration = opts.duration;
  }
  if (opts.monitorConfig !== undefined) {
    checkIn.monitor_config = opts.monitorConfig;
  }

  return checkIn;
}
