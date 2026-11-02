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

  describe("with several logins", () => {
    /** One credential per login, the default first. */
    function routedContext(ids: string[]) {
      return getServerContext({
        sentryHost: "sentry.io",
        credentialRouter: {
          resolve: async () => ({
            id: ids[0] ?? "a",
            accessToken: `${ids[0]}-token`,
          }),
          list: async () =>
            ids.map((id) => ({ id, accessToken: `${id}-token` })),
        },
      });
    }

    /** Each token's org pages; a cursor names the page after the first. */
    function mockAccountOrganizations(
      pages: Record<string, Record<string, string[]>>,
      next: Record<string, Record<string, string>> = {},
    ) {
      const requests: Array<{ token: string; cursor: string | null }> = [];
      mswServer.use(
        http.get("https://sentry.io/api/0/organizations/", ({ request }) => {
          const token = (request.headers.get("authorization") ?? "").replace(
            "Bearer ",
            "",
          );
          const cursor = new URL(request.url).searchParams.get("cursor");
          requests.push({ token, cursor });
          const page = cursor ?? "first";
          const slugs = pages[token]?.[page];
          if (!slugs) {
            return HttpResponse.json(
              { detail: "Unauthorized" },
              { status: 401 },
            );
          }
          const nextCursor = next[token]?.[page];
          return HttpResponse.json(
            slugs.map((slug, index) => ({
              id: String(index),
              slug,
              name: slug,
            })),
            nextCursor
              ? {
                  headers: {
                    Link: `<https://sentry.io/api/0/organizations/?cursor=${nextCursor}>; rel="next"; results="true"; cursor="${nextCursor}"`,
                  },
                }
              : undefined,
          );
        }),
      );
      return requests;
    }

    it("lists organizations from every login, each once", async () => {
      mockAccountOrganizations({
        "a-token": { first: ["shared", "org-a"] },
        "b-token": { first: ["shared", "org-b"] },
      });

      const result = await findOrganizations.handler(
        { query: null, cursor: null },
        routedContext(["a", "b"]),
      );

      expect(
        getStructuredContent<{ organizations: Array<{ slug: string }> }>(
          result,
        ).organizations.map(({ slug }) => slug),
      ).toEqual(["shared", "org-a", "org-b"]);
    });

    it("continues only the logins with more pages", async () => {
      // A full page, so the listing stops there and hands out a cursor.
      const fullPage = Array.from({ length: 25 }, (_, i) => `org-b-${i}`);
      const requests = mockAccountOrganizations(
        {
          "a-token": { first: ["org-a"] },
          "b-token": { first: fullPage, "b-2": ["org-b-next"] },
        },
        { "b-token": { first: "b-2" } },
      );
      const context = routedContext(["a", "b"]);

      const first = getStructuredContent<{
        hasMore: boolean;
        nextCursor: string | null;
      }>(
        await findOrganizations.handler({ query: null, cursor: null }, context),
      );
      expect(first.hasMore).toBe(true);

      const second = getStructuredContent<{
        organizations: Array<{ slug: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      }>(
        await findOrganizations.handler(
          { query: null, cursor: first.nextCursor },
          context,
        ),
      );
      expect(second.organizations.map(({ slug }) => slug)).toEqual([
        "org-b-next",
      ]);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
      expect(requests.slice(2)).toEqual([{ token: "b-token", cursor: "b-2" }]);
    });

    it("lists an organization once across pages", async () => {
      const fullPage = Array.from({ length: 25 }, (_, i) => `org-b-${i}`);
      mockAccountOrganizations(
        {
          "a-token": { first: ["shared"] },
          "b-token": { first: fullPage, "b-2": ["shared", "org-b-last"] },
        },
        { "b-token": { first: "b-2" } },
      );
      const context = routedContext(["a", "b"]);

      const first = getStructuredContent<{ nextCursor: string | null }>(
        await findOrganizations.handler({ query: null, cursor: null }, context),
      );
      const second = getStructuredContent<{
        organizations: Array<{ slug: string }>;
      }>(
        await findOrganizations.handler(
          { query: null, cursor: first.nextCursor },
          context,
        ),
      );

      expect(second.organizations.map(({ slug }) => slug)).toEqual([
        "org-b-last",
      ]);
    });

    it("continues a multi-login cursor when only one login remains", async () => {
      const fullPage = Array.from({ length: 25 }, (_, i) => `org-b-${i}`);
      const requests = mockAccountOrganizations(
        {
          "a-token": { first: ["org-a"] },
          "b-token": { first: fullPage, "b-2": ["org-b-next"] },
        },
        { "b-token": { first: "b-2" } },
      );

      const first = getStructuredContent<{ nextCursor: string | null }>(
        await findOrganizations.handler(
          { query: null, cursor: null },
          routedContext(["a", "b"]),
        ),
      );
      const second = getStructuredContent<{
        organizations: Array<{ slug: string }>;
        nextCursor: string | null;
      }>(
        await findOrganizations.handler(
          { query: null, cursor: first.nextCursor },
          routedContext(["b"]),
        ),
      );

      expect(second.organizations.map(({ slug }) => slug)).toEqual([
        "org-b-next",
      ]);
      expect(second.nextCursor).toBeNull();
      expect(requests.slice(2)).toEqual([{ token: "b-token", cursor: "b-2" }]);
    });

    it("rejects a multi-login cursor without a credential router", async () => {
      const cursor = `accounts:${btoa(JSON.stringify({ cursors: { a: "a-2" }, seen: [] }))}`;
      await expect(
        findOrganizations.handler(
          { query: null, cursor },
          getServerContext({ sentryHost: "sentry.io" }),
        ),
      ).rejects.toThrow("Invalid cursor");
    });

    it("skips a login the server rejects", async () => {
      mockAccountOrganizations({ "a-token": { first: ["org-a"] } });

      const result = await findOrganizations.handler(
        { query: null, cursor: null },
        routedContext(["a", "expired"]),
      );

      expect(
        getStructuredContent<{ organizations: Array<{ slug: string }> }>(
          result,
        ).organizations.map(({ slug }) => slug),
      ).toEqual(["org-a"]);
    });

    it("rejects a cursor from a single-login listing", async () => {
      await expect(
        findOrganizations.handler(
          { query: null, cursor: "page-2" },
          routedContext(["a", "b"]),
        ),
      ).rejects.toThrow("Invalid cursor");
    });
  });
});
