/**
 * Unified URL parsing utilities for Sentry resources.
 *
 * Parses Sentry URLs to identify resource types and extract relevant identifiers.
 * Supports issue, trace, profile, event, replay, monitor, and dashboard URLs across different
 * Sentry URL formats (subdomain, path-based organization, self-hosted).
 */

import { UserInputError } from "../errors";

/**
 * Types of Sentry resources that can be identified from URLs.
 */
export type SentryResourceType =
  | "issue"
  | "trace"
  | "profile"
  | "ai_conversation"
  | "event"
  | "replay"
  | "monitor"
  | "release"
  | "snapshot"
  | "dashboard"
  | "unknown";

/**
 * Result of parsing a Sentry URL.
 * Contains the resource type and all relevant identifiers extracted from the URL.
 */
export interface ParsedSentryUrl {
  /** The type of resource identified in the URL */
  type: SentryResourceType;
  /** Organization slug extracted from URL (subdomain or path) */
  organizationSlug: string;
  /** Issue ID (for issue and event URLs) */
  issueId?: string;
  /** Trace ID (for trace URLs) */
  traceId?: string;
  /** AI conversation ID (for Explore conversation URLs) */
  conversationId?: string;
  /** Span ID (for trace URLs with span focus, from query param) */
  spanId?: string;
  /** Event ID (for event URLs) */
  eventId?: string;
  /** Project slug or numeric ID (for profile, monitor, and AI conversation URLs) */
  projectSlugOrId?: string;
  /** Transaction profile ID from profile flamegraph URLs */
  profileId?: string;
  /** Profiler ID (for profile URLs, from query param) */
  profilerId?: string;
  /** Start timestamp (for profile URLs, from query param) */
  start?: string;
  /** End timestamp (for profile URLs, from query param) */
  end?: string;
  /** Replay ID/slug (for replay URLs) */
  replayId?: string;
  /** Monitor slug (for cron monitor URLs) */
  monitorSlug?: string;
  /** Release version (for release URLs) */
  releaseVersion?: string;
  /** Transaction name (from query param in performance URLs) */
  transaction?: string;
  /** Snapshot ID (for preprod snapshot URLs) */
  snapshotId?: string;
  /** Selected snapshot image name (from ?selectedSnapshot= query param) */
  selectedSnapshot?: string;
  /** Dashboard numeric ID (for dashboard URLs) */
  dashboardId?: string;
}

/**
 * Parses a Sentry URL and extracts resource type and identifiers.
 *
 * Supported URL patterns:
 * - Issue: `/issues/{issueId}` or `/organizations/{org}/issues/{issueId}`
 * - Event: `/issues/{issueId}/events/{eventId}`
 * - Trace: `/explore/traces/trace/{traceId}` or `/performance/trace/{traceId}`
 * - Profile: `/explore/profiling/profile/{project}/{profileId}/flamegraph/`
 * - Continuous profile: `/explore/profiling/profile/{project}/flamegraph/` with query params
 * - AI conversation: `/explore/conversations/{conversationId}/`
 * - Replay: `/explore/replays/{replayId}/` or `/replays/{replayId}/`
 * - Monitor: `/crons/{monitorSlug}/` or `/monitors/{monitorSlug}/`
 * - Release: `/releases/{version}/`
 * - Dashboard: `/dashboard/{dashboardId}/`
 *
 * Organization slug is extracted from:
 * 1. Subdomain (e.g., `my-org.sentry.io`)
 * 2. Path (e.g., `/organizations/my-org/...` or `/my-org/issues/...`)
 *
 * @param url - A Sentry URL to parse
 * @returns Parsed URL with resource type and identifiers
 * @throws UserInputError if the URL is invalid or cannot be parsed
 *
 * @example
 * // Issue URL
 * parseSentryUrl("https://my-org.sentry.io/issues/PROJECT-123")
 * // { type: "issue", organizationSlug: "my-org", issueId: "PROJECT-123" }
 *
 * @example
 * // Replay URL
 * parseSentryUrl("https://my-org.sentry.io/explore/replays/abc123def456/")
 * // { type: "replay", organizationSlug: "my-org", replayId: "abc123def456" }
 *
 * @example
 * // Monitor URL
 * parseSentryUrl("https://my-org.sentry.io/crons/my-cron-job/")
 * // { type: "monitor", organizationSlug: "my-org", monitorSlug: "my-cron-job" }
 */
export function parseSentryUrl(url: string): ParsedSentryUrl {
  if (!url || typeof url !== "string") {
    throw new UserInputError(
      "Invalid Sentry URL. URL must be a non-empty string.",
    );
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new UserInputError(
      "Invalid Sentry URL. Must start with http:// or https://",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UserInputError(`Invalid Sentry URL. Unable to parse URL: ${url}`);
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

  // Extract organization slug first (needed for all resource types)
  const organizationSlug = extractOrganizationSlug(parsedUrl, pathParts);

  // Try to identify the resource type and extract relevant identifiers
  return identifyResource(parsedUrl, pathParts, organizationSlug);
}

/**
 * Extracts organization slug from URL.
 *
 * Checks in order:
 * 1. `/organizations/{org}/...` path format
 * 2. `/{org}/issues/...` path format (org before known segments)
 * 3. Subdomain (e.g., `my-org.sentry.io`) - excluding region prefixes
 */
function extractOrganizationSlug(parsedUrl: URL, pathParts: string[]): string {
  // Check for /organizations/{org}/ pattern
  if (pathParts.includes("organizations")) {
    const orgIndex = pathParts.indexOf("organizations");
    const slug = pathParts[orgIndex + 1];
    if (slug) {
      return slug;
    }
  }

  // Check for /{org}/issues/ or /{org}/explore/ pattern
  // Known top-level segments that indicate the first part is an org slug
  const knownSegments = [
    "issues",
    "explore",
    "performance",
    "projects",
    "settings",
    "replays",
    "releases",
    "crons",
    "monitors",
    "alerts",
    "feedback",
    "dashboard",
    "dashboards",
    "discover",
    "insights",
    "preprod",
  ];
  if (
    pathParts.length > 1 &&
    !knownSegments.includes(pathParts[0]) &&
    knownSegments.includes(pathParts[1])
  ) {
    return pathParts[0];
  }

  // Check for subdomain (e.g., my-org.sentry.io)
  const hostParts = parsedUrl.hostname.split(".");
  // Region prefixes to exclude (us, eu, de, etc.)
  const regionPrefixes = ["us", "eu", "de", "www"];

  // Non-region subdomain (e.g., my-org.sentry.io or sentry.mycompany.com)
  if (hostParts.length >= 2 && !regionPrefixes.includes(hostParts[0])) {
    return hostParts[0];
  }

  // If we reach here with region-prefixed URL, we couldn't determine the org
  throw new UserInputError(
    "Invalid Sentry URL. Could not determine organization from URL.",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPathGroup(
  pathParts: string[],
  patterns: RegExp[],
  groupName: string,
): string | undefined {
  const path = pathParts.join("/");

  for (const pattern of patterns) {
    const match = pattern.exec(path);
    const value = match?.groups?.[groupName];
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Identifies the resource type and extracts relevant identifiers.
 */
function identifyResource(
  parsedUrl: URL,
  pathParts: string[],
  organizationSlug: string,
): ParsedSentryUrl {
  // Profile URL: /explore/profiling/profile/{project}/{profileId}/flamegraph/
  // Continuous profile URL: /explore/profiling/profile/{project}/flamegraph/
  // or /profiling/profile/{project}/flamegraph/
  // Check this FIRST to avoid false positives when project names match keywords like "replays"
  const profilingIndex = pathParts.indexOf("profiling");
  if (profilingIndex !== -1 && pathParts[profilingIndex + 1] === "profile") {
    const projectSlug = pathParts[profilingIndex + 2];
    const nextPart = pathParts[profilingIndex + 3];
    const profileId =
      nextPart && nextPart !== "flamegraph" ? nextPart : undefined;
    const profilerId = parsedUrl.searchParams.get("profilerId") || undefined;
    const start = parsedUrl.searchParams.get("start") || undefined;
    const end = parsedUrl.searchParams.get("end") || undefined;

    return {
      type: "profile",
      organizationSlug,
      projectSlugOrId: projectSlug,
      profileId,
      profilerId,
      start,
      end,
    };
  }

  // AI conversation URL: /explore/conversations/{conversationId}/
  const conversationId = extractPathGroup(
    pathParts,
    [
      /^explore\/conversations\/(?<conversationId>[^/]+)$/,
      /^organizations\/[^/]+\/explore\/conversations\/(?<conversationId>[^/]+)$/,
      new RegExp(
        `^${escapeRegex(organizationSlug)}\\/explore\\/conversations\\/(?<conversationId>[^/]+)$`,
      ),
    ],
    "conversationId",
  );
  if (conversationId) {
    const project = parsedUrl.searchParams.get("project") || undefined;
    const spanId = parsedUrl.searchParams.get("spanId") || undefined;
    const start = parsedUrl.searchParams.get("start") || undefined;
    const end = parsedUrl.searchParams.get("end") || undefined;

    return {
      type: "ai_conversation",
      organizationSlug,
      conversationId: decodeURIComponent(conversationId),
      projectSlugOrId: project,
      spanId,
      start,
      end,
    };
  }

  // Replay URL: /explore/replays/{replayId}/ or /replays/{replayId}/
  const replaysIndex = pathParts.indexOf("replays");
  if (replaysIndex !== -1) {
    const replayId = pathParts[replaysIndex + 1];
    // Make sure it's not a sub-route like /replays/selectors/
    if (replayId && replayId !== "selectors") {
      return {
        type: "replay",
        organizationSlug,
        replayId,
      };
    }
  }

  // Monitor/Cron URL: /crons/{monitorSlug}/ or /monitors/{monitorSlug}/
  const cronsIndex = pathParts.indexOf("crons");
  const monitorsIndex = pathParts.indexOf("monitors");
  const monitorPathIndex = cronsIndex !== -1 ? cronsIndex : monitorsIndex;
  if (monitorPathIndex !== -1) {
    // Could be /crons/{slug}/ or /crons/{projectId}/{slug}/
    const nextPart = pathParts[monitorPathIndex + 1];
    if (nextPart && nextPart !== "new") {
      // Check if there's a project ID followed by monitor slug
      const afterNext = pathParts[monitorPathIndex + 2];
      if (afterNext && afterNext !== "details") {
        // Pattern: /crons/{projectId}/{monitorSlug}/
        return {
          type: "monitor",
          organizationSlug,
          projectSlugOrId: nextPart,
          monitorSlug: afterNext,
        };
      }
      // Pattern: /crons/{monitorSlug}/
      return {
        type: "monitor",
        organizationSlug,
        monitorSlug: nextPart,
      };
    }
  }

  // Release URL: /releases/{version}/
  const releasesIndex = pathParts.indexOf("releases");
  if (releasesIndex !== -1) {
    const releaseVersion = pathParts[releasesIndex + 1];
    if (
      releaseVersion &&
      releaseVersion !== "new-events" &&
      releaseVersion !== "all-events"
    ) {
      return {
        type: "release",
        organizationSlug,
        releaseVersion,
      };
    }
  }

  // Trace URL: /explore/traces/trace/{traceId} or /performance/trace/{traceId}
  const traceIndex = pathParts.indexOf("trace");
  if (traceIndex !== -1) {
    const traceId = pathParts[traceIndex + 1];
    if (traceId) {
      // Extract span ID from query param if present (node=span-{spanId})
      const nodeParam = parsedUrl.searchParams.get("node");
      let spanId: string | undefined;
      if (nodeParam?.startsWith("span-")) {
        spanId = nodeParam.slice(5); // Remove "span-" prefix
      }

      return {
        type: "trace",
        organizationSlug,
        traceId,
        spanId,
      };
    }
  }

  // Performance summary URL: /performance/summary/?transaction=...
  // This can help identify a transaction for profiling or tracing
  if (pathParts.includes("performance") && pathParts.includes("summary")) {
    const transaction = parsedUrl.searchParams.get("transaction") || undefined;
    if (transaction) {
      // Return as unknown but with transaction info that could be useful
      return {
        type: "unknown",
        organizationSlug,
        transaction,
      };
    }
  }

  // Issue URL: /issues/{issueId} or with /events/{eventId}
  const issuesIndex = pathParts.indexOf("issues");
  if (issuesIndex !== -1) {
    const issueId = pathParts[issuesIndex + 1];
    if (issueId) {
      // Check for event URL: /issues/{issueId}/events/{eventId}
      const eventsIndex = pathParts.indexOf("events", issuesIndex);
      if (eventsIndex !== -1) {
        const eventId = pathParts[eventsIndex + 1];
        if (eventId) {
          return {
            type: "event",
            organizationSlug,
            issueId,
            eventId,
          };
        }
      }

      return {
        type: "issue",
        organizationSlug,
        issueId,
      };
    }
  }

  // Dashboard URL: /dashboard/{dashboardId}/
  // Dashboard IDs are always numeric integers.
  const dashboardIndex = pathParts.indexOf("dashboard");
  if (dashboardIndex !== -1) {
    const dashboardId = pathParts[dashboardIndex + 1];
    if (dashboardId && /^\d+$/.test(dashboardId)) {
      return {
        type: "dashboard",
        organizationSlug,
        dashboardId,
      };
    }
  }

  // Snapshot URL: /preprod/snapshots/{snapshotId}/
  const preprodIndex = pathParts.indexOf("preprod");
  if (preprodIndex !== -1 && pathParts[preprodIndex + 1] === "snapshots") {
    const snapshotId = pathParts[preprodIndex + 2];
    if (snapshotId) {
      const selectedSnapshot =
        parsedUrl.searchParams.get("selectedSnapshot") || undefined;
      return {
        type: "snapshot",
        organizationSlug,
        snapshotId,
        selectedSnapshot,
      };
    }
  }

  // Could not identify resource type
  return {
    type: "unknown",
    organizationSlug,
  };
}

/**
 * Checks if a URL appears to be a Sentry profile URL.
 *
 * @param url - URL to check
 * @returns True if the URL looks like a profile URL
 */
export function isProfileUrl(url: string): boolean {
  try {
    const parsed = parseSentryUrl(url);
    return parsed.type === "profile";
  } catch {
    return false;
  }
}
