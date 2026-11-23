import { getActiveSpan } from "@sentry/core";
import { inlineCode } from "@sentry/toolkit-core/markdown";
import type { IssueRelationType, RelatedIssues } from "../api-client/types";
import {
  type SideQuest,
  type SideQuestCandidate,
  type SideQuestDetector,
  MAX_DETAILS,
  buildSideQuests,
} from "./side-quests";
import type { ToolSession } from "./tool-helpers/tool-call-formatting";

/**
 * The side quests for an issue `update_issue` just resolved or ignored:
 * follow-ups on the issues around it. Detectors are synchronous, so the tool
 * fetches what they read first.
 *
 * To add one, write a detector that returns a quest or null and add it to
 * `DETECTORS`.
 */
export interface UpdateIssueSideQuestInput {
  organizationSlug: string;
  relatedIssues: RelatedIssues;
  /** Set in a project-scoped session; issues outside it are left out. */
  projectSlug?: string | null | undefined;
}

/**
 * The ids of the update_issue side quests. Analytics query them as span
 * attributes and metric tags, so renaming one breaks dashboards.
 */
export const UPDATE_ISSUE_SIDE_QUEST_IDS = {
  relatedIssuesOpen: "related_issues_open",
} as const;

/**
 * Span attribute with the comma-separated short IDs that the
 * `related_issues_open` quest lists, so analytics can tell whether the agent
 * opened or closed one of them next.
 */
export const RELATED_ISSUES_OPEN_IDS_ATTRIBUTE =
  "app.side_quest.related_issues_open.issue_ids";

/**
 * Span attribute with how many related issues are still open, the count the
 * quest's tip states. A lower bound when a relation type filled its page.
 */
export const RELATED_ISSUES_OPEN_COUNT_ATTRIBUTE =
  "app.side_quest.related_issues_open.count";

/** Related issues to request per relation type. */
export const RELATED_ISSUES_LIMIT = 5;

const RELATION_LABELS: Record<IssueRelationType, string> = {
  similar_stacktrace: "similar stack trace",
  same_trace: "same trace",
  contributing: "contributing",
  same_title: "same title",
  same_supergroup: "same supergroup",
};

/**
 * Whether a relation type filled its page, so more issues of that type may
 * exist than the response holds.
 */
function isPartial({ data }: RelatedIssues): boolean {
  const perType = new Map<IssueRelationType, number>();
  for (const { relations } of data) {
    for (const { type } of relations) {
      perType.set(type, (perType.get(type) ?? 0) + 1);
    }
  }
  return [...perType.values()].some((count) => count >= RELATED_ISSUES_LIMIT);
}

/**
 * Points out related issues that are still unresolved. Sentry orders them
 * with the issues matched by more relation types first. `next` opens the top
 * ones rather than updating them, so the agent checks each issue before
 * resolving or ignoring it.
 */
function detectRelatedIssuesOpen(
  input: UpdateIssueSideQuestInput,
): SideQuestCandidate | null {
  const { organizationSlug, relatedIssues } = input;
  const open = getOpenRelatedIssues(input);
  if (open.length === 0) {
    return null;
  }

  const one = open.length === 1;
  const count = `${isPartial(relatedIssues) ? "At least " : ""}${open.length} ${one ? "issue" : "issues"}`;
  return {
    rank: 0,
    id: UPDATE_ISSUE_SIDE_QUEST_IDS.relatedIssuesOpen,
    tip: `${count} related to this one ${one ? "is" : "are"} still open. Check whether this change covers ${one ? "it" : "them"} too.`,
    details: open
      .slice(0, MAX_DETAILS)
      .map(
        ({ issue, relations }) =>
          `${inlineCode(issue.shortId)} (${relations.map(({ type }) => RELATION_LABELS[type]).join(", ")}): ${inlineCode(issue.title)}`,
      ),
    next: open.map(({ issue }) => ({
      tool: "get_sentry_resource",
      args: {
        organizationSlug,
        resourceType: "issue",
        resourceId: issue.shortId,
      },
    })),
  };
}

const DETECTORS: readonly SideQuestDetector<UpdateIssueSideQuestInput>[] = [
  detectRelatedIssuesOpen,
];

/** The related issues still unresolved, in the session's project if it has one. */
function getOpenRelatedIssues({
  relatedIssues,
  projectSlug,
}: UpdateIssueSideQuestInput): RelatedIssues["data"] {
  return relatedIssues.data.filter(
    ({ issue }) =>
      issue.status === "unresolved" &&
      (!projectSlug || issue.project.slug === projectSlug),
  );
}

/** The side quests after an issue was resolved or ignored, most useful first. */
export function buildUpdateIssueSideQuests(
  input: UpdateIssueSideQuestInput,
  session: ToolSession,
): SideQuest[] | undefined {
  const quests = buildSideQuests(input, DETECTORS, session);
  if (
    quests?.some(
      ({ id }) => id === UPDATE_ISSUE_SIDE_QUEST_IDS.relatedIssuesOpen,
    )
  ) {
    const open = getOpenRelatedIssues(input);
    getActiveSpan()?.setAttributes({
      [RELATED_ISSUES_OPEN_IDS_ATTRIBUTE]: open
        .slice(0, MAX_DETAILS)
        .map(({ issue }) => issue.shortId)
        .join(","),
      [RELATED_ISSUES_OPEN_COUNT_ATTRIBUTE]: open.length,
    });
  }
  return quests;
}
