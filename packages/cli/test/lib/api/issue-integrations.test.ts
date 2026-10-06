import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findNativeIssueLink,
  linkNativeIssue,
  type NativeIssueLink,
  resolveNativeIssueLink,
  selectNativeIntegration,
} from "../../../src/lib/api/issue-integrations.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import { linkExternalIssue } from "../../../src/lib/issue-links.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const REGION = "https://eu.sentry.io";
const INTEGRATIONS = "/api/0/organizations/test-org/issues/42/integrations/";
const SOURCE = { orgSlug: "test-org", issueId: "42" };
const JIRA_URL = "https://tracker.example.com/browse/PROJ-7";
const LINK: NativeIssueLink = {
  id: "1234",
  integrationId: "10",
  provider: "jira",
  key: "PROJ-7",
  url: JIRA_URL,
  displayName: "PROJ-7",
};

type IntegrationFixture = {
  provider?: string;
  domainName?: string | null;
  id?: string;
  name?: string;
  externalIssues?: NativeIssueLink[];
};

function integration({
  provider = "jira",
  domainName = "tracker.example.com",
  id = "10",
  name = `Example ${provider}`,
  externalIssues = [],
}: IntegrationFixture = {}) {
  return {
    id,
    name,
    domainName,
    icon: null,
    accountType: null,
    scopes: null,
    outOfDate: null,
    missingFeatures: null,
    provider: {
      key: provider,
      slug: provider,
      name: `Example ${provider}`,
      canAdd: true,
      canDisable: false,
      features: ["issue-basic"],
      aspects: {},
    },
    status: "active",
    externalIssues: externalIssues.map((link) => ({
      ...link,
      title: link.title ?? null,
      description: null,
    })),
  };
}

function json(data: unknown, headers?: HeadersInit): Response {
  return Response.json(data, { status: 200, headers });
}

describe("selectNativeIntegration", () => {
  function select(
    fixture: IntegrationFixture,
    url: string,
    integrationId?: string
  ): string {
    return selectNativeIntegration([integration(fixture)], url, integrationId)
      .id;
  }

  // Paths the backend rejects, such as commits and merge requests, still select
  // an installation: validating the issue path is the backend's job.
  test.each`
    provider               | domainName                             | url
    ${"jira"}              | ${"tracker.example.com"}               | ${JIRA_URL.toLowerCase()}
    ${"jira_server"}       | ${"tracker.example.com"}               | ${"https://tracker.example.com/jira/browse/PROJ-7"}
    ${"jira_server"}       | ${"tracker.example.com"}               | ${"https://tracker.example.com/projects/PROJ/issues/PROJ-7"}
    ${"jira_server"}       | ${"tracker.example.com"}               | ${"https://tracker.example.com/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7"}
    ${"jira_server"}       | ${"tracker.example.com/jira"}          | ${"https://tracker.example.com/jira/secure/RapidBoard.jspa?rapidView=1&selectedIssue=PROJ-7"}
    ${"gitlab"}            | ${"gitlab.example.com/group/subgroup"} | ${"https://gitlab.example.com/group/subgroup/project/-/issues/7"}
    ${"gitlab"}            | ${"gitlab.example.com"}                | ${"https://gitlab.example.com/gitlab/group/project/issues/7"}
    ${"gitlab"}            | ${"gitlab.example.com/group/subgroup"} | ${"https://gitlab.example.com/services/gitlab/group/subgroup/project/-/issues/7"}
    ${"gitlab"}            | ${"gitlab.com/owner"}                  | ${"https://gitlab.com/owner/repo/-/merge_requests/7"}
    ${"bitbucket"}         | ${"bitbucket.org/workspace"}           | ${"https://bitbucket.org/workspace/repo/issues/7/a-title"}
    ${"bitbucket"}         | ${"username"}                          | ${"https://bitbucket.org/username/commits/issues/7"}
    ${"bitbucket"}         | ${"bitbucket.org/owner"}               | ${"https://bitbucket.org/owner/repo/pull-requests/7"}
    ${"vsts"}              | ${"https://example.visualstudio.com"}  | ${"https://dev.azure.com/example/project/_workitems/edit/7"}
    ${"vsts"}              | ${"https://dev.azure.com/example"}     | ${"https://example.visualstudio.com/project/_workitems/edit/7"}
    ${"github"}            | ${"github.com/owner"}                  | ${"https://github.com/OWNER/repo/issues/7"}
    ${"github"}            | ${"github.com/owner"}                  | ${"https://github.com/OWNER/repo/pull/7"}
    ${"github"}            | ${"github.com/owner"}                  | ${"https://github.com/owner/repo/commit/abcdef"}
    ${"github_enterprise"} | ${"github.example.com/owner"}          | ${"https://github.example.com/OWNER/repo/pull/7"}
  `(
    "selects the $provider installation at $domainName for $url",
    ({ provider, domainName, url }) => {
      expect(select({ provider, domainName }, url)).toBe("10");
    }
  );

  test.each`
    provider       | domainName                            | url
    ${"jira"}      | ${"https://tracker.example.com/jira"} | ${JIRA_URL}
    ${"vsts"}      | ${"https://dev.azure.com/example"}    | ${"https://dev.azure.com/another/project/_workitems/edit/7"}
    ${"bitbucket"} | ${"bitbucket.org/team"}               | ${"https://bitbucket.org/another/repo/issues/7"}
  `(
    "rejects a URL outside the $provider installation at $domainName",
    ({ provider, domainName, url }) => {
      expect(() => select({ provider, domainName }, url)).toThrow(
        "No installed native"
      );
    }
  );

  test("selects a GitHub installation without domain metadata by owner", () => {
    const github = { provider: "github", domainName: null, name: "Owner" };
    expect(select(github, "https://github.com/OWNER/repo/issues/7")).toBe("10");
    expect(() =>
      select(github, "https://github.com/another/repo/issues/7")
    ).toThrow("No installed native");
  });

  test("selects an Enterprise installation without host metadata only when explicit", () => {
    const enterprise = {
      provider: "github_enterprise",
      domainName: null,
      name: "Owner",
    };
    const url = "https://github.example.com/OWNER/repo/pull/7";
    expect(() => select(enterprise, url)).toThrow("--integration");
    expect(select(enterprise, url, "10")).toBe("10");
  });

  test.each([
    {
      name: "Jira",
      integrations: [integration(), integration({ id: "20" })],
      url: JIRA_URL,
    },
    {
      name: "GitLab",
      integrations: [
        integration({
          provider: "gitlab",
          domainName: "gitlab.example.com/group",
        }),
        integration({
          provider: "gitlab",
          domainName: "gitlab.example.com/another",
          id: "20",
        }),
      ],
      url: "https://gitlab.example.com/deployment/group/repo/-/issues/7",
    },
  ])("requires --integration for $name installations sharing a host", ({
    integrations,
    url,
  }) => {
    expect(() => selectNativeIntegration(integrations, url)).toThrow(
      "Multiple integrations"
    );
    expect(selectNativeIntegration(integrations, url, "20").id).toBe("20");
  });

  test("ignores installations with malformed domain metadata", () => {
    const integrations = [
      integration({ domainName: "https://", id: "20" }),
      integration({
        provider: "vsts",
        domainName: "unrecognized.example.com",
        id: "30",
      }),
      integration(),
    ];
    expect(selectNativeIntegration(integrations, JIRA_URL).id).toBe("10");
  });
});

describe("findNativeIssueLink", () => {
  test.each`
    provider         | existing                                                | target
    ${"jira"}        | ${JIRA_URL}                                             | ${`${JIRA_URL.toLowerCase()}/?source=cli#details`}
    ${"jira_server"} | ${JIRA_URL}                                             | ${"https://tracker.example.com/projects/PROJ/issues/PROJ-7"}
    ${"jira_server"} | ${JIRA_URL}                                             | ${"https://tracker.example.com/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7&view=detail"}
    ${"jira_server"} | ${"https://tracker.example.com/jira/browse/PROJ-7"}     | ${"https://tracker.example.com/jira/secure/RapidBoard.jspa?rapidView=1&selectedIssue=PROJ-7"}
    ${"jira"}        | ${JIRA_URL}                                             | ${"https://tracker.example.com/browse/PROJ-1?selectedIssue=invalid&selectedIssue=proj-7&selectedIssue=PROJ-1"}
    ${"gitlab"}      | ${"https://gitlab.com/group/repo/issues/7"}             | ${"https://gitlab.com/group/repo/-/issues/7"}
    ${"gitlab"}      | ${"https://gitlab.com/MyOrg/Repo/-/issues/7"}           | ${"https://gitlab.com/myorg/repo/-/issues/7"}
    ${"github"}      | ${"https://github.com/owner/repo/issues/7"}             | ${"https://github.com/OWNER/Repo/issues/7/"}
    ${"github"}      | ${"https://github.com/owner/repo/issues/7"}             | ${"https://github.com/OWNER/repo/pull/7/files?source=cli#diff"}
    ${"bitbucket"}   | ${"https://bitbucket.org/owner/repo/issues/7/a-title"}  | ${"https://bitbucket.org/owner/repo/issues/7"}
    ${"vsts"}        | ${"https://example.visualstudio.com/_workitems/edit/7"} | ${"https://dev.azure.com/example/project/_workitems/edit/7"}
  `(
    "matches $provider alias $target using stored metadata alone",
    ({ provider, existing, target }) => {
      const link = { ...LINK, provider, url: existing };
      expect(findNativeIssueLink([link], target)).toBe(link);
    }
  );

  test.each([
    "https://tracker.example.com/jira-archive/browse/PROJ-7",
    "https://tracker.example.com/other/projects/PROJ/issues/PROJ-7",
    "https://tracker.example.com/other/board?selectedIssue=PROJ-7",
    "https://other.example.com/jira/browse/PROJ-7",
  ])("does not match Jira aliases outside the stored context: %s", (target) => {
    expect(
      findNativeIssueLink(
        [
          {
            ...LINK,
            provider: "jira_server",
            url: "https://tracker.example.com/jira/browse/PROJ-7",
          },
        ],
        target
      )
    ).toBeUndefined();
  });

  test("ignores malformed stored siblings and other providers on the same host", () => {
    const enterprise = {
      ...LINK,
      id: "5678",
      provider: "github_enterprise",
      url: "https://tracker.example.com/owner/repo/issues/7",
    };
    const malformed = { ...LINK, id: "999", url: "not a URL" };
    expect(findNativeIssueLink([malformed, LINK], JIRA_URL)).toBe(LINK);
    expect(findNativeIssueLink([LINK, enterprise], enterprise.url)).toBe(
      enterprise
    );
  });

  test("rejects ambiguous links and accepts an integration selector", () => {
    const second = { ...LINK, id: "5678", integrationId: "20" };
    expect(() => findNativeIssueLink([LINK, second], JIRA_URL)).toThrow(
      "--integration"
    );
    expect(findNativeIssueLink([LINK, second], JIRA_URL, "20")).toBe(second);
  });

  test.each([
    "https://github.com/owner/repo/pull/8",
    "https://github.com/owner/other/pull/7",
    "https://other.example.com/owner/repo/pull/7",
  ])("distinguishes GitHub PR numbers, repositories and hosts: %s", (target) => {
    const link = {
      ...LINK,
      provider: "github",
      url: "https://github.com/owner/repo/pull/7",
    };
    expect(findNativeIssueLink([link], target)).toBeUndefined();
  });

  test("never equates URLs just because neither identifies an issue", () => {
    const link = {
      ...LINK,
      provider: "github",
      url: "https://github.com/owner/repo/commit/abc",
    };
    expect(
      findNativeIssueLink([link], "https://github.com/owner/repo/commit/def")
    ).toBeUndefined();
    expect(
      findNativeIssueLink([LINK], "https://other.example.com/browse/PROJ-7")
    ).toBeUndefined();
  });
});

describe("native link API", () => {
  useTestConfigDir("native-issue-links-");
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setAuthToken("test-token", 3600, "test-refresh");
    setOrgRegion(SOURCE.orgSlug, REGION);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockApi(
    respond: (request: Request) => Response | Promise<Response>
  ): Request[] {
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    });
    return requests;
  }

  test("resolves in the organization's region and links by the submitted URL", async () => {
    const submitted = `${JIRA_URL}?source=cli`;
    const requests = mockApi(async (request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe(REGION);
      if (request.method === "PUT") {
        expect(url.pathname).toBe(`${INTEGRATIONS}10/`);
        expect(await request.json()).toEqual({ externalIssue: submitted });
        return Response.json(
          { ...LINK, id: 1234, integrationId: 10 },
          { status: 201 }
        );
      }
      expect(url.pathname).toBe(INTEGRATIONS);
      expect(url.searchParams.get("per_page")).toBe("100");
      return json([integration()]);
    });

    const prepared = await resolveNativeIssueLink({
      ...SOURCE,
      url: `${JIRA_URL}/?source=cli#details`,
    });
    expect(prepared).toMatchObject({
      ...SOURCE,
      regionUrl: REGION,
      integrationId: "10",
      provider: "jira",
      url: submitted,
    });
    expect(prepared.existing).toBeUndefined();
    expect(await linkNativeIssue(prepared)).toEqual({
      link: LINK,
      changed: true,
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
  });

  test("fetches all integration pages before deciding the link is absent", async () => {
    const requests = mockApi((request) => {
      const url = new URL(request.url);
      if (!url.searchParams.has("cursor")) {
        return json([integration({ domainName: "other.example.com" })], {
          Link: '<https://eu.sentry.io/ignored>; rel="next"; results="true"; cursor="second"',
        });
      }
      expect(url.searchParams.get("cursor")).toBe("second");
      return json([
        integration({
          id: "20",
          externalIssues: [{ ...LINK, integrationId: "20" }],
        }),
      ]);
    });

    const prepared = await resolveNativeIssueLink({ ...SOURCE, url: JIRA_URL });
    expect(prepared.existing?.id).toBe(LINK.id);
    expect(prepared.integrationId).toBe("20");
    expect(requests).toHaveLength(2);
  });

  test.each([
    200, 201,
  ])("uses backend HTTP %i even when preflight found a link", async (status) => {
    mockApi((request) =>
      request.method === "GET"
        ? json([integration({ externalIssues: [LINK] })])
        : Response.json({ ...LINK, id: 1234, integrationId: 10 }, { status })
    );
    const prepared = await resolveNativeIssueLink({ ...SOURCE, url: JIRA_URL });
    expect(prepared.existing).toEqual(LINK);
    // A concurrent unlink can remove the association after preflight.
    expect(await linkNativeIssue(prepared)).toEqual({
      link: LINK,
      changed: status === 201,
    });
  });

  test.each([
    { name: "empty 204", response: () => new Response(null, { status: 204 }) },
    { name: "empty object", response: () => json({}) },
    { name: "invalid numeric IDs", response: () => json(LINK) },
  ])("does not report success for an invalid mutation response: $name", async ({
    response,
  }) => {
    mockApi((request) =>
      request.method === "GET" ? json([integration()]) : response()
    );
    const prepared = await resolveNativeIssueLink({ ...SOURCE, url: JIRA_URL });
    const mutation = linkNativeIssue(prepared);
    await expect(mutation).rejects.toBeInstanceOf(ApiError);
    await expect(mutation).rejects.toThrow(
      "inspect the current links before retrying"
    );
  });

  test("propagates the backend's rejection of an issue URL", async () => {
    const requests = mockApi((request) =>
      request.method === "GET"
        ? json([
            integration({ provider: "github", domainName: "github.com/owner" }),
          ])
        : Response.json(
            { detail: "Invalid provider reference" },
            { status: 400 }
          )
    );
    await expect(
      resolveNativeIssueLink({
        ...SOURCE,
        url: "https://github.com/owner/repo/commit/abcdef",
      }).then(linkNativeIssue)
    ).rejects.toBeInstanceOf(ApiError);
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
  });

  test("rejects an invalid integration page without linking", async () => {
    const requests = mockApi(() =>
      json([{ ...integration(), externalIssues: [{}] }])
    );
    await expect(
      resolveNativeIssueLink({ ...SOURCE, url: JIRA_URL })
    ).rejects.toBeInstanceOf(ApiError);
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("finds an existing link despite malformed stored sibling URLs", async () => {
    mockApi(() =>
      json([
        integration({
          externalIssues: [{ ...LINK, id: "999", url: "not a URL" }, LINK],
        }),
      ])
    );
    const prepared = await resolveNativeIssueLink({ ...SOURCE, url: JIRA_URL });
    expect(prepared.existing).toEqual(LINK);
  });

  test.each([
    "https://username:secret@tracker.example.com/browse/PROJ-7",
    "javascript:alert(1)",
    "PROJ-7",
  ])("rejects unsupported input before API calls: %s", async (url) => {
    const requests = mockApi(() => json([]));
    await expect(resolveNativeIssueLink({ ...SOURCE, url })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  test("links a GitHub PR and returns its canonical URL", async () => {
    const pullUrl = "https://github.com/Owner/Repo/pull/7";
    const storedLink = {
      ...LINK,
      provider: "github",
      key: "Owner/Repo#7",
      displayName: "Owner/Repo#7",
      url: "https://github.com/Owner/Repo/issues/7",
    };
    const requests = mockApi((request) => {
      if (request.method === "PUT") {
        // The mutation returns GitHub's html_url; listing reconstructs /issues/N.
        return Response.json(
          { ...storedLink, id: 1234, integrationId: 10, url: pullUrl },
          { status: 201 }
        );
      }
      return json([
        integration({
          provider: "github",
          domainName: "github.com/owner",
          externalIssues: [],
        }),
      ]);
    });

    const options = {
      ...SOURCE,
      url: "https://github.com/OWNER/repo/pull/7/files?source=cli#diff",
    };
    expect(await linkExternalIssue(options)).toMatchObject({
      changed: true,
      externalIssue: { id: "1234", identifier: "Owner/Repo#7", url: pullUrl },
    });
    expect(
      requests
        .filter((request) => request.method !== "GET")
        .map((request) => request.method)
    ).toEqual(["PUT"]);
  });
});
