import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { afterEach, describe, it, expect } from "vitest";
import { UserInputError } from "../../errors.js";
import { ApiClientError } from "../../api-client";
import updateProject from "./update-project.js";
import { prepareToolParams } from "../catalog-runtime/availability";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";

const context = {
  constraints: {
    organizationSlug: null,
    projectSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("update_project", () => {
  afterEach(() => {
    mswServer.resetHandlers();
  });

  it.each([400, 403, 404])(
    "preserves API client errors for HTTP %i",
    async (status) => {
      mswServer.use(
        http.put(
          "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
          () =>
            HttpResponse.json(
              { detail: "Project update rejected" },
              { status },
            ),
        ),
      );
      const result = updateProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          name: "New name",
          slug: null,
          platform: null,
          regionUrl: null,
        },
        context,
      );
      await expect(result).rejects.toBeInstanceOf(ApiClientError);
      await expect(result).rejects.toMatchObject({
        status,
        message: "Project update rejected",
      });
    },
  );

  it("updates name and platform", async () => {
    mswServer.use(
      http.put(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        async ({ request }) => {
          expect(await request.json()).toEqual({
            name: "New Project Name",
            platform: "python",
          });
          return HttpResponse.json({
            id: 4509109104082945,
            slug: "cloudflare-mcp",
            name: "New Project Name",
            platform: "python",
          });
        },
      ),
    );

    const result = await updateProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        name: "New Project Name",
        slug: null,
        platform: "python",
        regionUrl: null,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "project": {
          "id": "4509109104082945",
          "name": "New Project Name",
          "platform": "python",
          "slug": "cloudflare-mcp",
        },
      }
    `);
  });

  it("preserves mixed-case slugs in project update requests", async () => {
    const paths: string[] = [];
    let updateBody: unknown;
    mswServer.use(
      http.put("https://sentry.io/api/0/projects/*/*/", async ({ request }) => {
        paths.push(new URL(request.url).pathname);
        updateBody = await request.json();
        return HttpResponse.json({
          id: "4509109104082945",
          slug: "NewProject",
          name: "New Project",
          platform: "node",
        });
      }),
    );

    const params = prepareToolParams({
      tool: updateProject,
      params: {
        organizationSlug: " MyOrg ",
        regionUrl: null,
        projectSlug: " OldProject ",
        name: null,
        slug: " NewProject ",
        platform: null,
      },
      context,
    }) as Parameters<typeof updateProject.handler>[0];

    const result = await updateProject.handler(params, context);

    expect(paths).toEqual(["/api/0/projects/MyOrg/OldProject/"]);
    expect(updateBody).toEqual({ slug: "NewProject" });
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      project: {
        id: "4509109104082945",
        slug: "NewProject",
        name: "New Project",
        platform: "node",
      },
    });
  });

  it("rejects calls without metadata fields", async () => {
    await expect(
      updateProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          name: null,
          slug: null,
          platform: null,
          regionUrl: null,
        },
        context,
      ),
    ).rejects.toThrow(UserInputError);

    await expect(
      updateProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          name: null,
          slug: null,
          platform: null,
          regionUrl: null,
        },
        context,
      ),
    ).rejects.toThrow("At least one project metadata field is required");
  });

  it("rejects slug updates from project-scoped sessions", async () => {
    await expect(
      updateProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          name: null,
          slug: "new-project-slug",
          platform: null,
          regionUrl: null,
        },
        {
          ...context,
          constraints: {
            organizationSlug: null,
            projectSlug: "cloudflare-mcp",
          },
        },
      ),
    ).rejects.toThrow(UserInputError);

    await expect(
      updateProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          name: null,
          slug: "new-project-slug",
          platform: null,
          regionUrl: null,
        },
        {
          ...context,
          constraints: {
            organizationSlug: null,
            projectSlug: "cloudflare-mcp",
          },
        },
      ),
    ).rejects.toThrow("organization-scoped or unconstrained session");
  });

  it("does not expose team assignment parameters", () => {
    expect(updateProject.inputSchema).not.toHaveProperty("teamSlug");
    expect(updateProject.description).not.toContain("teamSlug");
  });

  it("does not claim idempotency because slug renames invalidate the old slug", () => {
    expect(updateProject.annotations.idempotentHint).toBe(false);
  });
});
