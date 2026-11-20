import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { ApiNotFoundError, ApiPermissionError } from "../../api-client";
import { UserInputError } from "../../errors";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import updateInboxItems, {
  updateInboxItemsOutputSchema,
} from "./update-inbox-items";

const INBOX_URL =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/inbox/";

const context = {
  constraints: { organizationSlug: null, projectSlug: null },
  accessToken: "access-token",
  userId: "1",
};

type CapturedRequest = {
  method: string;
  path: string;
  ids: string[];
  otherParams: string[];
  body: unknown;
};

/** Records every inbox request; answers PUT with a count and DELETE with 204. */
function captureInboxRequests(updatedCount = 2): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  mswServer.use(
    http.all(
      /\/api\/0\/organizations\/sentry-mcp-evals\/inbox\//,
      async ({ request }) => {
        const url = new URL(request.url);
        const text = await request.text();
        requests.push({
          method: request.method,
          path: url.pathname,
          ids: url.searchParams.getAll("id"),
          otherParams: [...url.searchParams.keys()].filter(
            (key) => key !== "id",
          ),
          body: text ? JSON.parse(text) : null,
        });
        if (request.method === "DELETE") {
          return new HttpResponse(null, { status: 204 });
        }
        return HttpResponse.json({ updatedCount });
      },
    ),
  );
  return requests;
}

function parse(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  expect(updateInboxItemsOutputSchema.parse(content)).toEqual(content);
  return content;
}

describe("update_inbox_items", () => {
  it("marks the selected items read", async () => {
    const requests = captureInboxRequests();

    const result = await updateInboxItems.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        all: false,
        itemIds: ["101", "102"],
        action: "mark_read",
      },
      context,
    );

    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/0/organizations/sentry-mcp-evals/inbox/",
        ids: ["101", "102"],
        otherParams: [],
        body: { isRead: true },
      },
    ]);
    expect(parse(result)).toMatchInlineSnapshot(`
      {
        "action": "mark_read",
        "matchedCount": 2,
        "selection": [
          "101",
          "102",
        ],
      }
    `);
  });

  it("marks the selected items unread", async () => {
    const requests = captureInboxRequests(1);

    const result = await updateInboxItems.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        all: false,
        itemIds: ["101"],
        action: "mark_unread",
      },
      context,
    );

    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/0/organizations/sentry-mcp-evals/inbox/",
        ids: ["101"],
        otherParams: [],
        body: { isRead: false },
      },
    ]);
    expect(parse(result)).toEqual({
      action: "mark_unread",
      selection: ["101"],
      matchedCount: 1,
    });
  });

  it("removes the selected items with a DELETE scoped to their IDs", async () => {
    const requests = captureInboxRequests();

    const result = await updateInboxItems.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        all: false,
        itemIds: ["101", "101", "103"],
        action: "remove",
      },
      context,
    );

    expect(requests).toEqual([
      {
        method: "DELETE",
        path: "/api/0/organizations/sentry-mcp-evals/inbox/",
        ids: ["101", "103"],
        otherParams: [],
        body: null,
      },
    ]);
    expect(parse(result)).toEqual({
      action: "remove",
      selection: ["101", "103"],
    });
  });

  it.each([
    ["mark_read", "PUT", { isRead: true }],
    ["remove", "DELETE", null],
  ] as const)(
    "applies %s to every item only with all: true",
    async (action, method, body) => {
      const requests = captureInboxRequests(7);

      const result = await updateInboxItems.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          all: true,
          itemIds: null,
          action,
        },
        context,
      );

      expect(requests).toEqual([
        {
          method,
          path: "/api/0/organizations/sentry-mcp-evals/inbox/",
          ids: [],
          otherParams: [],
          body,
        },
      ]);
      expect(parse(result)).toMatchObject({ action, selection: "all" });
    },
  );

  it.each([
    ["no selection", { all: false, itemIds: null }],
    ["an empty selection", { all: false, itemIds: [] }],
    ["item IDs with all", { all: true, itemIds: ["101"] }],
  ])("rejects %s before sending a mutation", async (_case, selection) => {
    const requests = captureInboxRequests();

    await expect(
      updateInboxItems.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          ...selection,
          action: "remove",
        },
        context,
      ),
    ).rejects.toThrow(UserInputError);
    expect(requests).toEqual([]);
  });

  it("rejects non-numeric item IDs in the schema", () => {
    expect(
      updateInboxItems.inputSchema.itemIds.safeParse(["101", "all"]).success,
    ).toBe(false);
  });

  it("explains a 404 as Inbox not being enabled", async () => {
    mswServer.use(
      http.put(INBOX_URL, () =>
        HttpResponse.json(
          { detail: "The requested resource does not exist" },
          { status: 404 },
        ),
      ),
    );

    const error = await updateInboxItems
      .handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          all: false,
          itemIds: ["101"],
          action: "mark_read",
        },
        context,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiNotFoundError);
    expect((error as Error).message).toBe(
      "Inbox is not enabled for organization 'sentry-mcp-evals', or you cannot access it.",
    );
  });

  it("surfaces a permission failure", async () => {
    mswServer.use(
      http.delete(INBOX_URL, () =>
        HttpResponse.json(
          { detail: "You do not have permission to perform this action." },
          { status: 403 },
        ),
      ),
    );

    await expect(
      updateInboxItems.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          all: false,
          itemIds: ["101"],
          action: "remove",
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiPermissionError);
  });
});
