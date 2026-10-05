import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { UserInputError } from "../../errors.js";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import createCustomInboundFilter, {
  createCustomInboundFilterOutputSchema,
} from "./create-custom-inbound-filter.js";

describe("create_custom_inbound_filter", () => {
  it("creates a filter and returns it as structured content", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/",
        async ({ request }) => {
          await expect(request.json()).resolves.toEqual({
            name: "Drop debug logs",
            active: false,
            dataType: "log",
            conditions: [{ type: "log_message", value: ["*DEBUG*"] }],
          });
          return HttpResponse.json(
            {
              id: 4509100000002002,
              name: "Drop debug logs",
              active: false,
              dataType: "log",
              conditions: [{ type: "log_message", value: ["*DEBUG*"] }],
              dateCreated: "2026-10-01T12:00:00.000000Z",
              dateUpdated: "2026-10-01T12:00:00.000000Z",
              legacyFilter: "must-not-leak",
            },
            { status: 201 },
          );
        },
        { once: true },
      ),
    );

    const result = await createCustomInboundFilter.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        name: "Drop debug logs",
        dataType: "log",
        conditions: [{ type: "log_message", value: ["*DEBUG*"] }],
        active: false,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(
      createCustomInboundFilterOutputSchema.parse(structuredContent),
    ).toEqual(structuredContent);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "filter": {
          "active": false,
          "conditions": [
            {
              "type": "log_message",
              "value": [
                "*DEBUG*",
              ],
            },
          ],
          "dataType": "log",
          "dateCreated": "2026-10-01T12:00:00.000000Z",
          "dateUpdated": "2026-10-01T12:00:00.000000Z",
          "id": "4509100000002002",
          "name": "Drop debug logs",
        },
      }
    `);
  });

  it("rejects a condition the data type does not carry before calling Sentry", async () => {
    await expect(
      createCustomInboundFilter.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: null,
          name: "Bad filter",
          dataType: "all",
          conditions: [{ type: "error_message", value: ["*boom*"] }],
          active: true,
        },
        getServerContext(),
      ),
    ).rejects.toThrow(
      "A filter on all data cannot use the error_message condition. It accepts release, ip_address.",
    );
  });

  it("explains a missing feature instead of a bare 400", async () => {
    mswServer.use(
      http.post(
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
      createCustomInboundFilter.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: null,
          name: "Ignore timeouts",
          dataType: "error",
          conditions: [{ type: "error_type", value: ["TimeoutError"] }],
          active: true,
        },
        getServerContext(),
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("passes other validation errors through unchanged", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/",
        () =>
          HttpResponse.json(
            {
              detail:
                "A filter's condition values can have at most 4000 characters in total.",
            },
            { status: 400 },
          ),
        { once: true },
      ),
    );

    await expect(
      createCustomInboundFilter.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: null,
          name: "Too big",
          dataType: "error",
          conditions: [{ type: "error_message", value: ["*"] }],
          active: true,
        },
        getServerContext(),
      ),
    ).rejects.toThrow(/at most 4000 characters/);
  });
});
