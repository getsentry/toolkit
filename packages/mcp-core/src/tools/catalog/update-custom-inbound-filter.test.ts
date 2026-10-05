import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { UserInputError } from "../../errors.js";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import updateCustomInboundFilter, {
  updateCustomInboundFilterOutputSchema,
} from "./update-custom-inbound-filter.js";

describe("update_custom_inbound_filter", () => {
  it("sends only the provided fields and returns the updated filter", async () => {
    mswServer.use(
      http.put(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/4509100000002001/",
        async ({ request }) => {
          await expect(request.json()).resolves.toEqual({ active: false });
          return HttpResponse.json({
            id: "4509100000002001",
            name: "Ignore flaky connection errors",
            active: false,
            dataType: "error",
            conditions: [
              {
                type: "error_type",
                value: ["ConnectionError", "TimeoutError"],
              },
            ],
            dateCreated: "2026-09-25T10:00:00.000000Z",
            dateUpdated: "2026-10-02T09:00:00.000000Z",
          });
        },
        { once: true },
      ),
    );

    const result = await updateCustomInboundFilter.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        filterId: "4509100000002001",
        active: false,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(
      updateCustomInboundFilterOutputSchema.parse(structuredContent),
    ).toEqual(structuredContent);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "filter": {
          "active": false,
          "conditions": [
            {
              "type": "error_type",
              "value": [
                "ConnectionError",
                "TimeoutError",
              ],
            },
          ],
          "dataType": "error",
          "dateCreated": "2026-09-25T10:00:00.000000Z",
          "dateUpdated": "2026-10-02T09:00:00.000000Z",
          "id": "4509100000002001",
          "name": "Ignore flaky connection errors",
        },
      }
    `);
  });

  it("replaces the conditions through the default mock", async () => {
    const result = await updateCustomInboundFilter.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        filterId: "4509100000002001",
        conditions: [
          { type: "error_message", value: ["*ConnectionError*", "*Timeout*"] },
        ],
      },
      getServerContext(),
    );

    const structuredContent = getStructuredContent<{
      filter: { conditions: Array<{ type: string; value: string[] }> };
    }>(result);
    expect(structuredContent.filter.conditions).toEqual([
      { type: "error_message", value: ["*ConnectionError*", "*Timeout*"] },
    ]);
  });

  it("throws when no field is provided", async () => {
    await expect(
      updateCustomInboundFilter.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: null,
          filterId: "4509100000002001",
        },
        getServerContext(),
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("rejects conditions that the new data type does not accept", async () => {
    await expect(
      updateCustomInboundFilter.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: null,
          filterId: "4509100000002001",
          dataType: "metric",
          conditions: [{ type: "log_message", value: ["*DEBUG*"] }],
        },
        getServerContext(),
      ),
    ).rejects.toThrow(
      "A filter on metric data cannot use the log_message condition. It accepts metric_name, release, ip_address.",
    );
  });

  it("claims idempotency", () => {
    expect(updateCustomInboundFilter.annotations.idempotentHint).toBe(true);
  });
});
