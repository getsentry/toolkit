import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { UserInputError } from "../../errors.js";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import deleteCustomInboundFilter, {
  deleteCustomInboundFilterOutputSchema,
} from "./delete-custom-inbound-filter.js";

describe("delete_custom_inbound_filter", () => {
  it("deletes a custom inbound filter", async () => {
    const result = await deleteCustomInboundFilter.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        filterId: "4509100000002001",
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(
      deleteCustomInboundFilterOutputSchema.parse(structuredContent),
    ).toEqual(structuredContent);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "filterId": "4509100000002001",
        "projectSlug": "cloudflare-mcp",
        "success": true,
      }
    `);
  });

  it("treats a second delete 404 as success", async () => {
    mswServer.use(
      http.delete(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/custom-inbound-filters/4509100000002001/",
        () => new HttpResponse(null, { status: 404 }),
        { once: true },
      ),
    );

    const result = await deleteCustomInboundFilter.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        filterId: "4509100000002001",
      },
      getServerContext(),
    );

    expect(getStructuredContent(result)).toEqual({
      success: true,
      filterId: "4509100000002001",
      projectSlug: "cloudflare-mcp",
    });
  });

  it("rejects a project outside the active project constraint", async () => {
    await expect(
      deleteCustomInboundFilter.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "other-project",
          regionUrl: null,
          filterId: "4509100000002001",
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

  it("claims idempotency", () => {
    expect(deleteCustomInboundFilter.annotations.idempotentHint).toBe(true);
  });
});
