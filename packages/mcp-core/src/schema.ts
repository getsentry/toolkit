/**
 * Reusable Zod parameter schemas for MCP tools.
 *
 * Shared validation schemas used across tool definitions to ensure consistent
 * parameter handling and validation. Schemas apply minimal normalization
 * (e.g., trim) and LLM-friendly descriptions.
 */
import { z } from "zod";
import { SENTRY_GUIDES } from "./constants";
import { validateResourceId, validateSlug } from "./utils/slug-validation";

// Sentry slug lookups can be exact and case-sensitive on legacy instances.
// Preserve caller casing for resource slugs; only trim and validate shape.
export const ParamOrganizationSlug = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe(
    "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
  );

export const ParamTeamSlug = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe(
    "The team's slug. You can find a list of existing teams in an organization with the Sentry tool `find_teams`.",
  );

export const ParamProjectSlug = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe(
    "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
  );

export const ParamProjectSlugOrAll = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe(
    "The project's slug, or exact lowercase `all` when a tool supports all-projects scope. Other casing is treated as a project slug.",
  );

export const ParamSearchQuery = z
  .string()
  .trim()
  .describe(
    "Search query to filter results by name or slug. Use this to narrow down results when there are many items.",
  );

export const ParamCursor = z
  .string()
  .describe(
    "Pagination cursor from a previous call's nextCursor. Reuse it with the same filters and scope to fetch the next page.",
  );

export const ParamIssueShortId = z
  .string()
  .toUpperCase()
  .trim()
  .describe("The Issue ID. e.g. `PROJECT-1Z43`");

export const ParamPackageNames = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(10)
  .describe(
    "Exact, case-sensitive package names recorded with a specific event (1–10 names, up to 256 characters each). Requires an event lookup. Only selected package versions are added; versions longer than 256 characters are truncated.",
  );

export const ParamIssueUrl = z
  .string()
  .url()
  .trim()
  .describe(
    "The URL of the issue. e.g. https://my-organization.sentry.io/issues/PROJECT-1Z43",
  );

export const ParamExternalIssueUrl = z
  .string()
  .url()
  .trim()
  .describe(
    "URL of the existing external ticket or GitHub pull request. For Sentry Apps, use the canonical issue URL shown by the provider.",
  );

export const ParamReplayId = z
  .string()
  .trim()
  .superRefine(validateResourceId)
  .describe("The replay ID. e.g. `7e07485f-12f9-416b-8b14-26260799b51f`");

export const ParamReplayUrl = z
  .string()
  .url()
  .trim()
  .describe(
    "The URL of the replay. e.g. https://my-organization.sentry.io/explore/replays/7e07485f-12f9-416b-8b14-26260799b51f/",
  );

export const ParamTraceId = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{32}$/,
    "Trace ID must be a 32-character hexadecimal string",
  )
  .describe("The trace ID. e.g. `a4d1aae7216b47ff8117cf4e09ce9d0a`");

export const ParamSpanId = z
  .string()
  .trim()
  .min(1)
  .describe(
    "The span ID within a trace. Use this with a trace resource to focus on a specific span.",
  );

export const ParamPlatform = z
  .string()
  .toLowerCase()
  .trim()
  .describe(
    "The platform for the project. e.g., python, javascript, react, etc.",
  );

export const ParamTransaction = z
  .string()
  .trim()
  .describe("The transaction name. Also known as the endpoint, or route name.");

export const ParamQuery = z
  .string()
  .trim()
  .describe(
    `The search query to apply. Use the \`help(subject="query_syntax")\` tool to get more information about the query syntax rather than guessing.`,
  );

/**
 * Relative time window parameter for Sentry API queries.
 *
 * Maps to the `statsPeriod` URL parameter in Sentry's API, which controls the
 * search time window (i.e., which records are returned). This is distinct from
 * `groupStatsPeriod`, which only affects sparkline data in the serializer.
 *
 * Tools apply their own `.default()`, `.optional()`, or `.nullable()` on top.
 */
export const ParamPeriod = z
  .string()
  .trim()
  .regex(
    /^\d+[hdw]$/,
    "Period must be a relative time window like `24h`, `7d`, `14d`, `30d`, or `90d`.",
  )
  .describe(
    "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
  );

/**
 * Region URL parameter for Sentry API requests.
 *
 * Handles region-specific URLs for Sentry's Cloud Service while gracefully
 * supporting self-hosted Sentry installations that may return empty regionUrl values.
 * This schema accepts both valid URLs and empty strings to ensure compatibility
 * across different Sentry deployment types.
 */
export const ParamRegionUrl = z
  .string()
  .trim()
  .refine((value) => !value || z.string().url().safeParse(value).success, {
    message: "Must be a valid URL or empty string (for self-hosted Sentry)",
  })
  .describe(
    "The region URL for the organization you're querying, if known. " +
      "For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. " +
      "For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. " +
      "You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
  );

export const ParamIssueStatus = z
  .enum(["resolved", "resolvedInNextRelease", "unresolved", "ignored"])
  .describe(
    "The new status for the issue. Valid values are 'resolved', 'resolvedInNextRelease', 'unresolved', and 'ignored'.",
  );

export const ParamIssueIgnoreMode = z
  .enum([
    "untilEscalating",
    "forever",
    "forDuration",
    "untilOccurrenceCount",
    "untilUserCount",
  ])
  .describe(
    "How ignored issues should behave. Use 'untilEscalating' to match the Sentry UI default, 'forever' for a permanent ignore, 'forDuration' with ignoreDurationMinutes, 'untilOccurrenceCount' with ignoreCount and optional ignoreWindowMinutes, or 'untilUserCount' with ignoreUserCount and optional ignoreUserWindowMinutes.",
  );

export const ParamAssignedTo = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .describe(
    "The assignee in format 'user:ID' or 'team:ID_OR_SLUG' where ID is numeric. Pass null to unassign the issue. Example: 'user:123456', 'team:789', or 'team:my-team-slug'. Use `execute_sentry_tool(name='whoami', arguments={})` to find your user ID.",
  );

export const ParamIgnoreDurationMinutes = z
  .number()
  .int()
  .positive()
  .describe(
    "How many minutes to ignore the issue when ignoreMode is 'forDuration'.",
  );

export const ParamIgnoreCount = z
  .number()
  .int()
  .positive()
  .describe(
    "How many times the issue must occur before it stops being ignored when ignoreMode is 'untilOccurrenceCount'.",
  );

export const ParamIgnoreWindowMinutes = z
  .number()
  .int()
  .positive()
  .max(7 * 24 * 60)
  .describe(
    "Optional time window in minutes for ignoreCount. If omitted, Sentry counts all future occurrences.",
  );

export const ParamIgnoreUserCount = z
  .number()
  .int()
  .positive()
  .describe(
    "How many users must be affected before the issue stops being ignored when ignoreMode is 'untilUserCount'.",
  );

export const ParamIgnoreUserWindowMinutes = z
  .number()
  .int()
  .positive()
  .max(7 * 24 * 60)
  .describe(
    "Optional time window in minutes for ignoreUserCount. If omitted, Sentry counts all future affected users.",
  );

export const ParamReason = z
  .string()
  .overwrite((s) => s.replace(/\0/g, ""))
  .trim()
  .min(1)
  .describe(
    "Optional reason for taking this action. When provided, it will be posted as a comment on the issue's activity feed.",
  );

export const ParamSentryGuide = z
  .enum(SENTRY_GUIDES)
  .describe(
    "Optional guide filter to limit search results to specific documentation sections. " +
      "Use either a platform (e.g., 'javascript', 'python') or platform/guide combination (e.g., 'javascript/nextjs', 'python/django').",
  );

export const ParamEventId = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{32}$/,
    "Event ID must be a 32-character hexadecimal string",
  )
  .describe("The ID of the event. e.g. `c49541c747cb4d8aa3efb70ca5aba243`");

/**
 * Issue-scoped event selector used by tools that can target either a concrete
 * event or the issue's latest event.
 */
export const ParamEventIdOrLatest = z
  .union([z.literal("latest"), ParamEventId])
  .default("latest")
  .describe("The event ID for the issue, or `latest`. Defaults to `latest`.");

export const ParamAttachmentId = z
  .string()
  .trim()
  .superRefine(validateResourceId)
  .describe("The ID of the attachment to download.");
