import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  ApiNotFoundError,
  ApiPermissionError,
  ApiValidationError,
} from "../../api-client";
import { UserInputError } from "../../errors";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import getInbox, { getInboxOutputSchema } from "./get-inbox";

const INBOX_URL =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/inbox/";

const context = {
  constraints: { organizationSlug: null, projectSlug: null },
  accessToken: "access-token",
  userId: "1",
};

const baseParams = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  itemId: null,
  isRead: null,
  subjectType: null,
  subjectId: null,
  eventTypes: null,
  recipient: null,
  cursor: null,
  limit: 25,
};

// Shapes follow InboxItemSerializer and InboxItemEventSerializer in
// src/sentry/inbox/serializers.py.
const mentionEvent = {
  id: "9001",
  type: "issue.user_mentioned",
  actor: {
    type: "user",
    id: "42",
    name: "Jane Doe",
    avatar: { avatarType: "letter_avatar", avatarUuid: null, avatarUrl: null },
  },
  data: { commentId: "555" },
  summary: "Mentioned you in a comment",
  isUnread: true,
  dateAdded: "2026-11-15T10:00:00.000000Z",
};

const assignmentEvent = {
  id: "9000",
  type: "issue.user_assigned",
  actor: { type: "user", id: "42", name: "Jane Doe", avatar: null },
  data: { assignmentSource: null },
  summary: "Assigned to you",
  isUnread: false,
  dateAdded: "2026-11-14T09:00:00.000000Z",
};

const completedEvent = {
  id: "9100",
  type: "notebook.completed",
  actor: { type: "system", id: null, name: "Sentry", avatar: null },
  data: {},
  summary: "Investigation completed",
  isUnread: false,
  dateAdded: "2026-11-13T08:00:00.000000Z",
};

const issueItem = {
  id: "101",
  subjectType: "issue",
  subjectId: "6507376925",
  title: "TypeError: Cannot read properties of undefined",
  url: "https://sentry-mcp-evals.sentry.io/inbox/issue/6507376925/",
  subtitle: "Mentioned you in a comment",
  eventTypes: ["issue.user_assigned", "issue.user_mentioned"],
  eventCount: 2,
  unreadEventCount: 1,
  latestEvent: mentionEvent,
  isUnread: true,
  lastActivityAt: "2026-11-15T10:00:00.000000Z",
  lastReadAt: "2026-11-14T12:00:00.000000Z",
};

const notebookItem = {
  id: "102",
  subjectType: "notebook",
  subjectId: "77",
  title: null,
  url: "https://sentry-mcp-evals.sentry.io/inbox/notebook/77/",
  subtitle: "Investigation completed",
  eventTypes: ["notebook.completed"],
  eventCount: 1,
  unreadEventCount: 0,
  latestEvent: completedEvent,
  isUnread: false,
  lastActivityAt: "2026-11-13T08:00:00.000000Z",
  lastReadAt: "2026-11-13T09:00:00.000000Z",
};

function parse(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  return getInboxOutputSchema.parse(content);
}

describe("get_inbox", () => {
  it("lists inbox items with summaries, read state, and URLs", async () => {
    mswServer.use(
      http.get(INBOX_URL, () =>
        HttpResponse.json([issueItem, notebookItem], {
          headers: {
            Link: `<${INBOX_URL}?cursor=1731664800000000_102:0:0>; rel="next"; results="true"; cursor="1731664800000000_102:0:0"`,
          },
        }),
      ),
    );

    const result = await getInbox.handler(baseParams, context);

    expect(parse(result)).toMatchInlineSnapshot(`
      {
        "items": [
          {
            "eventCount": 2,
            "eventTypes": [
              "issue.user_assigned",
              "issue.user_mentioned",
            ],
            "id": "101",
            "isUnread": true,
            "lastActivityAt": "2026-11-15T10:00:00.000000Z",
            "lastReadAt": "2026-11-14T12:00:00.000000Z",
            "latestEvent": {
              "actor": {
                "id": "42",
                "name": "Jane Doe",
                "type": "user",
              },
              "data": {
                "commentId": "555",
              },
              "dateAdded": "2026-11-15T10:00:00.000000Z",
              "id": "9001",
              "isUnread": true,
              "summary": "Mentioned you in a comment",
              "type": "issue.user_mentioned",
            },
            "subjectId": "6507376925",
            "subjectType": "issue",
            "subtitle": "Mentioned you in a comment",
            "title": "TypeError: Cannot read properties of undefined",
            "unreadEventCount": 1,
            "url": "https://sentry-mcp-evals.sentry.io/inbox/issue/6507376925/",
          },
          {
            "eventCount": 1,
            "eventTypes": [
              "notebook.completed",
            ],
            "id": "102",
            "isUnread": false,
            "lastActivityAt": "2026-11-13T08:00:00.000000Z",
            "lastReadAt": "2026-11-13T09:00:00.000000Z",
            "latestEvent": {
              "actor": {
                "id": null,
                "name": "Sentry",
                "type": "system",
              },
              "data": {},
              "dateAdded": "2026-11-13T08:00:00.000000Z",
              "id": "9100",
              "isUnread": false,
              "summary": "Investigation completed",
              "type": "notebook.completed",
            },
            "subjectId": "77",
            "subjectType": "notebook",
            "subtitle": "Investigation completed",
            "title": null,
            "unreadEventCount": 0,
            "url": "https://sentry-mcp-evals.sentry.io/inbox/notebook/77/",
          },
        ],
        "nextCursor": "1731664800000000_102:0:0",
      }
    `);
  });

  it("returns a null URL when Sentry does not return one", async () => {
    // Sentry deploys before getsentry/sentry#131406 have no item URL.
    const { url: _url, ...itemWithoutUrl } = issueItem;
    mswServer.use(
      http.get(INBOX_URL, () => HttpResponse.json([itemWithoutUrl])),
    );

    const result = await getInbox.handler(baseParams, context);
    expect(parse(result).items?.[0]?.url).toBeNull();
  });

  it("forwards filters, the cursor, and the page size", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(INBOX_URL, ({ request }) => {
        captured = new URL(request.url).searchParams;
        return HttpResponse.json([]);
      }),
    );

    const result = await getInbox.handler(
      {
        ...baseParams,
        isRead: false,
        subjectType: "issue",
        subjectId: "6507376925",
        eventTypes: ["issue.user_mentioned", "issue.team_mentioned"],
        recipient: "team",
        cursor: "1731664800000000_102:0:0",
        limit: 50,
      },
      context,
    );

    expect(captured && [...captured.entries()]).toEqual([
      ["subject_type", "issue"],
      ["subject_id", "6507376925"],
      ["event_type", "issue.user_mentioned"],
      ["event_type", "issue.team_mentioned"],
      ["recipient", "team"],
      ["is_read", "false"],
      ["per_page", "50"],
      ["cursor", "1731664800000000_102:0:0"],
    ]);
    expect(parse(result)).toEqual({ items: [], nextCursor: null });
  });

  it("sends no filters when none are given", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(INBOX_URL, ({ request }) => {
        captured = new URL(request.url).searchParams;
        return HttpResponse.json([]);
      }),
    );

    const result = await getInbox.handler(baseParams, context);

    expect(captured && [...captured.entries()]).toEqual([["per_page", "25"]]);
    expect(parse(result)).toEqual({ items: [], nextCursor: null });
  });

  it("returns no next cursor on the last page", async () => {
    mswServer.use(
      http.get(INBOX_URL, () =>
        HttpResponse.json([issueItem], {
          headers: {
            Link: `<${INBOX_URL}?cursor=1731664800000000_101:0:0>; rel="next"; results="false"; cursor="1731664800000000_101:0:0"`,
          },
        }),
      ),
    );

    const result = await getInbox.handler(baseParams, context);
    expect(parse(result).nextCursor).toBeNull();
  });

  it("returns one item's events without changing its read state", async () => {
    const requests: string[] = [];
    mswServer.use(
      http.all(
        /\/api\/0\/organizations\/sentry-mcp-evals\/inbox\//,
        ({ request }) => {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);
          const url = new URL(request.url);
          expect(url.searchParams.get("cursor")).toBe(
            "1731579600000000_9000:0:0",
          );
          expect(url.searchParams.get("per_page")).toBe("10");
          return HttpResponse.json([mentionEvent, assignmentEvent], {
            headers: {
              Link: `<${url.origin}${url.pathname}?cursor=1731578400000000_8999:0:0>; rel="next"; results="true"; cursor="1731578400000000_8999:0:0"`,
            },
          });
        },
      ),
    );

    const result = await getInbox.handler(
      {
        ...baseParams,
        itemId: "101",
        cursor: "1731579600000000_9000:0:0",
        limit: 10,
      },
      context,
    );

    expect(requests).toEqual([
      "GET /api/0/organizations/sentry-mcp-evals/inbox/101/events/",
    ]);
    expect(parse(result)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "actor": {
              "id": "42",
              "name": "Jane Doe",
              "type": "user",
            },
            "data": {
              "commentId": "555",
            },
            "dateAdded": "2026-11-15T10:00:00.000000Z",
            "id": "9001",
            "isUnread": true,
            "summary": "Mentioned you in a comment",
            "type": "issue.user_mentioned",
          },
          {
            "actor": {
              "id": "42",
              "name": "Jane Doe",
              "type": "user",
            },
            "data": {
              "assignmentSource": null,
            },
            "dateAdded": "2026-11-14T09:00:00.000000Z",
            "id": "9000",
            "isUnread": false,
            "summary": "Assigned to you",
            "type": "issue.user_assigned",
          },
        ],
        "itemId": "101",
        "nextCursor": "1731578400000000_8999:0:0",
      }
    `);
  });

  it("rejects list filters combined with an item ID before calling Sentry", async () => {
    await expect(
      getInbox.handler(
        { ...baseParams, itemId: "101", isRead: false, recipient: "user" },
        context,
      ),
    ).rejects.toThrow(
      new UserInputError(
        "Filters apply only to the item list, not to one item's events. Remove isRead and recipient, or remove itemId to list items.",
      ),
    );
  });

  it("requires a subject type with a subject ID", async () => {
    await expect(
      getInbox.handler({ ...baseParams, subjectId: "123" }, context),
    ).rejects.toThrow(UserInputError);
  });

  it("rejects a non-numeric item ID in the schema", () => {
    expect(getInbox.inputSchema.itemId.safeParse("PROJ-1").success).toBe(false);
    expect(getInbox.inputSchema.itemId.safeParse("101").success).toBe(true);
  });

  it("explains a 404 as Inbox not being enabled", async () => {
    mswServer.use(
      http.get(INBOX_URL, () =>
        HttpResponse.json(
          { detail: "The requested resource does not exist" },
          { status: 404 },
        ),
      ),
    );

    const error = await getInbox
      .handler(baseParams, context)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiNotFoundError);
    expect((error as Error).message).toBe(
      "Inbox is not enabled for organization 'sentry-mcp-evals', or you cannot access it.",
    );
  });

  it("explains a 404 for an item that is not in your inbox", async () => {
    mswServer.use(
      http.get(`${INBOX_URL}999/events/`, () =>
        HttpResponse.json({ detail: "Not found." }, { status: 404 }),
      ),
    );

    await expect(
      getInbox.handler({ ...baseParams, itemId: "999" }, context),
    ).rejects.toThrow(/Inbox item 999 is not an active item in your Inbox/);
  });

  it("forwards types Sentry has not registered and surfaces its rejection", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(INBOX_URL, ({ request }) => {
        captured = new URL(request.url).searchParams;
        // InboxFilterSerializer's response for an unregistered type.
        return HttpResponse.json(
          { detail: { non_field_errors: ["Unknown event type."] } },
          { status: 400 },
        );
      }),
    );

    await expect(
      getInbox.handler(
        { ...baseParams, eventTypes: ["issue.not_a_type"] },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiValidationError);
    expect(captured?.getAll("event_type")).toEqual(["issue.not_a_type"]);
  });

  it("surfaces a token without a user as a permission error", async () => {
    mswServer.use(
      http.get(INBOX_URL, () =>
        HttpResponse.json(
          {
            detail: {
              code: "user-required",
              message: "This action requires a user.",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(getInbox.handler(baseParams, context)).rejects.toBeInstanceOf(
      ApiPermissionError,
    );
  });
});
