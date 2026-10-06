/**
 * sentry feedback view
 *
 * View a modern Feedback issue and its latest event context.
 */

import type { EventAttachmentDetailsResponse } from "@sentry/api";
import type { SentryContext } from "../../context.js";
import {
  getLatestEvent,
  listEventAttachments,
  listReplayIdsForIssue,
} from "../../lib/api-client.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { formatFeedbackView } from "../../lib/formatters/feedback.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  collectReplayIds,
  getReplayIdFromEvent,
} from "../../lib/replay-search.js";
import type { FeedbackViewResult, SentryEvent } from "../../types/index.js";
import { FeedbackViewOutputSchema } from "../../types/index.js";
import { feedbackIdPositional, resolveFeedback } from "./utils.js";

const log = logger.withTag("feedback.view");

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

async function tryGetLatestEvent(
  orgSlug: string,
  feedbackId: string
): Promise<SentryEvent | undefined> {
  try {
    return await getLatestEvent(orgSlug, feedbackId);
  } catch (error) {
    log.debug("Failed to fetch latest event for feedback", error);
    return;
  }
}

async function tryListReplayIds(
  orgSlug: string,
  feedbackId: string
): Promise<string[]> {
  try {
    return await listReplayIdsForIssue(orgSlug, feedbackId);
  } catch (error) {
    log.debug("Failed to fetch replay IDs for feedback", error);
    return [];
  }
}

async function tryListAttachments(
  orgSlug: string,
  projectSlug: string | undefined,
  event: SentryEvent | undefined
): Promise<EventAttachmentDetailsResponse[]> {
  if (!(projectSlug && event)) {
    return [];
  }
  try {
    return await listEventAttachments(orgSlug, projectSlug, event.eventID);
  } catch (error) {
    log.debug("Failed to fetch attachments for feedback", error);
    return [];
  }
}

function jsonTransformFeedbackView(
  data: FeedbackViewResult,
  fields?: string[]
): unknown {
  const result: Record<string, unknown> = {
    ...data.feedback,
    org: data.org,
    event: data.event,
    replayIds: data.replayIds,
    attachments: data.attachments,
  };
  return fields?.length ? filterFields(result, fields) : result;
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View a User Feedback item",
    fullDescription:
      "View modern User Feedback by ID or select the most recent unresolved Feedback with @latest. The latest event, linked error, Session Replays, and attachment metadata are included when available.\n\n" +
      "Feedback formats:\n" +
      "  @latest                     Most recent unresolved Feedback\n" +
      "  <org>/@latest               Most recent unresolved Feedback in an organization\n" +
      "  <short-id>                  Search accessible organizations\n" +
      "  <numeric-id>                Resolve by numeric issue ID\n" +
      "  <org>/<short-id>            Explicit organization\n" +
      "  <org>/<project>/<suffix>    Explicit organization and project\n\n" +
      "The resolved issue must have issue.category:feedback. Use 'sentry issue view' for other issue categories.",
  },
  output: {
    human: formatFeedbackView,
    jsonTransform: jsonTransformFeedbackView,
    schema: FeedbackViewOutputSchema,
  },
  parameters: {
    positional: feedbackIdPositional,
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, feedbackArg: string) {
    applyFreshFlag(flags);
    const { org, feedback } = await resolveFeedback(feedbackArg, this.cwd);

    if (flags.web) {
      await openInBrowser(feedback.permalink, "feedback");
      return;
    }

    const [event, relatedReplayIds] = org
      ? await Promise.all([
          tryGetLatestEvent(org, feedback.id),
          tryListReplayIds(org, feedback.id),
        ])
      : [undefined, []];
    const replayIds = collectReplayIds([
      event ? getReplayIdFromEvent(event) : undefined,
      ...relatedReplayIds,
    ]);
    const attachments = org
      ? await tryListAttachments(org, feedback.project?.slug, event)
      : [];

    yield new CommandOutput({
      org: org ?? null,
      feedback,
      event: event ?? null,
      replayIds,
      attachments,
    });
  },
});
