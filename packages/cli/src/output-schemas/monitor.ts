/**
 * Output schemas of the `sentry monitor` commands.
 */

import {
  array,
  boolean,
  description,
  looseObject,
  nullable,
  number,
  optional,
  pipe,
  string,
  union,
} from "valibot";
import { orgListItemSchema } from "./org-list.js";

/**
 * Configuration of a cron monitor's expected schedule and thresholds.
 *
 * Returned by the `/organizations/{org}/monitors/` endpoint. The `schedule`
 * field is either a crontab string (when `schedule_type` is `"crontab"`) or a
 * `[value, unit]` tuple (when `"interval"`). Other fields are nullable because
 * the API returns `null` for unset thresholds.
 */
export const MonitorConfigSchema = pipe(
  looseObject({
    schedule_type: optional(
      pipe(string(), description("Schedule type: 'crontab' or 'interval'")),
    ),
    schedule: optional(
      pipe(
        union([string(), array(union([string(), number()]))]),
        description("Crontab string or [value, unit] interval tuple"),
      ),
    ),
    timezone: optional(
      nullable(
        pipe(string(), description("Schedule timezone (tz database string)")),
      ),
    ),
    checkin_margin: optional(
      nullable(
        pipe(
          number(),
          description("Allowed minutes after the expected check-in time"),
        ),
      ),
    ),
    max_runtime: optional(
      nullable(
        pipe(
          number(),
          description("Allowed minutes a check-in may run before timing out"),
        ),
      ),
    ),
    failure_issue_threshold: optional(
      nullable(
        pipe(
          number(),
          description("Consecutive failures before an issue is created"),
        ),
      ),
    ),
    recovery_threshold: optional(
      nullable(
        pipe(
          number(),
          description("Consecutive successes before an issue is resolved"),
        ),
      ),
    ),
  }),
  description("Monitor configuration"),
);

/**
 * A cron monitor configured in a Sentry organization.
 *
 * Cron monitors are not modeled by the `@sentry/api` types this project
 * re-exports, so this is a hand-written internal schema (Pattern B). Core
 * identifiers (id, slug, name, status) are required; richer fields are widened
 * to optional and `.passthrough()` preserves any unmodeled API fields.
 */
export const SentryMonitorSchema = pipe(
  looseObject({
    id: pipe(string(), description("Monitor ID")),
    slug: pipe(string(), description("Monitor slug")),
    name: pipe(string(), description("Monitor name")),
    status: pipe(
      string(),
      description("Monitor status (e.g. active, disabled)"),
    ),
    isMuted: optional(
      pipe(boolean(), description("Whether the monitor is muted")),
    ),
    config: optional(
      pipe(MonitorConfigSchema, description("Schedule configuration")),
    ),
    dateCreated: optional(
      pipe(string(), description("Creation date (ISO 8601)")),
    ),
    project: optional(
      pipe(
        looseObject({
          id: optional(pipe(string(), description("Project ID"))),
          slug: optional(pipe(string(), description("Project slug"))),
          name: optional(pipe(string(), description("Project name"))),
        }),
        description("Owning project"),
      ),
    ),
  }),
  description("Sentry monitor"),
);

/** JSON output of `monitor list`: a cron monitor and the org it came from. */
export const MonitorListItemSchema = orgListItemSchema(SentryMonitorSchema);
