import {
  clientKeyFixture,
  mswServer,
  organizationFixture,
  projectFixture,
} from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { afterEach, describe, it, expect } from "vitest";
import { z } from "zod";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import createProject, { createProjectOutputSchema } from "./create-project.js";

function getOutput(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  const parsed = createProjectOutputSchema.parse(content);
  expect(parsed).toEqual(content);
  return parsed;
}

const context = {
  constraints: {
    organizationSlug: null,
    projectSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("create_project", () => {
  afterEach(() => {
    mswServer.resetHandlers();
  });

  it("serializes with the existing default DSN", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json({ detail: "unexpected fallback" }, { status: 500 }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );
    const output = getOutput(result);
    expect(output).toMatchInlineSnapshot(`
      {
        "dsn": "https://d20df0a1ab5031c7f3c7edca9c02814d@o4509106732793856.ingest.us.sentry.io/4509109104082945",
        "project": {
          "id": "4509109104082945",
          "name": "cloudflare-mcp",
          "slug": "cloudflare-mcp",
        },
        "repository": null,
        "setup": {
          "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/node/",
          "platform": "Node.js",
          "signals": [
            {
              "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/node/",
              "name": "Errors",
              "recommended": true,
              "usefulFor": "Exceptions and crashes, with stack traces",
            },
            {
              "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/node/tracing/",
              "name": "Traces",
              "recommended": true,
              "usefulFor": "Following requests, services, and agent runs end to end",
            },
            {
              "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/node/logs/",
              "name": "Logs",
              "usefulFor": "App context around failures, linked to traces",
            },
            {
              "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/node/metrics/",
              "name": "Metrics",
              "usefulFor": "Tracking and alerting on app and business health",
            },
          ],
        },
        "suggestedActions": [],
      }
    `);
    // Only the public DSN is exposed; secret keys and other key metadata stay private.
    const text = JSON.stringify(result);
    expect(text).not.toContain(clientKeyFixture.secret);
    expect(text).not.toContain(clientKeyFixture.dsn.secret);
    expect(text).not.toContain(clientKeyFixture.dsn.security);
    expect(text).not.toContain("rateLimit");
  });

  it("uses an existing non-default DSN when no default key exists", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json([
            {
              ...clientKeyFixture,
              name: "Production",
              dsn: {
                public: "https://production@example.com/1",
              },
            },
          ]),
      ),
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json({ detail: "unexpected fallback" }, { status: 500 }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result).dsn).toBe("https://production@example.com/1");
  });

  it("creates a fallback default DSN when only inactive keys exist", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json([
            {
              ...clientKeyFixture,
              isActive: false,
              dsn: {
                public: "https://inactive@example.com/1",
              },
            },
          ]),
      ),
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json({
            ...clientKeyFixture,
            name: "Default",
            dsn: {
              public: "https://fallback@example.com/1",
            },
          }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result).dsn).toBe("https://fallback@example.com/1");
    expect(JSON.stringify(result)).not.toContain(
      "https://inactive@example.com/1",
    );
  });

  it("creates a fallback default DSN when no key exists", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () => HttpResponse.json([]),
      ),
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json({
            ...clientKeyFixture,
            name: "Default",
            dsn: {
              public: "https://fallback@example.com/1",
            },
          }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result).dsn).toBe("https://fallback@example.com/1");
  });

  it("creates a fallback default DSN when key listing fails after creation", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () => HttpResponse.json({ detail: "lookup failed" }, { status: 500 }),
      ),
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () =>
          HttpResponse.json({
            ...clientKeyFixture,
            name: "Default",
            dsn: {
              public: "https://fallback@example.com/1",
            },
          }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result).dsn).toBe("https://fallback@example.com/1");
  });

  it("returns project details when DSN setup fails after creation", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () => HttpResponse.json({ detail: "lookup failed" }, { status: 500 }),
      ),
      http.post(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () => HttpResponse.json({ detail: "create failed" }, { status: 500 }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result)).toMatchObject({
      project: { slug: "cloudflare-mcp" },
      dsn: null,
      repository: null,
      suggestedActions: [
        {
          type: "tool_call",
          toolName: "create_dsn",
          arguments: {
            organizationSlug: "sentry-mcp-evals",
            projectSlug: "cloudflare-mcp",
            name: "Default",
          },
        },
      ],
    });
  });

  it("keeps the region in the create_dsn suggestion when DSN setup fails", async () => {
    mswServer.use(
      http.post(
        "https://us.sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () => HttpResponse.json(projectFixture),
      ),
      http.get(
        "https://us.sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () => HttpResponse.json({ detail: "lookup failed" }, { status: 500 }),
      ),
      http.post(
        "https://us.sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/keys/",
        () => HttpResponse.json({ detail: "create failed" }, { status: 500 }),
      ),
      http.get(
        "https://us.sentry.io/api/0/organizations/sentry-mcp-evals/",
        () => HttpResponse.json(organizationFixture),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: "https://us.sentry.io",
        repository: null,
      },
      context,
    );

    expect(getOutput(result).suggestedActions).toEqual([
      {
        type: "tool_call",
        toolName: "create_dsn",
        arguments: {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: "https://us.sentry.io",
          projectSlug: "cloudflare-mcp",
          name: "Default",
        },
        reason: "The project was created without a DSN.",
      },
    ]);
  });

  it("lists only the setup signals the organization has enabled", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () =>
          HttpResponse.json({
            ...projectFixture,
            platform: "javascript-nextjs",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/",
        ({ request }) => {
          expect(
            new URL(request.url).searchParams.get("include_feature_flags"),
          ).toBe("1");
          return HttpResponse.json({
            ...organizationFixture,
            features: ["session-replay", "ourlogs-enabled"],
          });
        },
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "javascript-nextjs",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result).setup).toMatchInlineSnapshot(`
      {
        "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/nextjs/",
        "platform": "Next.js",
        "signals": [
          {
            "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/nextjs/",
            "name": "Errors",
            "recommended": true,
            "usefulFor": "Exceptions and crashes, with stack traces",
          },
          {
            "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/",
            "name": "Traces",
            "recommended": true,
            "usefulFor": "Following requests, services, and agent runs end to end",
          },
          {
            "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/nextjs/logs/",
            "name": "Logs",
            "usefulFor": "App context around failures, linked to traces",
          },
          {
            "docsUrl": "https://docs.sentry.io/platforms/javascript/guides/nextjs/session-replay/",
            "name": "Session Replay",
            "usefulFor": "Seeing what a user did before a bug",
          },
        ],
      }
    `);
  });

  it("lists every supported setup signal when organization features fail to load", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/sentry-mcp-evals/", () =>
        HttpResponse.json({ detail: "lookup failed" }, { status: 500 }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    const output = getOutput(result);
    expect(output.dsn).not.toBeNull();
    expect(output.setup?.signals.map((signal) => signal.name)).toEqual([
      "Errors",
      "Traces",
      "Logs",
      "Metrics",
    ]);
  });

  it("returns no setup knowledge without a platform", async () => {
    let organizationRequested = false;
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () => HttpResponse.json({ ...projectFixture, platform: null }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/",
        () => {
          organizationRequested = true;
          return HttpResponse.json(organizationFixture);
        },
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: null,
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result)).toMatchObject({
      setup: null,
      suggestedActions: [],
    });
    expect(organizationRequested).toBe(false);
  });

  it("uses the created project's platform when none is passed", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () =>
          HttpResponse.json({ ...projectFixture, platform: "python-django" }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: null,
        regionUrl: null,
        repository: null,
      },
      context,
    );

    const setup = getOutput(result).setup;
    expect(setup).toMatchObject({
      platform: "Django",
      docsUrl: "https://docs.sentry.io/platforms/python/integrations/django/",
    });
    // Integration pages take their signals from the Python SDK page.
    expect(setup?.signals.map((signal) => signal.docsUrl)).toEqual([
      "https://docs.sentry.io/platforms/python/integrations/django/",
      "https://docs.sentry.io/platforms/python/tracing/",
      "https://docs.sentry.io/platforms/python/logs/",
      "https://docs.sentry.io/platforms/python/metrics/",
    ]);
  });

  it("returns no setup knowledge for a platform without a setup guide", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () => HttpResponse.json({ ...projectFixture, platform: "other" }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "other",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(getOutput(result)).toMatchObject({
      dsn: expect.any(String),
      setup: null,
      suggestedActions: [],
    });
  });

  it("passes an optional slug through project creation", async () => {
    let createBody: unknown;
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json({
            ...projectFixture,
            name: "My Project",
            slug: "my-project",
            platform: "node",
          });
        },
      ),
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/my-project/keys/",
        () => HttpResponse.json([clientKeyFixture]),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "My Project",
        slug: "my-project",
        platform: "node",
        regionUrl: null,
        repository: null,
      },
      context,
    );

    expect(createBody).toEqual({
      name: "My Project",
      slug: "my-project",
      platform: "node",
    });
    expect(getOutput(result).project.slug).toBe("my-project");
  });

  it("sends Sentry's platform ID when the agent passes a rejected alias", async () => {
    let createBody: unknown;
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json({
            ...projectFixture,
            platform: "apple-ios",
          });
        },
      ),
    );

    const params = z.object(createProject.inputSchema).parse({
      organizationSlug: "sentry-mcp-evals",
      teamSlug: "the-goats",
      name: "cloudflare-mcp",
      platform: "cocoa-ios",
    });
    await createProject.handler(params, context);

    expect(createBody).toEqual({
      name: "cloudflare-mcp",
      platform: "apple-ios",
    });
  });

  it("links a matching repository when provided", async () => {
    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: "getsentry/sentry",
      },
      context,
    );

    expect(getOutput(result).repository).toEqual({
      name: "getsentry/sentry",
      linked: true,
    });
  });

  it("prefers an exact repository name over suffix matches", async () => {
    let mappingBody: unknown;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/repos/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("query")).toBeNull();
          return HttpResponse.json([
            {
              id: "101",
              name: "mirror/getsentry/sentry",
              provider: { id: "integrations:github", name: "GitHub" },
              status: "active",
            },
            {
              id: "102",
              name: "getsentry/sentry",
              provider: { id: "integrations:github", name: "GitHub" },
              status: "active",
            },
          ]);
        },
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/code-mappings/bulk/",
        async ({ request }) => {
          mappingBody = await request.json();
          return HttpResponse.json({
            created: 1,
            updated: 0,
            errors: 0,
            mappings: [{ stackRoot: "", sourceRoot: "", status: "created" }],
          });
        },
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: "getsentry/sentry",
      },
      context,
    );

    expect(mappingBody).toMatchObject({ repository: "getsentry/sentry" });
    expect(getOutput(result).repository).toEqual({
      name: "getsentry/sentry",
      linked: true,
    });
  });

  it("returns project setup details when repository linking fails after creation", async () => {
    mswServer.use(
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/code-mappings/bulk/",
        () => HttpResponse.json({ detail: "link failed" }, { status: 500 }),
      ),
    );

    const result = await createProject.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        teamSlug: "the-goats",
        name: "cloudflare-mcp",
        slug: null,
        platform: "node",
        regionUrl: null,
        repository: "getsentry/sentry",
      },
      context,
    );

    expect(getOutput(result)).toMatchObject({
      project: { slug: "cloudflare-mcp" },
      dsn: expect.any(String),
      repository: { name: "getsentry/sentry", linked: false },
      suggestedActions: [],
    });
  });

  it("rejects an unknown repository before creating the project", async () => {
    let createCalls = 0;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/repos/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("query")).toBeNull();
          return HttpResponse.json([]);
        },
      ),
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () => {
          createCalls += 1;
          return HttpResponse.json(
            { detail: "unexpected create" },
            { status: 500 },
          );
        },
      ),
    );

    await expect(
      createProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          teamSlug: "the-goats",
          name: "cloudflare-mcp",
          slug: null,
          platform: "node",
          regionUrl: null,
          repository: "missing/repo",
        },
        context,
      ),
    ).rejects.toThrow('Could not find repository "missing/repo"');
    expect(createCalls).toBe(0);
  });

  it("rejects an ambiguous repository before creating the project", async () => {
    let createCalls = 0;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/repos/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("query")).toBeNull();
          return HttpResponse.json([
            {
              id: "101",
              name: "getsentry/sentry",
              provider: { id: "integrations:github", name: "GitHub" },
              status: "active",
            },
            {
              id: "102",
              name: "other/sentry",
              provider: { id: "integrations:github", name: "GitHub" },
              status: "active",
            },
          ]);
        },
      ),
      http.post(
        "https://sentry.io/api/0/teams/sentry-mcp-evals/the-goats/projects/",
        () => {
          createCalls += 1;
          return HttpResponse.json(
            { detail: "unexpected create" },
            { status: 500 },
          );
        },
      ),
    );

    await expect(
      createProject.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          teamSlug: "the-goats",
          name: "cloudflare-mcp",
          slug: null,
          platform: "node",
          regionUrl: null,
          repository: "sentry",
        },
        context,
      ),
    ).rejects.toThrow('Repository "sentry" matched multiple repositories');
    expect(createCalls).toBe(0);
  });

  it("accepts slug and repository linking parameters", () => {
    expect(createProject.inputSchema).toHaveProperty("slug");
    expect(createProject.inputSchema).toHaveProperty("repository");
    expect(createProject.description).toContain("repository");
  });
});
