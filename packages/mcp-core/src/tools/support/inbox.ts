import { z } from "zod";
import {
  ApiNotFoundError,
  type InboxItem,
  type InboxItemEvent,
  type SentryApiService,
} from "../../api-client";
import { UserInputError } from "../../errors";

/** Inbox item IDs are numeric (`InboxFilterSerializer.id` is an IntegerField). */
export const ParamInboxItemId = z
  .string()
  .trim()
  .regex(/^\d+$/, "Inbox item IDs are numeric, such as `123`.");

// Output mirrors the API response (src/sentry/inbox/response_types.py), with
// fields mapped explicitly so the passthrough API schema cannot leak.
const inboxActorSchema = z.object({
  type: z.string(),
  id: z.string().nullable(),
  name: z.string(),
});

export const inboxEventOutputSchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: inboxActorSchema,
  data: z.record(z.string(), z.unknown()),
  summary: z.string(),
  isUnread: z.boolean(),
  dateAdded: z.string(),
});

const inboxSubjectOutputSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  metadata: z.object({
    shortId: z.string().optional(),
    project: z.object({ id: z.string(), slug: z.string() }).optional(),
  }),
});

export const inboxItemOutputSchema = z.object({
  id: z.string(),
  subject: inboxSubjectOutputSchema,
  url: z.string(),
  subtitle: z.string(),
  eventTypes: z.array(z.string()),
  eventCount: z.number(),
  unreadEventCount: z.number(),
  latestEvent: inboxEventOutputSchema,
  isUnread: z.boolean(),
  lastActivityAt: z.string(),
  lastReadAt: z.string().nullable(),
});

export function formatInboxEvent(
  event: InboxItemEvent,
): z.output<typeof inboxEventOutputSchema> {
  return {
    id: event.id,
    type: event.type,
    actor: {
      type: event.actor.type,
      id: event.actor.id,
      name: event.actor.name,
    },
    data: event.data,
    summary: event.summary,
    isUnread: event.isUnread,
    dateAdded: event.dateAdded,
  };
}

function formatInboxSubject(
  subject: InboxItem["subject"],
): z.output<typeof inboxSubjectOutputSchema> {
  const { shortId, project } = subject.metadata;
  return {
    id: subject.id,
    type: subject.type,
    title: subject.title,
    metadata: {
      ...(shortId === undefined ? {} : { shortId }),
      ...(project === undefined
        ? {}
        : { project: { id: project.id, slug: project.slug } }),
    },
  };
}

export function formatInboxItem(
  item: InboxItem,
): z.output<typeof inboxItemOutputSchema> {
  return {
    id: item.id,
    subject: formatInboxSubject(item.subject),
    url: item.url,
    subtitle: item.subtitle,
    eventTypes: item.eventTypes,
    eventCount: item.eventCount,
    unreadEventCount: item.unreadEventCount,
    latestEvent: formatInboxEvent(item.latestEvent),
    isUnread: item.isUnread,
    lastActivityAt: item.lastActivityAt,
    lastReadAt: item.lastReadAt,
  };
}

/**
 * Whether an item belongs in a session scoped to `projectSlug`. Issue items
 * must be in that project. Other subjects, such as Seer investigations, have
 * no project and stay visible, as org-wide dashboards do in find_dashboards.
 */
export function isInboxItemInProject(
  item: InboxItem,
  projectSlug: string,
): boolean {
  if (item.subject.type !== "issue") return true;
  return item.subject.metadata.project?.slug === projectSlug;
}

/**
 * In a project-scoped session, refuses inbox items about issues in other
 * projects. Sentry has no project filter for the inbox, so this looks the
 * items up first. IDs Sentry does not return are not active items, which
 * Sentry's reads and mutations ignore anyway.
 */
export async function assertInboxItemsWithinProject({
  apiService,
  organizationSlug,
  itemIds,
  scopedProjectSlug,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  itemIds: readonly string[];
  scopedProjectSlug: string | null | undefined;
}): Promise<void> {
  if (!scopedProjectSlug) return;
  const { items } = await apiService.listInboxItems({
    organizationSlug,
    filters: { ids: itemIds },
    limit: itemIds.length,
  });
  const outside = items
    .filter((item) => !isInboxItemInProject(item, scopedProjectSlug))
    .map((item) => item.id);
  if (outside.length > 0) {
    throw new UserInputError(
      `Inbox item ${outside.join(", ")} is outside the active project constraint. Expected project "${scopedProjectSlug}".`,
    );
  }
}

/**
 * Sentry answers every inbox endpoint with 404 while the organization's
 * `organizations:universal-inbox` feature is off, and the item events endpoint
 * also answers 404 for an item that is not an active item in your inbox.
 * Say so instead of the generic "verify the organization" hint.
 */
export async function withInboxNotFoundHint<T>(
  { organizationSlug, itemId }: { organizationSlug: string; itemId?: string },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiNotFoundError)) {
      throw error;
    }
    const hint = itemId
      ? `Inbox item ${itemId} is not an active item in your Inbox in organization '${organizationSlug}', or Inbox is not enabled for that organization. Removed items no longer appear; list current items with get_inbox.`
      : `Inbox is not enabled for organization '${organizationSlug}', or you cannot access it.`;
    throw new ApiNotFoundError(hint, error.detail, error.responseBody);
  }
}
