import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import deleteMonitorEnvironment, {
  deleteMonitorEnvironmentOutputSchema,
} from "./delete-monitor-environment.js";

const context = {
  constraints: { organizationSlug: null },
  accessToken: "access-token",
  userId: "1",
};
const params = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  projectSlug: "cloudflare-mcp",
  monitorSlug: "nightly-import",
  environment: "production",
};
const endpoint =
  "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/environments/production/";

describe("delete_monitor_environment", () => {
  it("schedules deletion of an exact monitor environment", async () => {
    const result = await deleteMonitorEnvironment.handler(params, context);
    assertStructuredOnlyResult(result);
    const content = getStructuredContent(result);
    expect(deleteMonitorEnvironmentOutputSchema.parse(content)).toEqual(
      content,
    );
    expect(content).toMatchInlineSnapshot(`
      {
        "environment": "production",
        "monitorSlug": "nightly-import",
        "projectSlug": "cloudflare-mcp",
        "success": true,
      }
    `);
  });

  it("treats an absent or pending deletion environment as success", async () => {
    mswServer.use(
      http.delete(endpoint, () => new HttpResponse(null, { status: 404 })),
    );
    const result = await deleteMonitorEnvironment.handler(params, context);
    expect(getStructuredContent(result)).toEqual({
      success: true,
      monitorSlug: params.monitorSlug,
      projectSlug: params.projectSlug,
      environment: params.environment,
    });
  });

  it.each([403, 500])("propagates HTTP %s failures", async (status) => {
    mswServer.use(
      http.delete(endpoint, () =>
        HttpResponse.json({ detail: "Request failed" }, { status }),
      ),
    );
    await expect(
      deleteMonitorEnvironment.handler(params, context),
    ).rejects.toThrow();
  });

  it("rejects a project outside the active constraint before deletion", async () => {
    const remove = vi.fn(() => new HttpResponse(null, { status: 202 }));
    mswServer.use(http.delete(endpoint, remove));
    await expect(
      deleteMonitorEnvironment.handler(params, {
        ...context,
        constraints: { organizationSlug: null, projectSlug: "other-project" },
      }),
    ).rejects.toThrow("outside the active project constraint");
    expect(remove).not.toHaveBeenCalled();
  });

  it("preserves exact environment names and encodes path delimiters", async () => {
    const environment = " Production #? ";
    const remove = vi.fn(({ request }: { request: Request }) => {
      expect(request.url).toBe(
        `${endpoint.slice(0, -"production/".length)}${encodeURIComponent(environment)}/`,
      );
      return new HttpResponse(null, { status: 202 });
    });
    mswServer.use(
      http.delete(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/monitors/nightly-import/environments/:environment/",
        remove,
      ),
    );
    const parsed = z
      .object(deleteMonitorEnvironment.inputSchema)
      .parse({ ...params, environment });
    const result = await deleteMonitorEnvironment.handler(parsed, context);
    expect(getStructuredContent(result)).toMatchObject({ environment });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("requires a nonempty environment", () => {
    expect(
      z
        .object(deleteMonitorEnvironment.inputSchema)
        .safeParse({ ...params, environment: "" }).success,
    ).toBe(false);
  });
});
