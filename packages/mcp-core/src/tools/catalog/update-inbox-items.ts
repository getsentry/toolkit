import { z } from "zod";
import type { SentryApiService } from "../../api-client";
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
  itemIds: z.array(z.string()),
  // Selected items that matched, including ones already in the requested
  // state. Sentry does not report it for removals.
  matchedCount: z.number().optional(),
});

async function applyInboxAction(
  apiService: SentryApiService,
  organizationSlug: string,
  itemIds: string[],
  action: InboxAction,
): Promise<number | undefined> {
  switch (action) {
    case "mark_read":
    case "mark_unread": {
      const { updatedCount } = await apiService.updateInboxItems({
        organizationSlug,
        itemIds,
        body: { isRead: action === "mark_read" },
      });
      return updatedCount;
    }
    case "remove":
      await apiService.removeInboxItems({ organizationSlug, itemIds });
      return undefined;
  }
}

export default defineTool({
  name: "update_inbox_items",
  title: "Update Inbox Items",
  // Universal Inbox is behind the organizations:universal-inbox feature flag.
  experimental: true,
  includeInSkillDefinitions: false,
  skills: ["triage"],
  requiredScopes: ["org:read"],
  description:
    "Triage your Sentry Universal Inbox: mark selected items read or unread, or remove them. Changes only your personal inbox, never the underlying issues or Seer investigations. Removal hides an item at once, and Sentry deletes it after one hour.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    itemIds: z
      .array(ParamInboxItemId)
      .min(1)
      .max(100)
      .describe("Inbox item IDs from get_inbox. Only these items change."),
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
    // never send one without a selection, even if a caller skips the schema.
    // `new Set(undefined)` is empty, so a missing selection lands here too.
    const itemIds = [...new Set(params.itemIds)];
    if (itemIds.length === 0) {
      throw new UserInputError(
        "Select at least one inbox item ID. List items with get_inbox.",
      );
    }

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes({ organizationSlug });

    const matchedCount = await withInboxNotFoundHint({ organizationSlug }, () =>
      applyInboxAction(apiService, organizationSlug, itemIds, params.action),
    );

    return structuredResult({
      action: params.action,
      itemIds,
      ...(matchedCount === undefined ? {} : { matchedCount }),
    });
  },
});
