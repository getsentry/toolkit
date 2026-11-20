import { z } from "zod";
import type { InboxSelection, SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { ParamInboxItemId, withInboxNotFoundHint } from "../support/inbox";

const INBOX_ACTIONS = ["mark_read", "mark_unread", "remove"] as const;

type InboxAction = (typeof INBOX_ACTIONS)[number];

export const updateInboxItemsOutputSchema = z.object({
  action: z.enum(INBOX_ACTIONS),
  // "all" when every active item was selected.
  selection: z.union([z.literal("all"), z.array(z.string())]),
  // Selected items that matched, including ones already in the requested
  // state. Sentry does not report it for removals.
  matchedCount: z.number().optional(),
});

async function applyInboxAction(
  apiService: SentryApiService,
  organizationSlug: string,
  selection: InboxSelection,
  action: InboxAction,
): Promise<number | undefined> {
  switch (action) {
    case "mark_read":
    case "mark_unread": {
      const { updatedCount } = await apiService.updateInboxItems({
        organizationSlug,
        selection,
        body: { isRead: action === "mark_read" },
      });
      return updatedCount;
    }
    case "remove":
      await apiService.removeInboxItems({ organizationSlug, selection });
      return undefined;
  }
}

export default defineTool({
  name: "update_inbox_items",
  title: "Update Inbox Items",
  // Inbox is behind the organizations:universal-inbox feature flag.
  experimental: true,
  includeInSkillDefinitions: false,
  skills: ["triage"],
  requiredScopes: ["org:read"],
  description:
    "Triage your Sentry Inbox: mark selected items, or every item, read or unread, or remove them. Changes only your personal inbox, never the underlying issues or Seer investigations. Removal hides an item at once, and Sentry deletes it after one hour.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    itemIds: z
      .array(ParamInboxItemId)
      .min(1)
      .max(100)
      .describe("Inbox item IDs from get_inbox. Only these items change.")
      .nullable()
      .default(null),
    all: z
      .boolean()
      .describe(
        "true to change every item in your Inbox instead of itemIds. Set it only when the user asks for all items.",
      )
      .default(false),
    action: z
      .enum(INBOX_ACTIONS)
      .describe("Change to apply to the selected items."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: updateInboxItemsOutputSchema,
  async handler(params, context: ServerContext) {
    // Sentry applies an inbox update with no item filter to every item, so
    // changing everything takes an explicit `all`, never a missing selection.
    const itemIds = [...new Set(params.itemIds ?? [])];
    if (params.all && itemIds.length > 0) {
      throw new UserInputError("Pass either itemIds or all: true, not both.");
    }
    // The error does not suggest `all`, so a mistaken call cannot be
    // "fixed" by changing every item.
    if (!params.all && itemIds.length === 0) {
      throw new UserInputError(
        "Select at least one inbox item ID. List items with get_inbox.",
      );
    }
    const selection = params.all ? ("all" as const) : itemIds;

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes({ organizationSlug });

    const matchedCount = await withInboxNotFoundHint({ organizationSlug }, () =>
      applyInboxAction(apiService, organizationSlug, selection, params.action),
    );

    return structuredResult({
      action: params.action,
      selection,
      ...(matchedCount === undefined ? {} : { matchedCount }),
    });
  },
});
