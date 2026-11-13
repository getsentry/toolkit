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

/** Recovery hint for a missing organization the server could not default. */
export const MISSING_ORGANIZATION_SLUG_HINT =
  "Required. Call `find_organizations()` to list your organizations, then retry with `organizationSlug` set to one of their slugs.";

// Sentry slug lookups can be exact and case-sensitive on legacy instances.
// Preserve caller casing for resource slugs; only trim and validate shape.
export const ParamOrganizationSlug = z
  .string({
    // Tool registration makes a required slug optional and defaults it
    // (see applyDefaultOrganization), but a null slug, or one inside a nested
    // schema, still fails here, and this is the recovery hint it gets.
    error: (issue) =>
      issue.input == null ? MISSING_ORGANIZATION_SLUG_HINT : undefined,
  })
  .trim()
  .superRefine(validateSlug)
  .describe("The organization slug.");

export const ParamTeamSlug = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe("The team slug.");

export const ParamProjectSlug = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe("The project slug.");

export const ParamProjectSlugOrAll = z
  .string()
  .trim()
  .superRefine(validateSlug)
  .describe("The project slug, or lowercase `all` for every project.");

export const ParamSearchQuery = z
  .string()
  .trim()
  .describe("Filter by name or slug.");

export const ParamCursor = z
  .string()
  .describe(
    "`nextCursor` from the previous page. Keep the other inputs the same.",
  );

// Shared by every read tool that calls the Sentry API, so keep it short: it
// ships in the schema of each one.
export const ParamFresh = z
  .boolean()
  .optional()
  .describe("Bypass cached reads.");

export const ParamIssueShortId = z
  .string()
  .toUpperCase()
  .trim()
  .describe("The issue short ID, e.g. `PROJECT-1Z43`.");

export const ParamPackageNames = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(10)
  .describe(
    "Exact, case-sensitive package names recorded on the event. Returns their versions.",
  );

export const ParamIssueUrl = z
  .string()
  .url()
  .trim()
  .describe("The issue URL, e.g. https://my-org.sentry.io/issues/PROJECT-1Z43");

export const ParamExternalIssueUrl = z
  .string()
  .url()
  .trim()
  .describe(
    "URL of the existing external ticket or GitHub pull request. For Sentry Apps, the canonical issue URL from the provider.",
  );

export const ParamReplayId = z
  .string()
  .trim()
  .superRefine(validateResourceId)
  .describe("The replay ID, e.g. `7e07485f-12f9-416b-8b14-26260799b51f`.");

export const ParamReplayUrl = z
  .string()
  .url()
  .trim()
  .describe("The replay URL.");

export const ParamTraceId = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{32}$/,
    "Trace ID must be a 32-character hexadecimal string",
  )
  .describe("The 32-character hex trace ID.");

export const ParamSpanId = z
  .string()
  .trim()
  .min(1)
  .describe("A span ID in the trace.");

// Platform names agents sent in production that Sentry rejects with
// `{"platform":["Invalid platform"]}`, mapped to the ID Sentry accepts. Every
// value must be in GETTING_STARTED_DOCS_PLATFORMS in getsentry/sentry
// src/sentry/models/project.py (checked against master on 2026-11-04).
const PLATFORM_ALIASES: ReadonlyMap<string, string> = new Map([
  ["react", "javascript-react"],
  ["cocoa", "apple"],
  ["cocoa-ios", "apple-ios"],
  ["csharp", "dotnet"],
  ["javascript-cloudflare", "node-cloudflare-workers"],
  ["javascript-cloudflare-workers", "node-cloudflare-workers"],
]);

export const ParamPlatform = z
  .string()
  .toLowerCase()
  .trim()
  .overwrite((platform) => PLATFORM_ALIASES.get(platform) ?? platform)
  .describe(
    "Sentry platform ID, e.g. `javascript-react`, `javascript-nextjs`, `node`, `python-django`, `apple-ios`, `android`, `dotnet`. Omit if unsure.",
  );

export const ParamTransaction = z
  .string()
  .trim()
  .describe("The transaction name: the endpoint or route.");

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
    /^\d+[mhdw]$/,
    "Period must be a relative time window like `30m` (minutes), `1h`, `24h`, `7d`, or `90d`.",
  )
  .describe("Relative time window, e.g. `30m`, `24h`, `7d`, `90d`.");

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
    "The organization's region URL from `find_organizations`, e.g. `https://us.sentry.io`. Omit for self-hosted Sentry.",
  );

export const ParamIssueStatus = z
  .enum(["resolved", "resolvedInNextRelease", "unresolved", "ignored"])
  .describe("The new issue status.");

export const ParamIssuePriority = z
  .enum(["low", "medium", "high"])
  .describe(
    "The new issue priority. Setting it stops Sentry from changing it automatically.",
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
    "When an ignored issue comes back. `untilEscalating` is the Sentry UI default. The `forDuration`, `untilOccurrenceCount`, and `untilUserCount` modes need their matching ignore fields.",
  );

export const ParamAssignedTo = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .describe(
    "`user:<id>`, `team:<id>`, or `team:<slug>`. `null` unassigns. `whoami` returns your user ID.",
  );

export const ParamIgnoreDurationMinutes = z
  .number()
  .int()
  .positive()
  .describe("Minutes to ignore the issue. Only with ignoreMode `forDuration`.");

export const ParamIgnoreCount = z
  .number()
  .int()
  .positive()
  .describe(
    "Occurrences before the issue stops being ignored. Only with ignoreMode `untilOccurrenceCount`.",
  );

export const ParamIgnoreWindowMinutes = z
  .number()
  .int()
  .positive()
  .max(7 * 24 * 60)
  .describe(
    "Window in minutes for ignoreCount. Omit to count all occurrences.",
  );

export const ParamIgnoreUserCount = z
  .number()
  .int()
  .positive()
  .describe(
    "Affected users before the issue stops being ignored. Only with ignoreMode `untilUserCount`.",
  );

export const ParamIgnoreUserWindowMinutes = z
  .number()
  .int()
  .positive()
  .max(7 * 24 * 60)
  .describe("Window in minutes for ignoreUserCount. Omit to count all users.");

export const ParamInRelease = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Release version that fixes the issue. Requires status `resolved`. Events from newer releases reopen it as a regression.",
  );

export const ParamInCommit = z
  .string()
  .trim()
  .min(1)
  .describe(
    "SHA of a commit Sentry knows that fixes the issue. Requires status `resolved` and inCommitRepository.",
  );

export const ParamInCommitRepository = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Repository of inCommit as Sentry names it, e.g. `getsentry/sentry`.",
  );

export const ParamReason = z
  .string()
  .overwrite((s) => s.replace(/\0/g, ""))
  .trim()
  .min(1)
  .describe("Posted as a comment on the issue's activity.");

export const ParamSentryGuide = z
  .enum(SENTRY_GUIDES)
  .describe(
    "Limit results to a platform (`python`) or platform/guide (`javascript/nextjs`).",
  );

export const ParamEventId = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{32}$/,
    "Event ID must be a 32-character hexadecimal string",
  )
  .describe("The 32-character hex event ID.");

/**
 * Issue-scoped event selector used by tools that can target either a concrete
 * event or the issue's latest event.
 */
export const ParamEventIdOrLatest = z
  .union([z.literal("latest"), ParamEventId])
  .default("latest")
  .describe("An event ID in the issue, or `latest`.");

export const ParamAttachmentId = z
  .string()
  .trim()
  .superRefine(validateResourceId)
  .describe("The attachment ID.");
