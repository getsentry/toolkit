import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "@sentry/mcp-server-mocks";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import getIssueTagValues, {
  getIssueTagValuesOutputSchema,
} from "./get-issue-tag-values.js";
import { getServerContext } from "../../test-setup.js";
import { UserInputError } from "../../errors.js";
import { ApiNotFoundError } from "../../api-client/index.js";

describe("get_issue_tag_values", () => {
  it("returns tag value distribution for an issue", async () => {
    const result = await getIssueTagValues.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        tagKey: "url",
        regionUrl: null,
        issueUrl: undefined,
      },
      getServerContext(),
    );
    assertStructuredOnlyResult(result);
    expect(getIssueTagValues.outputSchema).toBe(getIssueTagValuesOutputSchema);
    const structuredContent = getStructuredContent(result);
    expect(getIssueTagValuesOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "tag": {
          "key": "url",
          "name": "Url",
          "topValues": [
            {
              "count": 45,
              "firstSeen": "2024-01-10T08:00:00.000Z",
              "lastSeen": "2024-01-15T10:30:00.000Z",
              "value": "/upload/github/org/repo/commit/abc123",
            },
            {
              "count": 32,
              "firstSeen": "2024-01-11T14:20:00.000Z",
              "lastSeen": "2024-01-15T09:45:00.000Z",
              "value": "/api/v1/users/profile",
            },
            {
              "count": 28,
              "firstSeen": "2024-01-12T11:30:00.000Z",
              "lastSeen": "2024-01-15T08:15:00.000Z",
              "value": "/dashboard/overview",
            },
            {
              "count": 21,
              "firstSeen": "2024-01-13T16:45:00.000Z",
              "lastSeen": "2024-01-14T22:00:00.000Z",
              "value": "/settings/notifications",
            },
            {
              "count": 15,
              "firstSeen": "2024-01-14T10:00:00.000Z",
              "lastSeen": "2024-01-14T18:30:00.000Z",
              "value": "/checkout/payment",
            },
          ],
          "totalValues": 156,
        },
      }
    `);
  });

  it("works with issue URL parameter", async () => {
    const result = await getIssueTagValues.handler(
      {
        organizationSlug: undefined,
        issueId: undefined,
        tagKey: "browser",
        regionUrl: null,
        issueUrl:
          "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
      },
      getServerContext(),
    );
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      tag: {
        key: "browser",
        name: "Browser",
        totalValues: 156,
      },
    });
  });

  it("rejects issues outside the active project constraint", async () => {
    await expect(
      getIssueTagValues.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          tagKey: "url",
          regionUrl: null,
          issueUrl: undefined,
        },
        getServerContext({
          constraints: {
            projectSlug: "frontend",
          },
        }),
      ),
    ).rejects.toThrow(
      'Issue is outside the active project constraint. Expected project "frontend".',
    );
  });

  it("throws error when neither issueId nor issueUrl provided", async () => {
    await expect(
      getIssueTagValues.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: undefined,
          tagKey: "url",
          regionUrl: null,
          issueUrl: undefined,
        },
        getServerContext(),
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("throws error when organizationSlug missing with issueId", async () => {
    await expect(
      getIssueTagValues.handler(
        {
          organizationSlug: undefined,
          issueId: "CLOUDFLARE-MCP-41",
          tagKey: "url",
          regionUrl: null,
          issueUrl: undefined,
        },
        getServerContext(),
      ),
    ).rejects.toThrow(UserInputError);
  });

  // Sentry returns this 404 for both a missing issue and a tag key the issue
  // does not have. Production calls mostly hit the second case.
  const notFoundResponse = () =>
    HttpResponse.json(
      { detail: "The requested resource does not exist" },
      { status: 404 },
    );

  it("lists the issue's tag keys when the requested key is not on the issue", async () => {
    const requests: URL[] = [];
    const recordRequest = ({ request }: { request: Request }) => {
      requests.push(new URL(request.url));
    };
    mswServer.events.on("request:start", recordRequest);

    const error = await getIssueTagValues
      .handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
          tagKey: "transaction",
          regionUrl: null,
          issueUrl: undefined,
        },
        getServerContext(),
      )
      .catch((thrown: unknown) => thrown)
      .finally(() => {
        mswServer.events.removeListener("request:start", recordRequest);
      });

    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toMatchInlineSnapshot(
      `"Tag \`transaction\` not found on this issue. Available keys: \`browser\`, \`environment\`, \`handled\`, \`level\`, \`mechanism\`, \`runtime.name\`, \`url\`."`,
    );
    const tagList = requests.find((url) => url.pathname.endsWith("/tags/"));
    expect(tagList?.searchParams.get("limit")).toBe("1");
  });

  it("reports a missing issue when the issue itself does not exist", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/:org/issues/:issueId/tags/:tagKey/",
        notFoundResponse,
      ),
      http.get(
        "https://sentry.io/api/0/organizations/:org/issues/:issueId/tags/",
        notFoundResponse,
      ),
    );

    const error = await getIssueTagValues
      .handler(
        {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-404",
          tagKey: "environment",
          regionUrl: null,
          issueUrl: undefined,
        },
        getServerContext(),
      )
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiNotFoundError);
    expect((error as Error).message).toMatchInlineSnapshot(`
      "The requested resource does not exist
      Please verify these parameters are correct:
        - organizationSlug: 'sentry-mcp-evals'
        - issueId: 'CLOUDFLARE-MCP-404'"
    `);
  });

  /**
   * These assert against the input schema rather than the handler because the
   * handler receives already-validated params. Driving the handler directly skips
   * Zod, so an earlier version of these tests passed only because MSW rejected the
   * unmocked URL, not because the traversal was caught.
   */
  it.each([
    ["dot segments", "../../../admin"],
    ["slashes", "url/path"],
    ["backslashes", "..\\..\\admin"],
    ["encoded dot segments", "%2e%2e%2fadmin"],
    ["leading dot", ".hidden"],
  ])("rejects tagKey containing %s", (_label, tagKey) => {
    expect(getIssueTagValues.inputSchema.tagKey.safeParse(tagKey).success).toBe(
      false,
    );
  });

  it("accepts a conventional tag key", () => {
    expect(getIssueTagValues.inputSchema.tagKey.safeParse("url").success).toBe(
      true,
    );
  });

  it("handles null values in topValues gracefully", async () => {
    // Override the handler to return null values (which can occur with certain tag types)
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/:org/issues/:issueId/tags/:tagKey/",
        () => {
          return HttpResponse.json({
            key: "custom_tag",
            name: "Custom Tag",
            totalValues: 2,
            topValues: [
              {
                key: "custom_tag",
                name: "valid_value",
                value: "valid_value",
                count: 10,
                lastSeen: "2024-01-15T10:30:00.000Z",
                firstSeen: "2024-01-10T08:00:00.000Z",
              },
              {
                key: "custom_tag",
                name: null,
                value: null,
                count: 5,
                lastSeen: null,
                firstSeen: null,
              },
            ],
          });
        },
      ),
    );

    const result = await getIssueTagValues.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        issueId: "CLOUDFLARE-MCP-41",
        tagKey: "custom_tag",
        regionUrl: null,
        issueUrl: undefined,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      tag: {
        key: "custom_tag",
        name: "Custom Tag",
        totalValues: 2,
        topValues: [
          {
            value: "valid_value",
            count: 10,
            firstSeen: "2024-01-10T08:00:00.000Z",
            lastSeen: "2024-01-15T10:30:00.000Z",
          },
          {
            value: null,
            count: 5,
            firstSeen: null,
            lastSeen: null,
          },
        ],
      },
    });
  });
});
