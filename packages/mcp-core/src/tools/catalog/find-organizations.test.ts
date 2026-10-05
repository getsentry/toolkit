import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentryApiService } from "../../api-client/index.js";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { prepareToolParams } from "../catalog-runtime/availability";
import findOrganizations from "./find-organizations.js";

function mockOrganizations(
  organizations: unknown[],
  headers?: Record<string, string>,
  searchParams: Record<string, string> = {},
) {
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/", ({ request }) => {
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        per_page: "25",
        ...searchParams,
      });
      return HttpResponse.json(
        organizations,
        headers ? { headers } : undefined,
      );
    }),
  );
}

describe("find_organizations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["sentry.io", "sentry.io"],
    ["us.sentry.io", "sentry.io"],
    ["de.sentry.io", "sentry.io"],
    ["example.sentry.io", "sentry.io"],
    ["example.my.sentry.io", "example.my.sentry.io"],
    ["sentry.example.com", "sentry.example.com"],
  ])("lists organizations from %s through %s", async (host, expectedHost) => {
    const requests: { url: string; authorization: string | null }[] = [];
    mswServer.use(
      http.get("*", ({ request }) => {
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        return HttpResponse.json([
          { id: "1", slug: "example", name: "Example" },
        ]);
      }),
    );

    const result = await findOrganizations.handler(
      { query: "example", cursor: null },
      getServerContext({ sentryHost: host, accessToken: "test-token" }),
    );

    expect(requests).toEqual([
      {
        url: `https://${expectedHost}/api/0/organizations/?per_page=25&query=example`,
        authorization: "Bearer test-token",
      },
    ]);
    expect(getStructuredContent(result)).toEqual({
      organizations: [{ slug: "example", webUrl: null, regionUrl: null }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("returns only the structured organization payload", async () => {
    const context = getServerContext();
    mockOrganizations([
      {
        id: "1",
        slug: "cloud-org",
        name: "Cloud Org",
        links: {
          organizationUrl: "https://sentry.io/cloud-org",
          regionUrl: "https://us.sentry.io",
        },
      },
      {
        id: "2",
        slug: "self-hosted-org",
        name: "Self-hosted Org",
      },
    ]);

    const params = prepareToolParams({
      tool: findOrganizations,
      params: { query: null, cursor: null },
      context,
    }) as Parameters<typeof findOrganizations.handler>[0];
    const result = await findOrganizations.handler(params, context);

    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "nextCursor": null,
        "organizations": [
          {
            "regionUrl": "https://us.sentry.io",
            "slug": "cloud-org",
            "webUrl": "https://sentry.io/cloud-org",
          },
          {
            "regionUrl": null,
            "slug": "self-hosted-org",
            "webUrl": null,
          },
        ],
      }
    `);
    assertStructuredOnlyResult(result);
  });

  it("maps a whitespace-only region URL to null", async () => {
    vi.spyOn(
      SentryApiService.prototype,
      "listOrganizations",
    ).mockResolvedValueOnce({
      organizations: [
        {
          id: "1",
          slug: "whitespace-region-org",
          name: "Whitespace Region Org",
          links: {
            organizationUrl: "https://sentry.io/whitespace-region-org",
            regionUrl: " \t\n ",
          },
        },
      ],
      nextCursor: null,
    });

    const result = await findOrganizations.handler(
      { query: null, cursor: null },
      getServerContext(),
    );

    expect(getStructuredContent(result)).toEqual({
      organizations: [
        {
          slug: "whitespace-region-org",
          webUrl: "https://sentry.io/whitespace-region-org",
          regionUrl: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    assertStructuredOnlyResult(result);
  });

  it("preserves search and cursor while returning a page of 25 organizations", async () => {
    mockOrganizations(
      Array.from({ length: 25 }, (_, index) => ({
        id: String(index + 1),
        slug: `organization-${index + 1}`,
        name: `Organization ${index + 1}`,
        links: {
          organizationUrl: `https://sentry.io/organization-${index + 1}`,
          regionUrl: "https://us.sentry.io",
        },
      })),
      {
        Link: '<https://sentry.io/api/0/organizations/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
      },
      { query: "example", cursor: "previous" },
    );

    const result = await findOrganizations.handler(
      { query: "example", cursor: "previous" },
      getServerContext(),
    );
    const structuredContent = getStructuredContent<{
      organizations: Array<{ slug: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>(result);

    expect(structuredContent.organizations).toHaveLength(25);
    expect(structuredContent.organizations.at(-1)?.slug).toBe(
      "organization-25",
    );
    expect(structuredContent.hasMore).toBe(true);
    expect(structuredContent.nextCursor).toBe("page-2");
    assertStructuredOnlyResult(result);
  });
});
