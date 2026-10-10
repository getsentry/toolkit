import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { SentryApiService } from "../../../api-client";
import type { IssueIntegration } from "../../../api-client/types";
import { UserInputError } from "../../../errors";
import { linkExternalIssue, unlinkExternalIssue } from ".";

const api = new SentryApiService({ accessToken: "test-token" });
const params = { organizationSlug: "example", issueId: "123" };
const endpoint =
  "https://sentry.io/api/0/organizations/example/issues/123/integrations/";
const appEndpoint =
  "https://sentry.io/api/0/organizations/example/issues/123/external-issues/";

function integration(
  overrides: Partial<IssueIntegration> = {},
): IssueIntegration {
  return {
    id: "1",
    name: "acme",
    domainName: "github.com/acme",
    provider: { key: "github" },
    externalIssues: [],
    ...overrides,
  };
}

const nativeCases = [
  {
    provider: "github",
    domainName: "github.com/acme",
    url: "https://github.com/acme/repo/pull/42/files?diff=split#change",
    storedUrl: "https://github.com/acme/repo/issues/42",
  },
  {
    provider: "github_enterprise",
    domainName: "github.example.com:8443/acme",
    url: "https://github.example.com:8443/acme/repo/issues/42",
    storedUrl: "https://github.example.com:8443/acme/repo/issues/42",
  },
  {
    provider: "jira",
    domainName: "acme.atlassian.net",
    url: "https://acme.atlassian.net/browse/ENG-42?source=search",
    storedUrl: "https://acme.atlassian.net/browse/ENG-42",
  },
  {
    provider: "jira_server",
    domainName: "jira.example.com:8443",
    url: "https://jira.example.com:8443/jira/browse/eng-42",
    storedUrl: "https://jira.example.com:8443/jira/browse/ENG-42",
  },
  {
    provider: "jira",
    domainName: "acme.atlassian.net",
    url: "https://acme.atlassian.net/jira/software/projects/ENG/boards/1?selectedIssue=ENG-42",
    storedUrl: "https://acme.atlassian.net/browse/ENG-42",
  },
  {
    provider: "jira_server",
    domainName: "jira.example.com",
    url: "https://jira.example.com/jira/projects/ENG/issues/ENG-42",
    storedUrl: "https://jira.example.com/jira/browse/ENG-42",
  },
  {
    provider: "gitlab",
    domainName: "gitlab.com/acme",
    url: "https://gitlab.com/acme/backend/repo/-/issues/42",
    storedUrl: "https://gitlab.com/acme/backend/repo/issues/42",
  },
  {
    provider: "gitlab",
    domainName: "gitlab.example.com/acme",
    url: "https://gitlab.example.com/gitlab/acme/backend/repo/issues/42",
    storedUrl:
      "https://gitlab.example.com/gitlab/acme/backend/repo/-/issues/42",
  },
  {
    provider: "bitbucket",
    domainName: "bitbucket.org/acme",
    url: "https://bitbucket.org/acme/repo/issues/42/old-title",
    storedUrl: "https://bitbucket.org/acme/repo/issues/42/current-title",
  },
  {
    provider: "bitbucket",
    domainName: "acme",
    url: "https://bitbucket.org/acme/repo/issues/42",
    storedUrl: "https://bitbucket.org/acme/repo/issues/42",
  },
  {
    provider: "vsts",
    domainName: "https://acme.visualstudio.com",
    url: "https://dev.azure.com/acme/project/_workitems/edit/42",
    storedUrl: "https://acme.visualstudio.com/project/_workitems/edit/42",
  },
  {
    provider: "vsts",
    domainName: "dev.azure.com/acme",
    url: "https://acme.visualstudio.com/_workitems/edit/42",
    storedUrl: "https://dev.azure.com/acme/project/_workitems/edit/42",
  },
];

function useIntegrations(integrations: IssueIntegration[]) {
  mswServer.use(http.get(endpoint, () => HttpResponse.json(integrations)));
}

function usePut(status = 201) {
  const writes: { integrationId: string; body: unknown }[] = [];
  mswServer.use(
    http.put(
      `${endpoint}:integrationId/`,
      async ({ request, params: route }) => {
        const body = await request.json();
        writes.push({ integrationId: String(route.integrationId), body });
        return HttpResponse.json(
          {
            id: "900",
            key: "acme/repo#42",
            url: "https://github.com/acme/repo/issues/42",
          },
          { status },
        );
      },
    ),
  );
  return writes;
}

function useDelete(status = 204) {
  const writes: string[] = [];
  mswServer.use(
    http.delete(`${endpoint}:integrationId/`, ({ request }) => {
      writes.push(request.url);
      return new HttpResponse(null, { status });
    }),
  );
  return writes;
}

describe("linkExternalIssue", () => {
  it("rejects App fields on native links instead of silently ignoring them", async () => {
    await expect(
      linkExternalIssue(api, {
        ...params,
        externalIssueUrl: "https://github.com/acme/repo/issues/42",
        fields: { issue: "99" },
      }),
    ).rejects.toThrow("fields are only supported for Sentry App links");
  });

  it.each(nativeCases)(
    "passes a full URL to the selected $provider integration: $url",
    async ({ provider, domainName, url }) => {
      useIntegrations([
        integration({ provider: { key: provider }, domainName }),
      ]);
      const writes = usePut();
      const result = await linkExternalIssue(api, {
        ...params,
        externalIssueUrl: url,
      });
      expect(writes).toEqual([
        { integrationId: "1", body: { externalIssue: url } },
      ]);
      expect(result).toMatchObject({ provider, status: "linked" });
    },
  );

  it.each([201, 200])(
    "uses HTTP %i to report whether the backend created the association",
    async (status) => {
      const externalIssueUrl = "https://github.com/acme/repo/issues/42";
      useIntegrations([
        integration({
          externalIssues: [
            { id: "900", key: "acme/repo#42", url: externalIssueUrl },
          ],
        }),
      ]);
      const writes = usePut(status);
      expect(
        await linkExternalIssue(api, { ...params, externalIssueUrl }),
      ).toEqual({
        url: externalIssueUrl,
        displayName: "acme/repo#42",
        provider: "github",
        status: status === 201 ? "linked" : "already_linked",
      });
      expect(writes).toHaveLength(1);
    },
  );

  it("requires integrationId for overlapping GitLab installations and never tries candidates", async () => {
    useIntegrations([
      integration({
        provider: { key: "gitlab" },
        domainName: "gitlab.com/acme",
      }),
      integration({
        id: "2",
        provider: { key: "gitlab" },
        domainName: "gitlab.com/acme/backend",
      }),
    ]);
    const writes = usePut();
    const input = {
      ...params,
      externalIssueUrl: "https://gitlab.com/acme/backend/repo/-/issues/42",
    };
    await expect(linkExternalIssue(api, input)).rejects.toThrow(
      "Provide integrationId",
    );
    expect(writes).toEqual([]);
    await linkExternalIssue(api, { ...input, integrationId: "2" });
    expect(writes).toEqual([
      { integrationId: "2", body: { externalIssue: input.externalIssueUrl } },
    ]);
  });

  it.each([
    {
      provider: "github",
      domainName: "github.com/other",
      url: "https://github.com/acme/repo/issues/42",
    },
    {
      provider: "github",
      domainName: null,
      url: "https://internal.example.com/acme/repo/issues/42",
    },
    {
      provider: "github_enterprise",
      domainName: "github.example.com/acme",
      url: "https://github.example.com:8443/acme/repo/issues/42",
    },
    {
      provider: "gitlab",
      domainName: "gitlab.com/acme",
      url: "https://gitlab.com/acme-other/repo/-/issues/42",
    },
    {
      provider: "jira",
      domainName: "other.atlassian.net",
      url: "https://acme.atlassian.net/browse/ENG-42",
    },
    {
      provider: "bitbucket",
      domainName: "bitbucket.org/other",
      url: "https://bitbucket.org/acme/repo/issues/42",
    },
    {
      provider: "vsts",
      domainName: "dev.azure.com/other",
      url: "https://acme.visualstudio.com/_workitems/edit/42",
    },
    {
      provider: "unsupported",
      domainName: "github.com/acme",
      url: "https://github.com/acme/repo/issues/42",
    },
  ])(
    "rejects a mismatched $provider installation before PUT: $url",
    async ({ provider, domainName, url }) => {
      useIntegrations([
        integration({ provider: { key: provider }, domainName }),
      ]);
      const writes = usePut();
      await expect(
        linkExternalIssue(api, {
          ...params,
          externalIssueUrl: url,
          integrationId: "1",
        }),
      ).rejects.toThrow("does not match");
      expect(writes).toEqual([]);
    },
  );

  it.each([
    "file:///acme/repo/issues/42",
    "javascript:alert(1)",
    "https://user:secret@github.com/acme/repo/issues/42",
    "https://github.com/acme/repo/issues/%ZZ",
    "https://github.com/acme/repo/issues/42%3Ffake",
  ])(
    "rejects unsafe URL %s before reading integrations",
    async (externalIssueUrl) => {
      const requests: string[] = [];
      mswServer.use(
        http.all("https://sentry.io/api/0/*", ({ request }) => {
          requests.push(request.url);
          return HttpResponse.json([]);
        }),
      );
      await expect(
        linkExternalIssue(api, { ...params, externalIssueUrl }),
      ).rejects.toBeInstanceOf(UserInputError);
      expect(requests).toEqual([]);
    },
  );

  it.each([400, 403, 404, 409])(
    "leaves URL validation and HTTP %i errors to the backend",
    async (status) => {
      const externalIssueUrl =
        status === 400
          ? "https://github.com/acme/repo/commit/abc123"
          : "https://github.com/acme/repo/issues/42";
      useIntegrations([integration()]);
      mswServer.use(
        http.put(`${endpoint}1/`, async ({ request }) => {
          expect(await request.json()).toEqual({
            externalIssue: externalIssueUrl,
          });
          return HttpResponse.json({ detail: "Cannot link" }, { status });
        }),
      );
      await expect(
        linkExternalIssue(api, {
          ...params,
          externalIssueUrl,
        }),
      ).rejects.toMatchObject({ status });
    },
  );
});

describe("unlinkExternalIssue", () => {
  it.each(nativeCases)(
    "finds equivalent $provider URLs and deletes the internal association ID: $url",
    async ({ provider, domainName, url, storedUrl }) => {
      useIntegrations([
        integration({
          provider: { key: provider },
          domainName,
          externalIssues: [{ id: "900", key: "42", url: storedUrl }],
        }),
      ]);
      const writes = useDelete();
      expect(
        await unlinkExternalIssue(api, { ...params, externalIssueUrl: url }),
      ).toMatchObject({ url: storedUrl, provider, status: "not_linked" });
      expect(writes).toEqual([`${endpoint}1/?externalIssue=900`]);
    },
  );

  it.each([
    [
      "https://jira.example.com/jira/browse/ENG-1?selectedIssue=invalid&selectedIssue=eng-2&selectedIssue=ENG-1",
      "902",
    ],
    [
      "https://jira.example.com/jira-archive/browse/ENG-2?selectedIssue=ENG-2",
      null,
    ],
    ["https://other.example.com/jira/browse/ENG-2?selectedIssue=ENG-2", null],
  ])(
    "matches Jira's selectedIssue precedence and installation boundary: %s",
    async (externalIssueUrl, expectedId) => {
      useIntegrations([
        integration({
          provider: { key: "jira_server" },
          domainName: "jira.example.com",
          externalIssues: [1, 2].map((number) => ({
            id: `90${number}`,
            key: `ENG-${number}`,
            url: `https://jira.example.com/jira/browse/ENG-${number}`,
          })),
        }),
      ]);
      const writes = useDelete();
      const result = await unlinkExternalIssue(api, {
        ...params,
        integrationId: "1",
        externalIssueUrl,
      });
      expect(result.status).toBe("not_linked");
      expect(writes).toEqual(
        expectedId ? [`${endpoint}1/?externalIssue=${expectedId}`] : [],
      );
    },
  );

  it("does not delete when only a different external issue is linked", async () => {
    mswServer.use(http.get(appEndpoint, () => HttpResponse.json([])));
    useIntegrations([
      integration({
        externalIssues: [
          {
            id: "900",
            key: "acme/repo#99",
            url: "https://github.com/acme/repo/issues/99",
          },
        ],
      }),
    ]);
    const writes = useDelete();
    expect(
      await unlinkExternalIssue(api, {
        ...params,
        externalIssueUrl: "https://github.com/acme/repo/issues/42",
      }),
    ).toMatchObject({ status: "not_linked" });
    expect(writes).toEqual([]);
  });

  it("unlinks a stored association after its installation was disabled or reconfigured", async () => {
    const externalIssueUrl = "https://github.com/acme/repo/issues/42";
    useIntegrations([
      integration({
        status: "disabled",
        domainName: "github.com/new-owner",
        externalIssues: [
          { id: "900", key: "acme/repo#42", url: externalIssueUrl },
        ],
      }),
    ]);
    const writes = useDelete();
    await unlinkExternalIssue(api, { ...params, externalIssueUrl });
    expect(writes).toEqual([`${endpoint}1/?externalIssue=900`]);
  });

  it("finds a custom App association by its URL without requiring appSlug", async () => {
    const externalIssueUrl = "https://tracker.example.com/tasks/42";
    useIntegrations([]);
    const writes: string[] = [];
    mswServer.use(
      http.get(appEndpoint, () =>
        HttpResponse.json([
          {
            id: "700",
            issueId: "123",
            serviceType: "custom-tracker",
            displayName: "Task 42",
            webUrl: externalIssueUrl,
          },
        ]),
      ),
      http.delete(`${appEndpoint}700/`, ({ request }) => {
        writes.push(request.url);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(
      await unlinkExternalIssue(api, { ...params, externalIssueUrl }),
    ).toMatchObject({
      provider: "custom-tracker",
      status: "not_linked",
    });
    expect(writes).toEqual([`${appEndpoint}700/`]);
  });

  it("rejects multiple matching links until an integration is selected", async () => {
    const externalIssueUrl = "https://github.com/acme/repo/issues/42";
    const externalIssues = [
      { id: "900", key: "acme/repo#42", url: externalIssueUrl },
    ];
    useIntegrations([
      integration({ externalIssues }),
      integration({ id: "2", externalIssues }),
    ]);
    const writes = useDelete();
    await expect(
      unlinkExternalIssue(api, { ...params, externalIssueUrl }),
    ).rejects.toThrow("Provide integrationId");
    expect(writes).toEqual([]);
    await unlinkExternalIssue(api, {
      ...params,
      externalIssueUrl,
      integrationId: "2",
    });
    expect(writes).toEqual([`${endpoint}2/?externalIssue=900`]);
  });

  it.each(["lookup", "delete"])(
    "does not swallow a 404 during %s",
    async (step) => {
      const externalIssueUrl = "https://github.com/acme/repo/issues/42";
      useIntegrations([
        integration({
          externalIssues: [
            { id: "900", key: "acme/repo#42", url: externalIssueUrl },
          ],
        }),
      ]);
      useDelete(404);
      if (step === "lookup")
        mswServer.use(
          http.get(endpoint, () => new HttpResponse(null, { status: 404 })),
        );
      await expect(
        unlinkExternalIssue(api, { ...params, externalIssueUrl }),
      ).rejects.toMatchObject({ status: 404 });
    },
  );
});
