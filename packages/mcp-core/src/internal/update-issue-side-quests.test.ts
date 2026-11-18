import { getActiveSpan } from "@sentry/core";
import { relatedIssuesFixture } from "@sentry/mcp-server-mocks";
import { describe, expect, it, vi } from "vitest";
import { RelatedIssuesResponseSchema } from "../api-client/schema";
import {
  RELATED_ISSUES_LIMIT,
  RELATED_ISSUES_OPEN_IDS_ATTRIBUTE,
  UPDATE_ISSUE_SIDE_QUEST_IDS,
  buildUpdateIssueSideQuests,
} from "./update-issue-side-quests";

vi.mock("@sentry/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/core")>();
  return { ...actual, getActiveSpan: vi.fn() };
});

/** Captures the attributes set on the active span. */
function captureSpanAttributes() {
  const attributes: Record<string, unknown> = {};
  vi.mocked(getActiveSpan).mockReturnValue({
    setAttributes: (values: Record<string, unknown>) =>
      Object.assign(attributes, values),
  } as unknown as ReturnType<typeof getActiveSpan>);
  return attributes;
}

const session = { experimentalMode: false };
const organizationSlug = "sentry-mcp-evals";

/**
 * The fixture's two related issues: `CLOUDFLARE-MCP-42` (resolved; similar
 * stack trace and same trace) and `WEB-1A2` (unresolved; same trace, in the
 * `web` project).
 */
function relatedIssues() {
  return RelatedIssuesResponseSchema.parse(
    structuredClone(relatedIssuesFixture),
  );
}

describe("buildUpdateIssueSideQuests", () => {
  it("uses unique snake_case ids, which analytics depend on", () => {
    const ids = Object.values(UPDATE_ISSUE_SIDE_QUEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }
  });

  it("lists the related issues that are still unresolved", () => {
    expect(
      buildUpdateIssueSideQuests(
        { organizationSlug, relatedIssues: relatedIssues() },
        session,
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "details": [
            "\`WEB-1A2\` (same trace): \`TypeError: Failed to fetch\`",
          ],
          "id": "related_issues_open",
          "next": [
            {
              "args": {
                "organizationSlug": "sentry-mcp-evals",
                "resourceId": "WEB-1A2",
                "resourceType": "issue",
              },
              "tool": "get_sentry_resource",
            },
          ],
          "tip": "1 issue related to this one is still open. Check whether this change covers it too.",
        },
      ]
    `);
  });

  it("records the listed issues' short IDs on the span", () => {
    const attributes = captureSpanAttributes();
    const related = relatedIssues();
    const [, open] = related.data;
    related.data = Array.from({ length: 4 }, (_, index) => ({
      ...open,
      issue: { ...open.issue, shortId: `WEB-${index + 1}` },
    }));

    buildUpdateIssueSideQuests(
      { organizationSlug, relatedIssues: related },
      session,
    );

    // only the issues the quest lists, not every open one
    expect(attributes[RELATED_ISSUES_OPEN_IDS_ATTRIBUTE]).toBe(
      "WEB-1,WEB-2,WEB-3",
    );
  });

  it("returns nothing when every related issue is resolved or ignored", () => {
    const attributes = captureSpanAttributes();
    const related = relatedIssues();
    related.data[1].issue.status = "ignored";

    expect(
      buildUpdateIssueSideQuests(
        { organizationSlug, relatedIssues: related },
        session,
      ),
    ).toBeUndefined();
    expect(attributes).not.toHaveProperty(RELATED_ISSUES_OPEN_IDS_ATTRIBUTE);
  });

  it("leaves out issues outside a project-scoped session's project", () => {
    expect(
      buildUpdateIssueSideQuests(
        {
          organizationSlug,
          relatedIssues: relatedIssues(),
          projectSlug: "CLOUDFLARE-MCP",
        },
        session,
      ),
    ).toBeUndefined();
    expect(
      buildUpdateIssueSideQuests(
        {
          organizationSlug,
          relatedIssues: relatedIssues(),
          projectSlug: "web",
        },
        session,
      ),
    ).toHaveLength(1);
  });

  it("says the count is a lower bound when a relation type fills its page", () => {
    const related = relatedIssues();
    const [, open] = related.data;
    related.data = Array.from({ length: RELATED_ISSUES_LIMIT }, (_, index) => ({
      ...open,
      issue: { ...open.issue, shortId: `WEB-${index + 1}` },
    }));

    const [quest] =
      buildUpdateIssueSideQuests(
        { organizationSlug, relatedIssues: related },
        session,
      ) ?? [];

    expect(quest.tip).toBe(
      "At least 5 issues related to this one are still open. Check whether this change covers them too.",
    );
    // capped by the side-quest framework
    expect(quest.details).toHaveLength(3);
    expect(quest.next?.map(({ args }) => args.resourceId)).toEqual([
      "WEB-1",
      "WEB-2",
    ]);
  });
});
