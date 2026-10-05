import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import deleteAlertRule from "./delete-alert-rule";

const context = createTestContext();
const params = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  ruleId: "123",
};
const endpoint =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/123/";
const projectId = "4509109104082945";
const scopedContext = createTestContext({
  constraints: { projectSlug: "cloudflare-mcp" },
});

function useDeleteHandler(status = 204) {
  const writes: string[] = [];
  mswServer.use(
    http.delete(endpoint, ({ request }) => {
      writes.push(request.url);
      return new HttpResponse(null, { status });
    }),
  );
  return writes;
}

function useProjectScope(projectIds: string[], includesAllProjects = false) {
  mswServer.use(
    http.get(`${endpoint}project-scope/`, () =>
      HttpResponse.json({ projectIds, includesAllProjects }),
    ),
  );
}

describe("delete_alert_rule", () => {
  it("deletes an Alert exclusively affecting the constrained project", async () => {
    const writes = useDeleteHandler();
    useProjectScope([projectId]);
    const result = await deleteAlertRule.handler(params, scopedContext);

    expect(writes).toEqual([endpoint]);
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "ruleId": "123",
        "success": true,
      }
    `);
  });

  it.each([
    { projectIds: [projectId, "200"], includesAllProjects: false },
    { projectIds: [projectId], includesAllProjects: true },
    { projectIds: [], includesAllProjects: false },
  ])("rejects unsafe project scope %j before deleting", async (scope) => {
    const writes = useDeleteHandler();
    useProjectScope(scope.projectIds, scope.includesAllProjects);
    await expect(
      deleteAlertRule.handler(params, scopedContext),
    ).rejects.toThrow("outside the active project constraint");
    expect(writes).toEqual([]);
  });

  it("does not report success for a missing Alert", async () => {
    useDeleteHandler(404);
    await expect(
      deleteAlertRule.handler(params, context),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
