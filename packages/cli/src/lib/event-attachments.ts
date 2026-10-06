/**
 * Event attachment helpers for `sentry event view`.
 *
 * Listing uses {@link listEventAttachments}; each `download` value is an
 * absolute authenticated API URL. JSON output never carries file bytes.
 */

import type { EventAttachmentDetailsResponse } from "@sentry/api";
import type { SentryEvent } from "../types/index.js";
import { listEventAttachments } from "./api-client.js";
import {
  escapeMarkdownInline,
  renderMarkdown,
  safeCodeSpan,
} from "./formatters/markdown.js";
import { formatBytes } from "./formatters/numbers.js";
import { logger } from "./logger.js";
import { resolveOrgRegion } from "./region.js";
import { getApiBaseUrl } from "./sentry-client.js";
import { shellQuote } from "./utils.js";

const log = logger.withTag("event.view");

type EventWithOptionalProject = SentryEvent & {
  project?: string | { slug?: string | null } | null;
  projectSlug?: string | null;
};

export type EventViewAttachment = EventAttachmentDetailsResponse & {
  download: string;
};

type AttachmentTarget = {
  apiBase: string;
  org: string;
  project: string;
  eventId: string;
};

/**
 * Best-effort project slug from an event payload.
 *
 * Event detail usually only has numeric `projectID`. Some responses also
 * include `projectSlug` or a nested `project` object/string.
 */
export function eventProjectSlug(event: SentryEvent): string | undefined {
  const { project, projectSlug } = event as EventWithOptionalProject;
  if (typeof projectSlug === "string" && projectSlug.length > 0) {
    return projectSlug;
  }
  if (typeof project === "string" && project.length > 0) {
    return project;
  }
  if (project && typeof project === "object") {
    const slug = project.slug;
    if (typeof slug === "string" && slug.length > 0) {
      return slug;
    }
  }
  return;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function attachmentDownloadUrl(
  target: AttachmentTarget,
  attachmentId: string
): string {
  const origin = trimTrailingSlashes(target.apiBase);
  const path = [
    "projects",
    target.org,
    target.project,
    "events",
    target.eventId,
    "attachments",
    attachmentId,
  ]
    .map(encodeURIComponent)
    .join("/");
  return `${origin}/api/0/${path}/?download=1`;
}

async function resolveAttachmentApiBase(org: string): Promise<string> {
  try {
    return await resolveOrgRegion(org);
  } catch (error) {
    log.debug("Failed to resolve region for attachment download URL", error);
    return getApiBaseUrl();
  }
}

/**
 * Best-effort attachment metadata with absolute download URLs.
 *
 * Event rendering remains available when the project is unknown or attachment
 * lookup fails.
 *
 * @param org - Organization slug
 * @param project - Project slug, when known
 * @param eventId - Event ID
 * @returns Attachment metadata, or an empty array when unavailable
 */
export async function loadEventAttachments(
  org: string,
  project: string | undefined,
  eventId: string
): Promise<EventViewAttachment[]> {
  if (!project) {
    return [];
  }

  let attachments: EventAttachmentDetailsResponse[];
  try {
    attachments = await listEventAttachments(org, project, eventId);
  } catch (error) {
    log.debug("Failed to fetch attachments for event", error);
    return [];
  }
  if (attachments.length === 0) {
    return [];
  }

  const apiBase = await resolveAttachmentApiBase(org);
  const target = {
    org,
    project,
    eventId,
    apiBase,
  };
  return attachments.map((attachment) => ({
    ...attachment,
    download: attachmentDownloadUrl(target, attachment.id),
  }));
}

function formatAttachment(attachment: EventAttachmentDetailsResponse): string {
  const details = [attachment.mimetype, formatBytes(attachment.size)]
    .filter(Boolean)
    .join(", ");
  const name = escapeMarkdownInline(attachment.name);
  return `- ${name}${details ? ` (${escapeMarkdownInline(details)})` : ""} — ${safeCodeSpan(attachment.id)}`;
}

/**
 * Human-readable attachments section, or empty string when there are none.
 */
export function formatEventAttachments(
  attachments: EventAttachmentDetailsResponse[]
): string {
  if (attachments.length === 0) {
    return "";
  }
  return renderMarkdown(
    ["### Attachments", "", ...attachments.map(formatAttachment)].join("\n")
  );
}

/**
 * Footer hint with a copy-pasteable download command for the first attachment.
 */
export function attachmentDownloadHint(
  attachments: EventViewAttachment[]
): string | undefined {
  const [first] = attachments;
  if (!first) {
    return;
  }
  const name = first.name || "attachment";
  const extra =
    attachments.length > 1 ? ` (${attachments.length - 1} more)` : "";
  return `Download attachment: sentry api ${shellQuote(first.download)} > ${shellQuote(name)}${extra}`;
}
