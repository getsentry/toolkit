import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamCursor,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  formatInboxEvent,
  formatInboxItem,
  inboxEventOutputSchema,
  inboxItemOutputSchema,
  ParamInboxItemId,
  withInboxNotFoundHint,
} from "../support/inbox";

export const getInboxOutputSchema = z.object({
  items: z.array(inboxItemOutputSchema).optional(),
  itemId: z.string().optional(),
  events: z.array(inboxEventOutputSchema).optional(),
  nextCursor: z.string().nullable(),
});

export default defineTool({
  name: "get_inbox",
  title: "Get Inbox",
  // Inbox is behind the organizations:universal-inbox feature flag.
  experimental: true,
  includeInSkillDefinitions: false,
  skills: ["inspect"],
  requiredScopes: ["org:read"],
  description:
    "List your Sentry Inbox: issue assignments, mentions, pull requests ready for review, and Seer investigation updates, newest activity first, with read state and summaries. Can also return one inbox item's event history. Reading does not mark items read; triage them with update_inbox_items.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    itemId: ParamInboxItemId.describe(
      "Inbox item ID from a previous result. Returns that item's events, newest first, instead of the item list; do not combine with filters.",
    )
      .nullable()
      .default(null),
    isRead: z
      .boolean()
      .describe("false for unread items only, true for read only.")
      .nullable()
      .default(null),
    // Subject and event types are open registries in Sentry
    // (src/sentry/inbox/registry.py), so they stay strings; Sentry rejects
    // unknown values with a 400.
    subjectType: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Only items about this kind of subject, such as issue or notebook (a Seer investigation).",
      )
      .nullable()
      .default(null),
    subjectId: z
      .string()
      .trim()
      .min(1)
      .describe("Numeric issue or investigation ID; requires subjectType.")
      .nullable()
      .default(null),
    eventTypes: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        "Only items with at least one event of these types, such as issue.user_assigned, issue.user_mentioned, issue.pr_ready_for_review, or notebook.completed.",
      )
      .nullable()
      .default(null),
    recipient: z
      .enum(["user", "team"])
      .describe(
        "Only items with an event addressed directly to you (user) or to one of your teams (team).",
      )
      .nullable()
      .default(null),
    cursor: ParamCursor.trim().nullable().default(null),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("Maximum items or events to return.")
      .default(25),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: getInboxOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes({ organizationSlug });

    if (params.itemId) {
      const filters = [
        params.isRead !== null && "isRead",
        params.subjectType && "subjectType",
        params.subjectId && "subjectId",
        params.eventTypes && "eventTypes",
        params.recipient && "recipient",
      ].filter(Boolean);
      if (filters.length > 0) {
        throw new UserInputError(
          `Filters apply only to the item list, not to one item's events. Remove ${filters.join(" and ")}, or remove itemId to list items.`,
        );
      }

      const itemId = params.itemId;
      const { events, nextCursor } = await withInboxNotFoundHint(
        { organizationSlug, itemId },
        () =>
          apiService.listInboxItemEvents({
            organizationSlug,
            itemId,
            cursor: params.cursor,
            limit: params.limit,
          }),
      );
      return structuredResult({
        itemId,
        events: events.map(formatInboxEvent),
        nextCursor,
      });
    }

    if (params.subjectId && !params.subjectType) {
      throw new UserInputError(
        "subjectId requires subjectType: `issue` for an issue ID, or `notebook` for a Seer investigation ID.",
      );
    }

    const { items, nextCursor } = await withInboxNotFoundHint(
      { organizationSlug },
      () =>
        apiService.listInboxItems({
          organizationSlug,
          filters: {
            subjectTypes: params.subjectType ? [params.subjectType] : undefined,
            subjectId: params.subjectId ?? undefined,
            eventTypes: params.eventTypes ?? undefined,
            recipients: params.recipient ? [params.recipient] : undefined,
            isRead: params.isRead ?? undefined,
          },
          cursor: params.cursor,
          limit: params.limit,
        }),
    );
    return structuredResult({
      items: items.map(formatInboxItem),
      nextCursor,
    });
  },
});
