import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { UserInputError } from "../../errors.js";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import findCustomInboundFilters, {
  findCustomInboundFiltersOutputSchema,
} from "./find-custom-inbound-filters.js";

describe("find_custom_inbound_filters", () => {
  it("returns the project's custom inbound filters as structured content", async () => {
    const result = await findCustomInboundFilters.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        cursor: null,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(
      findCustomInboundFiltersOutputSchema.parse(structuredContent),
    ).toEqual(structuredContent);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "filters": [
          {
            "active": true,
            "conditions": [
              {
                "type": "error_type",
                "value": [
                  "ConnectionError",
                  "TimeoutError",
                ],
              },
              {
                "type": "release",
                "value": [
                  "my-app@2.1.*",
                ],
              },
            ],
            "dataType": "error",
            "dateCreated": "2026-09-25T10:00:00.000000Z",
            "dateUpdated": "2026-09-26T08:30:00.000000Z",
            "id": "4509100000002001",
            "name": "Ignore flaky connection errors",
          },
        ],
        "hasMore": false,
        "nextCursor": null,
      }
    `);
  });

  it("follows the Link header for the next page and drops backend-only fields", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("per_page")).toBe("25");
          return HttpResponse.json(
            [
              {
                id: 7,
                name: null,
                active: false,
                dataType: "all",
                conditions: [{ type: "ip_address", value: ["10.0.0.0/8"] }],
                dateCreated: "2026-09-25T10:00:00.000000Z",
                dateUpdated: "2026-09-25T10:00:00.000000Z",
                legacyFilter: "must-not-leak",
              },
            ],
            {
              headers: {
                link: '<https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0"',
              },
            },
          );
        },
        { once: true },
      ),
    );

    const result = await findCustomInboundFilters.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        cursor: null,
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      filters: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor: string | null;
    }>(result);
    expect(structuredContent.hasMore).toBe(true);
    expect(structuredContent.nextCursor).toBe("0:25:0");
    expect(structuredContent.filters[0]?.id).toBe("7");
    expect(structuredContent.filters[0]).not.toHaveProperty("legacyFilter");
  });

  it("explains a missing feature instead of a bare 400", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/",
        () =>
          HttpResponse.json(
            { detail: "You do not have that feature enabled" },
            { status: 400 },
          ),
        { once: true },
      ),
    );

    await expect(
      findCustomInboundFilters.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: null,
          cursor: null,
        },
        getServerContext(),
      ),
    ).rejects.toThrow(
      /Custom inbound filters are not enabled for this organization/,
    );
  });

  it("rejects a project outside the active project constraint", async () => {
    await expect(
      findCustomInboundFilters.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "other-project",
          regionUrl: null,
          cursor: null,
        },
        getServerContext({
          constraints: {
            organizationSlug: "sentry-mcp-evals",
            projectSlug: "cloudflare-mcp",
          },
        }),
      ),
    ).rejects.toThrow(UserInputError);
  });
});
