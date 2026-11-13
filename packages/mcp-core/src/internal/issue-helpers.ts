/**
 * Issue parameter parsing and validation utilities.
 *
 * Handles flexible input formats for Sentry issues (URLs vs explicit parameters),
 * extracts organization and issue identifiers, and validates issue ID formats.
 * Provides robust parsing for LLM-generated parameters that may contain formatting
 * inconsistencies.
 */

import { UserInputError } from "../errors";
import { ParamEventId } from "../schema";
import { resolveScopedOrganizationSlug } from "./url-scope";

/**
 * Extracts the Sentry issue ID and organization slug from a full URL
 *
 * @param url - A full Sentry issue URL
 * @returns Object containing the issue ID, organization slug, and the event ID
 *   when the URL points at one event (`/issues/{issueId}/events/{eventId}/`)
 * @throws Error if the input is invalid
 */
export function extractIssueId(url: string): {
  issueId: string;
  organizationSlug: string;
  eventId?: string;
} {
  if (!url || typeof url !== "string") {
    throw new UserInputError(
      "Invalid Sentry issue URL. URL must be a non-empty string.",
    );
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new UserInputError(
      "Invalid Sentry issue URL. Must start with http:// or https://",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw new UserInputError(
      `Invalid Sentry issue URL. Unable to parse URL: ${url}`,
    );
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2 || !pathParts.includes("issues")) {
    throw new UserInputError(
      "Invalid Sentry issue URL. Path must contain '/issues/{issue_id}'",
    );
  }

  const issueId = pathParts[pathParts.indexOf("issues") + 1];
  if (!issueId) {
    throw new UserInputError("Unable to determine issue ID from URL.");
  }

  // Extract organization slug from either the path or subdomain
  let organizationSlug: string | undefined;
  if (pathParts.includes("organizations")) {
    organizationSlug = pathParts[pathParts.indexOf("organizations") + 1];
  } else if (pathParts.length > 1 && pathParts[0] !== "issues") {
    // If URL is like sentry.io/sentry/issues/123
    organizationSlug = pathParts[0];
  } else {
    // Check for subdomain
    const hostParts = parsedUrl.hostname.split(".");
    if (hostParts.length > 2 && hostParts[0] !== "www") {
      organizationSlug = hostParts[0];
    }
  }

  if (!organizationSlug) {
    throw new UserInputError(
      "Invalid Sentry issue URL. Could not determine organization.",
    );
  }

  // Only a 32-character event ID selects an event; `/events/latest/` and
  // other aliases resolve to the issue's latest event like a plain issue URL.
  const eventsIndex = pathParts.indexOf("events", pathParts.indexOf("issues"));
  const eventId = eventsIndex === -1 ? undefined : pathParts[eventsIndex + 1];
  if (eventId && ParamEventId.safeParse(eventId).success) {
    return { issueId, organizationSlug, eventId };
  }

  return { issueId, organizationSlug };
}

/**
 * Sometimes the LLM will pass in a funky issue shortId. For example it might pass
 * in "CLOUDFLARE-MCP-41." instead of "CLOUDFLARE-MCP-41". This function attempts to
 * fix common issues.
 *
 * @param issueId - The issue ID to parse
 * @returns The parsed issue ID
 */
export function parseIssueId(issueId: string) {
  if (!issueId.trim()) {
    throw new UserInputError("Issue ID cannot be empty");
  }

  let finalIssueId = issueId;
  // remove trailing punctuation
  finalIssueId = finalIssueId.replace(/[^\w-]/g, "");

  if (!finalIssueId) {
    throw new UserInputError(
      "Issue ID cannot be empty after removing special characters",
    );
  }

  // Validate against common Sentry issue ID patterns
  // Either numeric IDs or PROJECT-ABC123 format
  // Allow project codes to start with alphanumeric characters (including numbers)
  const validFormatRegex = /^(\d+|[A-Za-z0-9][\w-]*-[A-Za-z0-9]+)$/;

  if (!validFormatRegex.test(finalIssueId)) {
    throw new UserInputError(
      `Invalid issue ID format: "${finalIssueId}". Expected either a numeric ID or a project code followed by an alphanumeric identifier (e.g., "PROJECT-ABC123").`,
    );
  }

  return finalIssueId;
}

/**
 * Parses issue parameters from a variety of formats.
 *
 * @param params - Object containing issue URL, issue ID, and organization slug
 * @returns Object containing the parsed organization slug and issue ID, plus
 *   the event ID when `issueUrl` points at one event
 * @throws Error if the input is invalid
 */
export function parseIssueParams({
  issueUrl,
  issueId,
  organizationSlug,
}: {
  issueUrl?: string | null;
  issueId?: string | null;
  organizationSlug?: string | null;
}): {
  organizationSlug: string;
  issueId: string;
  eventId?: string;
} {
  if (issueUrl) {
    const resolved = extractIssueId(issueUrl);
    return {
      organizationSlug: resolveScopedOrganizationSlug({
        resourceLabel: "Issue",
        scopedOrganizationSlug: organizationSlug,
        urlOrganizationSlug: resolved.organizationSlug,
      }),
      issueId: parseIssueId(resolved.issueId),
      ...(resolved.eventId ? { eventId: resolved.eventId } : {}),
    };
  }

  if (!organizationSlug) {
    throw new UserInputError("Organization slug is required");
  }

  if (issueId) {
    return {
      organizationSlug,
      issueId: parseIssueId(issueId),
    };
  }

  throw new UserInputError("Either issueId or issueUrl must be provided");
}
