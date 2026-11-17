import { z } from "zod";
import {
  ApiNotFoundError,
  type InboxItem,
  type InboxItemEvent,
} from "../../api-client";

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

export const inboxItemOutputSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
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

export function formatInboxItem(
  item: InboxItem,
): z.output<typeof inboxItemOutputSchema> {
  return {
    id: item.id,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    title: item.title,
    // Null on Sentry versions before getsentry/sentry#131406.
    url: item.url ?? null,
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
      ? `Inbox item ${itemId} is not an active item in your Universal Inbox in organization '${organizationSlug}', or Universal Inbox is not enabled for that organization. Removed items no longer appear; list current items with get_inbox.`
      : `Universal Inbox is not enabled for organization '${organizationSlug}', or you cannot access it.`;
    throw new ApiNotFoundError(hint, error.detail, error.responseBody);
  }
}
