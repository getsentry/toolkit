import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { getServerContext } from "../../test-setup";
import {
  getFilteredInputSchema,
  prepareToolCallParams,
} from "../../tools/catalog-runtime/availability";
import type { ToolConfig } from "../../tools/types";
import type { CredentialRouter, ServerContext } from "../../types";

const requiredOrgTool: ToolConfig<any> = {
  name: "required_org_tool",
  title: "Required Org Tool",
  description: "required_org_tool description",
  skills: ["inspect"],
  requiredScopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    query: z.string().default("is:unresolved"),
  },
  handler: async () => "ok",
};

const optionalOrgTool: ToolConfig<any> = {
  ...requiredOrgTool,
  name: "optional_org_tool",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    issueUrl: z.string().optional(),
    issueId: z.string().optional(),
  },
};

function organization(slug: string, regionUrl = "https://us.sentry.io") {
  return {
    id: slug,
    slug,
    name: slug,
    links: { organizationUrl: `https://${slug}.sentry.io`, regionUrl },
  };
}

/** Serve the organization list and count how often it is requested. */
function serveOrganizations(
  organizations: ReturnType<typeof organization>[],
  { hasMore = false }: { hasMore?: boolean } = {},
) {
  const requests: string[] = [];
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/", ({ request }) => {
      requests.push(request.headers.get("authorization") ?? "");
      return HttpResponse.json(organizations, {
        headers: hasMore
          ? {
              Link: '<https://sentry.io/api/0/organizations/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0"',
            }
          : {},
      });
    }),
  );
  return requests;
}

async function prepare(
  tool: ToolConfig<any>,
  params: Record<string, unknown>,
  context: ServerContext = getServerContext({ sentryHost: "sentry.io" }),
) {
  return await prepareToolCallParams({ tool, params, context });
}

describe("applyDefaultOrganization", () => {
  afterEach(() => {
    mswServer.resetHandlers();
  });

  it("makes a required organizationSlug optional unless a constraint sets it", () => {
    const unscoped = getFilteredInputSchema(
      requiredOrgTool,
      getServerContext(),
    );
    expect(unscoped.organizationSlug?.safeParse(undefined).success).toBe(true);
    expect(unscoped.organizationSlug?.safeParse("").success).toBe(false);

    const scoped = getFilteredInputSchema(
      requiredOrgTool,
      getServerContext({ constraints: { organizationSlug: "my-org" } }),
    );
    expect(scoped).not.toHaveProperty("organizationSlug");
  });

  it("uses the only organization and its region", async () => {
    serveOrganizations([organization("solo-org", "https://de.sentry.io")]);

    await expect(prepare(requiredOrgTool, {})).resolves.toEqual({
      organizationSlug: "solo-org",
      regionUrl: "https://de.sentry.io",
      query: "is:unresolved",
    });
  });

  it("keeps a regionUrl the caller passed", async () => {
    serveOrganizations([organization("solo-org", "https://de.sentry.io")]);

    await expect(
      prepare(requiredOrgTool, { regionUrl: "https://us.sentry.io" }),
    ).resolves.toMatchObject({
      organizationSlug: "solo-org",
      regionUrl: "https://us.sentry.io",
    });
  });

  it("leaves regionUrl unset when the organization has none (self-hosted)", async () => {
    const requests: string[] = [];
    mswServer.use(
      http.get("https://sentry.example.com/api/0/organizations/", () => {
        requests.push("self-hosted");
        return HttpResponse.json([organization("acme", "")]);
      }),
    );

    await expect(
      prepare(
        requiredOrgTool,
        {},
        getServerContext({ sentryHost: "sentry.example.com" }),
      ),
    ).resolves.toEqual({
      organizationSlug: "acme",
      regionUrl: null,
      query: "is:unresolved",
    });
    expect(requests).toEqual(["self-hosted"]);
  });

  it("lists the organizations once per context", async () => {
    const requests = serveOrganizations([organization("solo-org")]);
    const context = getServerContext({ sentryHost: "sentry.io" });

    await prepare(requiredOrgTool, {}, context);
    await prepare(requiredOrgTool, { query: "is:resolved" }, context);

    expect(requests).toHaveLength(1);
  });

  it("does not list organizations when the call names one", async () => {
    const requests = serveOrganizations([organization("solo-org")]);

    await expect(
      prepare(requiredOrgTool, { organizationSlug: "my-org" }),
    ).resolves.toMatchObject({ organizationSlug: "my-org" });
    await expect(
      prepare(optionalOrgTool, {
        issueUrl: "https://other-org.sentry.io/issues/PROJ-1/",
      }),
    ).resolves.not.toHaveProperty("organizationSlug");
    expect(requests).toHaveLength(0);
  });

  it("defaults a required slug even when the tool's url is an external one", async () => {
    serveOrganizations([organization("solo-org")]);
    const uptimeLikeTool: ToolConfig<any> = {
      ...requiredOrgTool,
      name: "uptime_like_tool",
      inputSchema: {
        organizationSlug: ParamOrganizationSlug,
        url: z.string().url(),
      },
    };

    await expect(
      prepare(uptimeLikeTool, { url: "https://example.com/health" }),
    ).resolves.toEqual({
      organizationSlug: "solo-org",
      url: "https://example.com/health",
    });
  });

  it("fails with a ready-to-run retry when there are several organizations", async () => {
    serveOrganizations([
      organization("org-a"),
      organization("org-b"),
      organization("org-c"),
    ]);

    await expect(prepare(requiredOrgTool, { query: "is:resolved" })).rejects
      .toThrowErrorMatchingInlineSnapshot(`
      [UserInputError: \`organizationSlug\` is required: you can access more than one organization, so none was picked.

      Retry example: \`required_org_tool(organizationSlug='org-a', query='is:resolved')\`
      Other available organizations: org-b, org-c]
    `);
  });

  it("writes the retry as execute_sentry_tool for a catalog tool", async () => {
    serveOrganizations(
      Array.from({ length: 25 }, (_, index) => organization(`org-${index}`)),
      { hasMore: true },
    );
    const context = getServerContext({
      sentryHost: "sentry.io",
      directToolNames: new Set(["execute_sentry_tool"]),
    });

    const error = await prepare(
      requiredOrgTool,
      { query: "is:resolved" },
      context,
    ).catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `Retry example: \`execute_sentry_tool(name='required_org_tool', arguments={"organizationSlug":"org-0","query":"is:resolved"})\``,
    );
    expect(String(error)).toContain(
      "More organizations exist. Use `find_organizations(query='...')` to search them.",
    );
  });

  it("leaves default values out of the retry", async () => {
    serveOrganizations([organization("org-a"), organization("org-b")]);

    await expect(
      prepare(requiredOrgTool, { query: "is:unresolved", regionUrl: null }),
    ).rejects.toThrow("`required_org_tool(organizationSlug='org-a')`");
  });

  it("leaves an optional organizationSlug unset when there are several", async () => {
    serveOrganizations([organization("org-a"), organization("org-b")]);

    await expect(
      prepare(optionalOrgTool, { issueId: "PROJ-1" }),
    ).resolves.toEqual({ issueId: "PROJ-1" });
  });

  it("fills an optional organizationSlug when there is only one", async () => {
    serveOrganizations([organization("solo-org")]);

    await expect(
      prepare(optionalOrgTool, { issueId: "PROJ-1" }),
    ).resolves.toEqual({ issueId: "PROJ-1", organizationSlug: "solo-org" });
  });

  it("falls back to the find_organizations hint when listing fails", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/", () =>
        HttpResponse.json({ detail: "Forbidden" }, { status: 403 }),
      ),
    );

    await expect(prepare(requiredOrgTool, {})).rejects.toThrow(
      "Invalid arguments for required_org_tool: organizationSlug: Required. Call `find_organizations()`",
    );
    await expect(
      prepare(optionalOrgTool, { issueId: "PROJ-1" }),
    ).resolves.toEqual({ issueId: "PROJ-1" });
  });

  it("does not default when another login cannot list its organizations", async () => {
    const requests: string[] = [];
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/", ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        requests.push(authorization);
        return authorization === "Bearer work-token"
          ? HttpResponse.json([organization("work-org")])
          : HttpResponse.json({ detail: "Internal error" }, { status: 500 });
      }),
    );
    const credentials = [
      { id: "work", accessToken: "work-token" },
      { id: "personal", accessToken: "personal-token" },
    ];
    const context = getServerContext({
      sentryHost: "sentry.io",
      credentialRouter: {
        resolve: async () => credentials[0]!,
        list: async () => credentials,
      },
    });

    await expect(prepare(requiredOrgTool, {}, context)).rejects
      .toThrowErrorMatchingInlineSnapshot(`
      [UserInputError: \`organizationSlug\` is required: some logins could not list their organizations, so none was picked.

      Retry example: \`required_org_tool(organizationSlug='work-org')\`
      Call \`find_organizations()\` to check which organizations each login can access.]
    `);
    await expect(
      prepare(optionalOrgTool, { issueId: "PROJ-1" }, context),
    ).resolves.toEqual({ issueId: "PROJ-1" });
    // A partial list is not kept, so the next call asks every login again.
    const workRequests = requests.filter((r) => r === "Bearer work-token");
    expect(workRequests).toHaveLength(2);
  });

  it("counts every login's organizations once", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer work-token"
            ? [organization("shared-org")]
            : [organization("shared-org"), organization("side-org")],
        ),
      ),
    );
    const credentials = [
      { id: "work", accessToken: "work-token" },
      { id: "personal", accessToken: "personal-token" },
    ];
    const credentialRouter: CredentialRouter = {
      resolve: async () => credentials[0]!,
      list: async () => credentials,
    };
    const context = getServerContext({
      sentryHost: "sentry.io",
      credentialRouter,
    });

    await expect(prepare(requiredOrgTool, {}, context)).rejects.toThrow(
      "Other available organizations: side-org",
    );
  });
});
