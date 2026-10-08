import {
  mswServer,
  projectFixture,
  teamFixture,
} from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../errors";
import { parseSentryUrl } from "../internal/url-helpers";
import { SentryApiService } from "./client";
import { ApiNotFoundError, ApiServerError } from "./errors";

describe("API bearer token validation", () => {
  it("removes edge padding before sending a request", async () => {
    let authorization: string | null = null;
    mswServer.use(
      http.get(
        "https://sentry.example.com/api/0/organizations/",
        ({ request }) => {
          authorization = request.headers.get("Authorization");
          return HttpResponse.json([]);
        },
      ),
    );

    const api = new SentryApiService({
      host: "sentry.example.com",
      accessToken: " \tvalid-token\x7f ",
    });
    await api.listOrganizations();
    expect(authorization).toBe("Bearer valid-token");
  });

  it("rejects a malformed credential before sending it or disclosing its value", async () => {
    let requests = 0;
    mswServer.use(
      http.get("https://sentry.example.com/api/0/organizations/", () => {
        requests += 1;
        return HttpResponse.json([]);
      }),
    );
    const api = new SentryApiService({
      host: "sentry.example.com",
      accessToken: "valid\nsecret",
    });

    const error = await api
      .listOrganizations()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).toContain("Malformed authentication token");
    expect(String(error)).not.toContain("valid\nsecret");
    expect(requests).toBe(0);

    const emptyTokenApi = new SentryApiService({
      host: "sentry.example.com",
      accessToken: "",
    });
    await expect(emptyTokenApi.listOrganizations()).rejects.toThrow(
      ConfigurationError,
    );
    expect(requests).toBe(0);
  });
});

describe("single-tenant web URLs", () => {
  const api = new SentryApiService({ host: "tenant.my.sentry.io" });
  const baseUrl = "https://tenant.my.sentry.io/organizations/product-org";

  it("keeps the tenant host and the organization from the path", () => {
    const issueUrl = api.getIssueUrl("product-org", "WEB-123");
    expect(issueUrl).toBe(`${baseUrl}/issues/WEB-123`);
    expect(parseSentryUrl(issueUrl)).toEqual({
      type: "issue",
      organizationSlug: "product-org",
      issueId: "WEB-123",
    });
    expect(api.getDashboardUrl("product-org", "42")).toBe(
      `${baseUrl}/dashboard/42/`,
    );
  });

  it("keeps alert links on the tenant", () => {
    expect(api.getIssueAlertRuleUrl("product-org", "42")).toBe(
      `${baseUrl}/monitors/alerts/42/`,
    );
    expect(api.getMetricAlertRuleUrl("product-org", "42")).toBe(
      `${baseUrl}/issues/alerts/rules/details/42/`,
    );
  });

  it.each([
    ["errors", "discover/homepage", "query"],
    ["spans", "traces", "query"],
    ["logs", "logs", "logsQuery"],
  ] as const)(
    "keeps %s explorer links and filters on the tenant",
    (dataset, page, queryParam) => {
      const url = new URL(
        api.getEventsExplorerUrl("product-org", "level:error", "123", dataset),
      );
      expect(`${url.origin}${url.pathname}`).toBe(
        `${baseUrl}/explore/${page}/`,
      );
      expect(url.searchParams.get(queryParam)).toBe("level:error");
      expect(url.searchParams.get("project")).toBe("123");
      expect(url.searchParams.get("statsPeriod")).toBe("24h");
    },
  );
});

describe("getIssueUrl", () => {
  it("should work with sentry.io", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    const result = apiService.getIssueUrl("sentry-mcp", "123456");
    expect(result).toMatchInlineSnapshot(
      `"https://sentry-mcp.sentry.io/issues/123456"`,
    );
  });
  it("should work with self-hosted", () => {
    const apiService = new SentryApiService({ host: "sentry.example.com" });
    const result = apiService.getIssueUrl("sentry-mcp", "123456");
    expect(result).toMatchInlineSnapshot(
      `"https://sentry.example.com/organizations/sentry-mcp/issues/123456"`,
    );
  });
  it("should work with full URL including protocol", () => {
    const apiService = new SentryApiService({
      host: "sentry.example.com",
    });
    const result = apiService.getIssueUrl("sentry-mcp", "123456");
    expect(result).toMatchInlineSnapshot(
      `"https://sentry.example.com/organizations/sentry-mcp/issues/123456"`,
    );
  });
  it("should always use HTTPS protocol", () => {
    const apiService = new SentryApiService({
      host: "localhost:8000",
    });
    const result = apiService.getIssueUrl("sentry-mcp", "123456");
    expect(result).toMatchInlineSnapshot(
      `"https://localhost:8000/organizations/sentry-mcp/issues/123456"`,
    );
  });
  it("should support HTTP issue URLs for self-hosted instances when configured", () => {
    const apiService = new SentryApiService({
      host: "localhost:8000",
      protocol: "http",
    });
    const result = apiService.getIssueUrl("sentry-mcp", "123456");
    expect(result).toMatchInlineSnapshot(
      `"http://localhost:8000/organizations/sentry-mcp/issues/123456"`,
    );
  });
  it("should handle regional URLs correctly for SaaS", () => {
    const apiService = new SentryApiService({ host: "us.sentry.io" });
    const result = apiService.getIssueUrl("sentry", "PROJ-THREAD-LEAKS-12");
    // Should use sentry.io, not us.sentry.io for web UI
    expect(result).toEqual(
      "https://sentry.sentry.io/issues/PROJ-THREAD-LEAKS-12",
    );
  });
  it("should handle EU regional URLs correctly for SaaS", () => {
    const apiService = new SentryApiService({ host: "eu.sentry.io" });
    const result = apiService.getIssueUrl("myorg", "PROJECT-456");
    // Should use sentry.io, not eu.sentry.io for web UI
    expect(result).toEqual("https://myorg.sentry.io/issues/PROJECT-456");
  });
  it("keeps public organization hosts with multiple labels on public web URLs", () => {
    const apiService = new SentryApiService({ host: "example.us.sentry.io" });
    expect(apiService.getIssueUrl("product-org", "WEB-123")).toBe(
      "https://product-org.sentry.io/issues/WEB-123",
    );
  });
});

describe("getPreprodSnapshotUrl", () => {
  it("should work with sentry.io", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    const result = apiService.getPreprodSnapshotUrl("sentry", "12");
    expect(result).toEqual("https://sentry.sentry.io/preprod/snapshots/12/");
  });
  it("should work with self-hosted", () => {
    const apiService = new SentryApiService({ host: "sentry.example.com" });
    const result = apiService.getPreprodSnapshotUrl("sentry", "12");
    expect(result).toEqual(
      "https://sentry.example.com/organizations/sentry/preprod/snapshots/12/",
    );
  });
  it("should respect HTTP protocol for self-hosted", () => {
    const apiService = new SentryApiService({
      host: "localhost:8000",
      protocol: "http",
    });
    const result = apiService.getPreprodSnapshotUrl("sentry", "12");
    expect(result).toEqual(
      "http://localhost:8000/organizations/sentry/preprod/snapshots/12/",
    );
  });
  it("should use sentry.io (not regional) for SaaS web URL", () => {
    const apiService = new SentryApiService({ host: "us.sentry.io" });
    const result = apiService.getPreprodSnapshotUrl("sentry", "12");
    expect(result).toEqual("https://sentry.sentry.io/preprod/snapshots/12/");
  });
});

describe("getTraceUrl", () => {
  it("should work with sentry.io", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    const result = apiService.getTraceUrl(
      "sentry-mcp",
      "6a477f5b0f31ef7b6b9b5e1dea66c91d",
    );
    expect(result).toMatchInlineSnapshot(
      `"https://sentry-mcp.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d"`,
    );
  });
  it("should work with self-hosted", () => {
    const apiService = new SentryApiService({ host: "sentry.example.com" });
    const result = apiService.getTraceUrl(
      "sentry-mcp",
      "6a477f5b0f31ef7b6b9b5e1dea66c91d",
    );
    expect(result).toMatchInlineSnapshot(
      `"https://sentry.example.com/organizations/sentry-mcp/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d"`,
    );
  });
  it("should always use HTTPS protocol", () => {
    const apiService = new SentryApiService({
      host: "localhost:8000",
    });
    const result = apiService.getTraceUrl(
      "sentry-mcp",
      "6a477f5b0f31ef7b6b9b5e1dea66c91d",
    );
    expect(result).toMatchInlineSnapshot(
      `"https://localhost:8000/organizations/sentry-mcp/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d"`,
    );
  });
  it("should handle regional URLs correctly for SaaS", () => {
    const apiService = new SentryApiService({ host: "us.sentry.io" });
    const result = apiService.getTraceUrl(
      "sentry",
      "6a477f5b0f31ef7b6b9b5e1dea66c91d",
    );
    // Should use sentry.io, not us.sentry.io for web UI
    expect(result).toEqual(
      "https://sentry.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d",
    );
  });
});

describe("external issue linking API methods", () => {
  const organizationSlug = "test-org";
  const issueId = "123";
  const integrationId = "456";
  const externalIssueUrl = "https://github.com/example/project/issues/42";
  const nativeIssue = {
    id: 789,
    key: "example/project#42",
    url: externalIssueUrl,
  };
  const appIssue = {
    id: "789",
    issueId,
    serviceType: "linear",
    displayName: "ENG-42",
    webUrl: "https://linear.app/example/issue/ENG-42/title",
  };
  const api = new SentryApiService({
    host: "us.sentry.io",
    accessToken: "test-token",
  });

  it("reads every integration page and preserves internal link IDs and provider metadata", async () => {
    const integration = {
      id: integrationId,
      name: "example",
      domainName: "github.com/example",
      status: "active",
      provider: { key: "github" },
      externalIssues: [nativeIssue],
    };
    const pages: (string | null)[] = [];
    mswServer.use(
      http.get(
        "https://us.sentry.io/api/0/organizations/test-org/issues/123/integrations/",
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          pages.push(cursor);
          return HttpResponse.json(
            [{ ...integration, id: cursor ? 457 : integrationId }],
            {
              headers: cursor
                ? {}
                : {
                    Link: '<https://us.sentry.io/>; rel="next"; results="true"; cursor="next-page"',
                  },
            },
          );
        },
      ),
    );
    expect(
      await api.listIssueIntegrations({ organizationSlug, issueId }),
    ).toEqual([integration, { ...integration, id: 457 }]);
    expect(pages).toEqual([null, "next-page"]);
  });

  it("uses the actual next link rather than a previous link's extension attribute", async () => {
    const pages: (string | null)[] = [];
    mswServer.use(
      http.get(
        "https://us.sentry.io/api/0/organizations/test-org/issues/123/integrations/",
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          pages.push(cursor);
          return HttpResponse.json([], {
            headers: cursor
              ? {}
              : {
                  Link: '<https://us.sentry.io/>; x-rel="next"; rel="previous"; results="true"; cursor="previous-page", <https://us.sentry.io/>; rel="next"; results="true"; cursor="next-page"',
                },
          });
        },
      ),
    );

    await api.listIssueIntegrations({ organizationSlug, issueId });
    expect(pages).toEqual([null, "next-page"]);
  });

  it("finds App associations beyond the first page", async () => {
    mswServer.use(
      http.get(
        "https://us.sentry.io/api/0/organizations/test-org/issues/123/external-issues/",
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          return HttpResponse.json(cursor ? [appIssue] : [], {
            headers: cursor
              ? {}
              : {
                  Link: '<https://us.sentry.io/>; rel="next"; results="true"; cursor="next-page"',
                },
          });
        },
      ),
    );
    expect(
      await api.getIssueExternalLinks({ organizationSlug, issueId }),
    ).toEqual([appIssue]);
  });

  it("loads App installations and paginated issue-link forms on the control host", async () => {
    const installation = {
      uuid: "install-uuid",
      status: "installed",
      app: { slug: "linear", uuid: "app-uuid" },
    };
    const component = {
      type: "issue-link",
      sentryApp: { slug: "linear", uuid: "app-uuid" },
      schema: { link: { uri: "/link" } },
    };
    const pages: (string | null)[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/sentry-app-installations/",
        () => HttpResponse.json([installation]),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/sentry-app-components/",
        ({ request }) => {
          const query = new URL(request.url).searchParams;
          expect(query.get("filter")).toBe("issue-link");
          pages.push(query.get("cursor"));
          return HttpResponse.json(query.has("cursor") ? [component] : [], {
            headers: query.has("cursor")
              ? {}
              : {
                  Link: '<https://sentry.io/>; rel="next"; results="true"; cursor="next-page"',
                },
          });
        },
      ),
    );
    expect(await api.listSentryAppInstallations({ organizationSlug })).toEqual([
      installation,
    ]);
    expect(await api.listSentryAppComponents({ organizationSlug })).toEqual([
      component,
    ]);
    expect(pages).toEqual([null, "next-page"]);
  });

  it.each(["tenant.my.sentry.io", "sentry.example.com"])(
    "keeps App choices on %s and encodes search dependencies",
    async (host) => {
      const tenantApi = new SentryApiService({ host });
      mswServer.use(
        http.get(
          `https://${host}/api/0/sentry-app-installations/install-uuid/external-requests/`,
          ({ request }) => {
            expect(
              Object.fromEntries(new URL(request.url).searchParams),
            ).toEqual({
              uri: "/search",
              projectId: "42",
              query: "ENG-42",
              dependentData: JSON.stringify({ team: "ENG" }),
            });
            return HttpResponse.json({ choices: [["ticket-uuid", "ENG-42"]] });
          },
        ),
      );
      expect(
        await tenantApi.getSentryAppExternalRequestOptions({
          installationUuid: "install-uuid",
          uri: "/search",
          query: "ENG-42",
          projectId: "42",
          dependentData: { team: "ENG" },
        }),
      ).toEqual({ choices: [["ticket-uuid", "ENG-42"]] });
    },
  );

  it("unlinks an App by internal association ID using the regional endpoint", async () => {
    const requests: string[] = [];
    mswServer.use(
      http.delete(
        "https://us.sentry.io/api/0/organizations/test-org/issues/123/external-issues/789/",
        () => {
          requests.push("app");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await api.unlinkSentryAppExternalIssue({
      organizationSlug,
      issueId,
      externalIssueId: "789",
    });
    expect(requests).toEqual(["app"]);
  });
});

describe("getEventsExplorerUrl", () => {
  it("should work with sentry.io", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    const result = apiService.getEventsExplorerUrl(
      "sentry-mcp",
      "level:error AND message:timeout",
    );
    expect(result).toMatchInlineSnapshot(
      `"https://sentry-mcp.sentry.io/explore/traces/?query=level%3Aerror+AND+message%3Atimeout&statsPeriod=24h&table=span"`,
    );
  });
  it("should work with self-hosted", () => {
    const apiService = new SentryApiService({ host: "sentry.example.com" });
    const result = apiService.getEventsExplorerUrl(
      "sentry-mcp",
      "level:error AND message:timeout",
    );
    expect(result).toMatchInlineSnapshot(
      `"https://sentry.example.com/organizations/sentry-mcp/explore/traces/?query=level%3Aerror+AND+message%3Atimeout&statsPeriod=24h&table=span"`,
    );
  });
  it("should include project parameter when provided", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    const result = apiService.getEventsExplorerUrl(
      "sentry-mcp",
      "level:error",
      "backend",
    );
    expect(result).toMatchInlineSnapshot(
      `"https://sentry-mcp.sentry.io/explore/traces/?query=level%3Aerror&project=backend&statsPeriod=24h&table=span"`,
    );
  });
  it("should properly encode special characters in query", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    const result = apiService.getEventsExplorerUrl(
      "sentry-mcp",
      'message:"database timeout" AND level:error',
    );
    expect(result).toMatchInlineSnapshot(
      `"https://sentry-mcp.sentry.io/explore/traces/?query=message%3A%22database+timeout%22+AND+level%3Aerror&statsPeriod=24h&table=span"`,
    );
  });
  it("should always use HTTPS protocol", () => {
    const apiService = new SentryApiService({
      host: "localhost:8000",
    });
    const result = apiService.getEventsExplorerUrl("sentry-mcp", "level:error");
    expect(result).toMatchInlineSnapshot(
      `"https://localhost:8000/organizations/sentry-mcp/explore/traces/?query=level%3Aerror&statsPeriod=24h&table=span"`,
    );
  });
  it("should handle regional URLs correctly for SaaS", () => {
    const apiService = new SentryApiService({ host: "us.sentry.io" });
    const result = apiService.getEventsExplorerUrl("sentry", "level:error");
    // Should use sentry.io, not us.sentry.io for web UI
    expect(result).toEqual(
      "https://sentry.sentry.io/explore/traces/?query=level%3Aerror&statsPeriod=24h&table=span",
    );
  });

  describe("time parameters", () => {
    it("should use statsPeriod when provided for spans dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "level:error",
        undefined, // projectId
        "spans", // dataset
        undefined, // fields
        undefined, // sort
        undefined, // aggregateFunctions
        undefined, // groupByFields
        "7d", // statsPeriod
      );
      expect(result).toContain("statsPeriod=7d");
      expect(result).not.toContain("start=");
      expect(result).not.toContain("end=");
    });

    it("should use start/end when provided for spans dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "level:error",
        undefined, // projectId
        "spans", // dataset
        undefined, // fields
        undefined, // sort
        undefined, // aggregateFunctions
        undefined, // groupByFields
        undefined, // statsPeriod
        "2025-07-29T07:00:00", // start
        "2025-07-31T06:59:59", // end
      );
      expect(result).toContain("start=2025-07-29T07%3A00%3A00");
      expect(result).toContain("end=2025-07-31T06%3A59%3A59");
      expect(result).not.toContain("statsPeriod=");
    });

    it("should prefer start/end over statsPeriod when both provided for spans dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "level:error",
        undefined, // projectId
        "spans", // dataset
        undefined, // fields
        undefined, // sort
        undefined, // aggregateFunctions
        undefined, // groupByFields
        "7d", // statsPeriod (should be ignored)
        "2025-07-29T07:00:00", // start
        "2025-07-31T06:59:59", // end
      );
      expect(result).toContain("start=2025-07-29T07%3A00%3A00");
      expect(result).toContain("end=2025-07-31T06%3A59%3A59");
      expect(result).not.toContain("statsPeriod=");
    });

    it("should use statsPeriod when provided for errors dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "level:error",
        undefined, // projectId
        "errors", // dataset
        undefined, // fields
        undefined, // sort
        undefined, // aggregateFunctions
        undefined, // groupByFields
        "14d", // statsPeriod
      );
      expect(result).toContain("statsPeriod=14d");
      expect(result).not.toContain("start=");
      expect(result).not.toContain("end=");
    });

    it("should use start/end when provided for errors dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "level:error",
        undefined, // projectId
        "errors", // dataset
        undefined, // fields
        undefined, // sort
        undefined, // aggregateFunctions
        undefined, // groupByFields
        undefined, // statsPeriod
        "2025-07-29T07:00:00", // start
        "2025-07-31T06:59:59", // end
      );
      expect(result).toContain("start=2025-07-29T07%3A00%3A00");
      expect(result).toContain("end=2025-07-31T06%3A59%3A59");
      expect(result).not.toContain("statsPeriod=");
    });

    it("should default to 24h when no time parameters provided", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "level:error",
      );
      expect(result).toContain("statsPeriod=24h");
    });

    it("should handle aggregate queries with time parameters for spans dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "",
        "4509062593708032", // projectId
        "spans", // dataset
        [
          "equation|sum(gen_ai.usage.input_tokens) + sum(gen_ai.usage.output_tokens)",
        ], // fields
        "-equation|sum(gen_ai.usage.input_tokens) + sum(gen_ai.usage.output_tokens)", // sort
        [
          "equation|sum(gen_ai.usage.input_tokens) + sum(gen_ai.usage.output_tokens)",
        ], // aggregateFunctions
        [], // groupByFields
        "7d", // statsPeriod
      );
      expect(result).toContain("statsPeriod=7d");
      expect(result).toContain("project=4509062593708032");
      expect(result).toContain("mode=aggregate");
    });
  });

  describe("logs dataset", () => {
    it("should build a sample Logs Explorer URL scoped to all projects", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "severity:error",
        undefined,
        "logs",
        ["timestamp", "message", "severity"],
        "-timestamp",
        undefined,
        undefined,
        "7d",
      );
      const url = new URL(result);

      expect(url.pathname).toBe("/explore/logs/");
      expect(url.searchParams.get("logsQuery")).toBe("severity:error");
      expect(url.searchParams.getAll("logsFields")).toEqual([
        "timestamp",
        "message",
        "severity",
      ]);
      expect(url.searchParams.get("logsSortBys")).toBe("-timestamp");
      expect(url.searchParams.get("mode")).toBe("samples");
      expect(url.searchParams.get("project")).toBe("-1");
      expect(url.searchParams.get("statsPeriod")).toBe("7d");
      expect(url.searchParams.has("query")).toBe(false);
      expect(url.searchParams.has("field")).toBe(false);
      expect(url.searchParams.has("sort")).toBe(false);
    });

    it("should preserve explicit project and absolute time scope", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "service:api",
        "123456",
        "logs",
        ["timestamp", "message"],
        "-timestamp",
        undefined,
        undefined,
        "7d",
        "2025-07-29T07:00:00",
        "2025-07-31T06:59:59",
      );
      const url = new URL(result);

      expect(url.searchParams.get("project")).toBe("123456");
      expect(url.searchParams.get("start")).toBe("2025-07-29T07:00:00");
      expect(url.searchParams.get("end")).toBe("2025-07-31T06:59:59");
      expect(url.searchParams.has("statsPeriod")).toBe(false);
    });

    it("should build an aggregate Logs Explorer URL", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });
      const result = apiService.getEventsExplorerUrl(
        "sentry-mcp",
        "severity:error",
        undefined,
        "logs",
        ["service", "count()"],
        "-count()",
        ["count()"],
        ["service"],
      );
      const url = new URL(result);

      expect(url.searchParams.get("mode")).toBe("aggregate");
      expect(url.searchParams.getAll("aggregateField")).toEqual([
        JSON.stringify({ groupBy: "service" }),
        JSON.stringify({ yAxes: ["count()"] }),
      ]);
      expect(url.searchParams.get("logsAggregateSortBys")).toBe("-count()");
      expect(url.searchParams.has("logsFields")).toBe(false);
      expect(url.searchParams.has("logsSortBys")).toBe(false);
    });
  });
});

describe("alert rule workflow endpoints", () => {
  it("rejects a project scope response missing its all-projects flag", async () => {
    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/my-org/workflows/123/project-scope/",
        () => HttpResponse.json({ projectIds: [] }),
      ),
    );

    await expect(
      apiService.getAlertRuleProjectScope({
        organizationSlug: "my-org",
        ruleId: "123",
      }),
    ).rejects.toThrow("includesAllProjects");
  });
});

describe("monitor time parameters", () => {
  it("defaults blank monitor statsPeriod values to a 24h window", async () => {
    const requestUrls: URL[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/my-org/monitors/nightly-import/checkins/",
        ({ request }) => {
          requestUrls.push(new URL(request.url));
          return HttpResponse.json([]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/my-org/monitors/nightly-import/stats/",
        ({ request }) => {
          requestUrls.push(new URL(request.url));
          return HttpResponse.json([]);
        },
      ),
    );

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await apiService.listMonitorCheckIns({
      organizationSlug: "my-org",
      monitorSlug: "nightly-import",
      statsPeriod: "   ",
      limit: 10,
    });
    await apiService.getMonitorStats({
      organizationSlug: "my-org",
      monitorSlug: "nightly-import",
      statsPeriod: "   ",
    });

    expect(requestUrls).toHaveLength(2);
    const [checkInsUrl, statsUrl] = requestUrls as [URL, URL];
    expect(checkInsUrl.pathname).toBe(
      "/api/0/organizations/my-org/monitors/nightly-import/checkins/",
    );
    expect(checkInsUrl.searchParams.get("statsPeriod")).toBe("24h");
    expect(statsUrl.pathname).toBe(
      "/api/0/organizations/my-org/monitors/nightly-import/stats/",
    );
    expect(statsUrl.searchParams.get("statsPeriod")).toBeNull();
    expect(statsUrl.searchParams.get("since")).not.toBeNull();
    expect(statsUrl.searchParams.get("until")).not.toBeNull();
  });

  it("rejects invalid monitor check-in statsPeriod values before sending a request", async () => {
    let requestReceived = false;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/my-org/monitors/nightly-import/checkins/",
        () => {
          requestReceived = true;
          return HttpResponse.json([]);
        },
      ),
    );

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(
      apiService.listMonitorCheckIns({
        organizationSlug: "my-org",
        monitorSlug: "nightly-import",
        statsPeriod: "bogus",
        limit: 10,
      }),
    ).rejects.toThrow("statsPeriod must use a supported relative time format");
    expect(requestReceived).toBe(false);
  });

  it("rejects conflicting monitor statsPeriod and absolute time ranges before sending requests", async () => {
    let requestReceived = false;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/my-org/monitors/nightly-import/checkins/",
        () => {
          requestReceived = true;
          return HttpResponse.json([]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/my-org/monitors/nightly-import/stats/",
        () => {
          requestReceived = true;
          return HttpResponse.json([]);
        },
      ),
    );

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });
    const params = {
      organizationSlug: "my-org",
      monitorSlug: "nightly-import",
      statsPeriod: "24h",
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-02T00:00:00Z",
    };

    await expect(apiService.listMonitorCheckIns(params)).rejects.toThrow(
      "Cannot use both statsPeriod and start/end parameters",
    );
    await expect(apiService.getMonitorStats(params)).rejects.toThrow(
      "Cannot use both statsPeriod and start/end parameters",
    );
    expect(requestReceived).toBe(false);
  });
});

describe("getIssue", () => {
  it("uses the numeric issue ID when Sentry returns a null shortId", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/my-org/issues/123456/",
        () =>
          HttpResponse.json({
            id: "123456",
            shortId: null,
            title: "TypeError: Cannot read properties of undefined",
            firstSeen: "2026-07-27T00:00:00Z",
            lastSeen: "2026-07-28T00:00:00Z",
            count: "1",
            userCount: 1,
            permalink: "https://sentry.io/issues/123456/",
            project: {
              id: "1",
              name: "test-project",
              slug: "test-project",
              platform: "javascript",
            },
            platform: "javascript",
            status: "unresolved",
            culprit: "app/example.ts",
            type: "error",
          }),
      ),
    );

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    const issue = await apiService.getIssue({
      organizationSlug: "my-org",
      issueId: "123456",
    });

    expect(issue.shortId).toBe("123456");
  });
});

describe("Alert inspection endpoints", () => {
  const api = new SentryApiService({
    host: "sentry.io",
    accessToken: "test-token",
  });
  const organizationSlug = "test-org";
  const workflowUrl =
    "https://sentry.io/api/0/organizations/test-org/workflows/";
  const workflow = { id: "10", name: "Notify on new issues", detectorIds: [] };

  it("keeps unattached workflows and returns the backend page cursor organization-wide", async () => {
    mswServer.use(
      http.get(workflowUrl, ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get("projectSlug")).toBeNull();
        expect(params.get("query")).toBe('name:"*new issues*"');
        expect(params.get("cursor")).toBe("previous");
        expect(params.get("per_page")).toBe("1");
        return HttpResponse.json([workflow], {
          headers: {
            Link: `<${workflowUrl}?cursor=next>; rel="next"; results="true"; cursor="next"`,
          },
        });
      }),
    );
    const params = {
      organizationSlug,
      query: "new issues",
      cursor: "previous",
      limit: 1,
    };
    const page = await api.listIssueAlertRulesPage(params);
    expect(page.nextCursor).toBe("next");
    expect(page.rules).toMatchObject([workflow]);
    expect(await api.listIssueAlertRules(params)).toEqual(page.rules);
  });

  it.each([
    {
      scope: {
        projectIds: [String(projectFixture.id), "99"],
        includesAllProjects: false,
      },
      allowed: true,
    },
    { scope: { projectIds: [], includesAllProjects: true }, allowed: true },
    {
      scope: { projectIds: ["99"], includesAllProjects: false },
      allowed: false,
    },
    { scope: { projectIds: [], includesAllProjects: false }, allowed: false },
    { scope: null, allowed: false },
  ])(
    "checks explicit project membership before returning a workflow: $scope",
    async ({ scope, allowed }) => {
      let detailReads = 0;
      const attachedWorkflow = { ...workflow, detectorIds: ["20"] };
      mswServer.use(
        http.get("https://sentry.io/api/0/projects/test-org/backend/", () =>
          HttpResponse.json(projectFixture),
        ),
        http.get(`${workflowUrl}10/project-scope/`, () =>
          scope
            ? HttpResponse.json(scope)
            : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
        ),
        http.get(`${workflowUrl}10/`, () => {
          detailReads++;
          return HttpResponse.json(attachedWorkflow);
        }),
      );
      const result = api.getIssueAlertRule({
        organizationSlug,
        projectSlug: "backend",
        ruleId: "10",
      });
      if (allowed) {
        expect(await result).toMatchObject(attachedWorkflow);
      } else {
        await expect(result).rejects.toBeInstanceOf(ApiNotFoundError);
      }
      expect(detailReads).toBe(allowed ? 1 : 0);
    },
  );
});

describe("network error handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should handle DNS errors with EAI_AGAIN", async () => {
    const dnsError = new Error("fetch failed");
    dnsError.cause = new Error("getaddrinfo EAI_AGAIN https");

    globalThis.fetch = vi.fn().mockRejectedValue(dnsError);

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      /DNS temporarily unavailable/,
    );
  });

  it("should handle ENOTFOUND errors", async () => {
    const notFoundError = new Error("fetch failed");
    notFoundError.cause = new Error("getaddrinfo ENOTFOUND invalid.host");

    globalThis.fetch = vi.fn().mockRejectedValue(notFoundError);

    const apiService = new SentryApiService({
      host: "invalid.host",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      /Hostname not found/,
    );
  });

  it("should handle ECONNREFUSED errors", async () => {
    const refusedError = new Error("fetch failed");
    refusedError.cause = new Error("connect ECONNREFUSED 127.0.0.1:443");

    globalThis.fetch = vi.fn().mockRejectedValue(refusedError);

    const apiService = new SentryApiService({
      host: "localhost",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      /Connection refused/,
    );
  });

  it("should handle ETIMEDOUT errors", async () => {
    const timeoutError = new Error("fetch failed");
    timeoutError.cause = new Error("connect ETIMEDOUT 192.168.1.1:443");

    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError);

    const apiService = new SentryApiService({
      host: "192.168.1.1",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      /Connection timed out/,
    );
  });

  it("should handle ECONNRESET errors", async () => {
    const resetError = new Error("fetch failed");
    resetError.cause = new Error("read ECONNRESET");

    globalThis.fetch = vi.fn().mockRejectedValue(resetError);

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      /Connection reset/,
    );
  });

  it("should handle generic network errors", async () => {
    const genericError = new Error("Network request failed");

    globalThis.fetch = vi.fn().mockRejectedValue(genericError);

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      /Unable to connect to .* - Network request failed/,
    );
  });

  it("should preserve the original error in the cause chain", async () => {
    const originalError = new Error("getaddrinfo EAI_AGAIN");
    const fetchError = new Error("fetch failed");
    fetchError.cause = originalError;

    globalThis.fetch = vi.fn().mockRejectedValue(fetchError);

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    try {
      await apiService.getAuthenticatedUser();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(fetchError);
      expect(((error as Error).cause as Error).cause).toBe(originalError);
    }
  });

  it("should throw ConfigurationError for DNS errors", async () => {
    const dnsError = new Error("fetch failed");
    dnsError.cause = new Error("getaddrinfo ENOTFOUND invalid.host");

    globalThis.fetch = vi.fn().mockRejectedValue(dnsError);

    const apiService = new SentryApiService({
      host: "invalid.host",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      ConfigurationError,
    );
  });

  it("should throw ConfigurationError for connection timeout errors", async () => {
    const timeoutError = new Error("fetch failed");
    timeoutError.cause = new Error("connect ETIMEDOUT 192.168.1.1:443");

    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError);

    const apiService = new SentryApiService({
      host: "192.168.1.1",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      ConfigurationError,
    );
  });
});

describe("transient 5xx retry", () => {
  let originalFetch: typeof globalThis.fetch;

  // A transient gateway failure like the ones Sentry's edge returns
  // ("upstream connect error ... reset before headers"), reported as 503.
  const serviceUnavailable = () =>
    new Response(
      "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
      { status: 503, statusText: "Service Unavailable" },
    );

  const internalError = () =>
    new Response(JSON.stringify({ detail: "Internal Error" }), {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json" },
    });

  const authOk = () =>
    new Response(
      JSON.stringify({ id: "1", name: "Test User", email: "test@example.com" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("retries a transient gateway error on a GET and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(serviceUnavailable())
      .mockResolvedValueOnce(serviceUnavailable())
      .mockResolvedValueOnce(authOk());
    globalThis.fetch = fetchMock;

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    const promise = apiService.getAuthenticatedUser();
    await vi.runAllTimersAsync();
    const user = await promise;

    expect(user.id).toBe("1");
    // Initial attempt + 2 retries, succeeding on the last one.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting the retry budget on a persistent gateway error", async () => {
    // A fresh Response per attempt — a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => serviceUnavailable());
    globalThis.fetch = fetchMock;

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    const promise = apiService.getAuthenticatedUser();
    // Attach a catch synchronously so the rejection is never unhandled while
    // fake timers advance through the backoff waits.
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(ApiServerError);
    // Initial attempt + 2 retries, all failing.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-gateway 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(internalError());
    globalThis.fetch = fetchMock;

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toBeInstanceOf(
      ApiServerError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-idempotent (POST) request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(serviceUnavailable());
    globalThis.fetch = fetchMock;

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    const promise = apiService.createTeam({
      organizationSlug: "my-org",
      name: "My Team",
    });
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(ApiServerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 5xx that the caller opted into via allowStatuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(serviceUnavailable());
    globalThis.fetch = fetchMock;

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    // getEventAttachment passes allowStatuses so the caller can inspect the raw
    // response; such requests must be returned as-is, never retried.
    const response = await (
      apiService as unknown as {
        request: (
          path: string,
          options?: RequestInit,
          requestOptions?: { host?: string; allowStatuses?: number[] },
        ) => Promise<Response>;
      }
    ).request("/auth/", undefined, { allowStatuses: [503] });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("request headers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should send MCP client headers when clientId and clientName are set", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "1",
          name: "Test User",
          email: "test@example.com",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
      clientId: "abc123",
      clientName: "Claude Code",
      clientFamily: "claude-code",
      utmSource: "plugin",
    });

    await apiService.getAuthenticatedUser();

    const [, requestInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(requestInit.headers["X-Sentry-MCP-Client-Id"]).toBe("abc123");
    expect(requestInit.headers["X-Sentry-MCP-Client-Name"]).toBe("Claude Code");
    expect(requestInit.headers["X-Sentry-MCP-Client-Family"]).toBe(
      "claude-code",
    );
    expect(requestInit.headers["X-Sentry-MCP-Utm-Source"]).toBe("plugin");
  });

  it("should not send MCP client headers when clientId and clientName are not set", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "1",
          name: "Test User",
          email: "test@example.com",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await apiService.getAuthenticatedUser();

    const [, requestInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(requestInit.headers["X-Sentry-MCP-Client-Id"]).toBeUndefined();
    expect(requestInit.headers["X-Sentry-MCP-Client-Name"]).toBeUndefined();
    expect(requestInit.headers["X-Sentry-MCP-Client-Family"]).toBeUndefined();
    expect(requestInit.headers["X-Sentry-MCP-Utm-Source"]).toBeUndefined();
  });
});

describe("listOrganizations", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should fetch from the organizations endpoint on the root host for SaaS", async () => {
    const mockOrgs = [
      { id: "1", slug: "org-us", name: "Org US" },
      { id: "2", slug: "org-eu", name: "Org EU" },
    ];

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes("/organizations/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockOrgs),
        });
      }
      return Promise.reject(new Error("Unexpected URL"));
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    const { organizations, nextCursor } = await apiService.listOrganizations();

    expect(callCount).toBe(1); // Single call, no region fanout
    expect(organizations).toHaveLength(2);
    expect(organizations).toContainEqual(
      expect.objectContaining({ slug: "org-us" }),
    );
    expect(organizations).toContainEqual(
      expect.objectContaining({ slug: "org-eu" }),
    );
    expect(nextCursor).toBeNull();
    // Region fanout is no longer used
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/users/me/regions/"),
      expect.any(Object),
    );
  });

  it("should fetch directly from organizations endpoint for self-hosted", async () => {
    const mockOrgs = [
      { id: "1", slug: "org-1", name: "Organization 1" },
      { id: "2", slug: "org-2", name: "Organization 2" },
    ];

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes("/organizations/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockOrgs),
        });
      }
      return Promise.reject(new Error("Unexpected URL"));
    });

    const apiService = new SentryApiService({
      host: "sentry.example.com",
      accessToken: "test-token",
    });

    const { organizations, nextCursor } = await apiService.listOrganizations();

    expect(callCount).toBe(1); // Only 1 org call, no regions call
    expect(organizations).toHaveLength(2);
    expect(organizations).toEqual(mockOrgs);
    expect(nextCursor).toBeNull();
    // Verify that regions endpoint was not called
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/users/me/regions/"),
      expect.any(Object),
    );
  });
});

describe("host configuration", () => {
  it("should handle hostname without protocol", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("sentry.io");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("https://sentry.io/api/0");
  });

  it("should handle hostname with port", () => {
    const apiService = new SentryApiService({ host: "localhost:8000" });
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("localhost:8000");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("https://localhost:8000/api/0");
  });

  it("should always use HTTPS protocol", () => {
    const apiService = new SentryApiService({
      host: "sentry.example.com",
    });
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("sentry.example.com");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("https://sentry.example.com/api/0");
  });

  it("should always use HTTPS even for localhost", () => {
    const apiService = new SentryApiService({
      host: "localhost:8000",
    });
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("localhost:8000");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("https://localhost:8000/api/0");
  });

  it("should support opt-in HTTP for self-hosted instances", () => {
    const apiService = new SentryApiService({
      host: "sentry.internal:9000",
      protocol: "http",
    });
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("sentry.internal:9000");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("http://sentry.internal:9000/api/0");
    expect(apiService.getIssueUrl("sentry-mcp", "123456")).toBe(
      "http://sentry.internal:9000/organizations/sentry-mcp/issues/123456",
    );
  });

  it("should update host and API prefix with setHost", () => {
    const apiService = new SentryApiService({ host: "sentry.io" });

    apiService.setHost("eu.sentry.io");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("eu.sentry.io");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("https://eu.sentry.io/api/0");

    apiService.setHost("localhost:9000");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.host).toBe("localhost:9000");
    // @ts-expect-error - accessing private property for testing
    expect(apiService.apiPrefix).toBe("https://localhost:9000/api/0");
  });
});

describe("Content-Type validation", () => {
  it("should throw error when receiving HTML instead of JSON", async () => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head><title>Login Required</title></head>
<body><h1>Please log in</h1></body>
</html>`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (key: string) =>
          key === "content-type" ? "text/html; charset=utf-8" : null,
      },
      text: () => Promise.resolve(htmlContent),
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      "Expected JSON response but received HTML (200 OK). This may indicate you're not authenticated, the URL is incorrect, or there's a server issue.",
    );
  });

  it("should throw error when receiving non-JSON content type", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (key: string) => (key === "content-type" ? "text/plain" : null),
      },
      text: () => Promise.resolve("Error: Something went wrong"),
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      "Expected JSON response but received text/plain (200 OK)",
    );
  });

  it("should throw error when no content-type header is present", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: () => null,
      },
      text: () => Promise.resolve("Some non-JSON response"),
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      "Expected JSON response but received unknown content type (200 OK)",
    );
  });

  it("should parse JSON successfully when content-type is application/json", async () => {
    const mockUser = {
      id: "123",
      name: "Test User",
      email: "test@example.com",
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (key: string) =>
          key === "content-type" ? "application/json; charset=utf-8" : null,
      },
      json: () => Promise.resolve(mockUser),
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    const result = await apiService.getAuthenticatedUser();
    expect(result).toEqual(mockUser);
  });

  it("should detect HTML content even without content-type header", async () => {
    const htmlContent = "<!DOCTYPE html><html><body>Error page</body></html>";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: () => null,
      },
      text: () => Promise.resolve(htmlContent),
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.getAuthenticatedUser()).rejects.toThrow(
      "Expected JSON response but received HTML (200 OK). This may indicate you're not authenticated, the URL is incorrect, or there's a server issue.",
    );
  });

  it("should handle HTML response from organizations endpoint", async () => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head><title>Login Required</title></head>
<body><h1>Please log in</h1></body>
</html>`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (key: string) =>
          key === "content-type" ? "text/html; charset=utf-8" : null,
      },
      text: () => Promise.resolve(htmlContent),
    });

    const apiService = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });

    await expect(apiService.listOrganizations()).rejects.toThrow(
      "Expected JSON response but received HTML (200 OK). This may indicate you're not authenticated, the URL is incorrect, or there's a server issue.",
    );
  });
});

describe("API query builders", () => {
  describe("buildDiscoverApiQuery", () => {
    it("should build correct query for errors dataset", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildDiscoverApiQuery({
        query: "level:error",
        fields: ["title", "project", "count()"],
        limit: 50,
        projectId: "backend",
        statsPeriod: "24h",
        sort: "-count()",
      });

      expect(params.toString()).toMatchInlineSnapshot(
        `"per_page=50&query=level%3Aerror&dataset=errors&statsPeriod=24h&project=backend&sort=-count%28%29&field=title&field=project&field=count%28%29&referrer=api.mcp.search-events"`,
      );
    });

    it("should pass aggregate sort parameters through unchanged", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildDiscoverApiQuery({
        query: "",
        fields: ["error.type", "count()", "count_unique(user)"],
        limit: 10,
        sort: "-count(span.duration)",
      });

      expect(params.get("sort")).toBe("-count(span.duration)");
    });

    it("should pass empty aggregate functions in sort through unchanged", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildDiscoverApiQuery({
        query: "",
        fields: ["title", "count()"],
        limit: 10,
        sort: "-count()",
      });

      expect(params.get("sort")).toBe("-count()");
    });

    it("should pass malformed sort parameters through unchanged", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildDiscoverApiQuery({
        query: "",
        fields: ["title"],
        limit: 10,
        sort: "-count(((",
      });

      // Should not crash and should return the original sort
      expect(params.get("sort")).toBe("-count(((");
    });

    it("should preserve sort parameters for tracemetrics", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildDiscoverApiQuery({
        query: "",
        fields: [
          "transaction",
          "p95(value,http.request.duration,distribution,millisecond)",
        ],
        limit: 10,
        dataset: "tracemetrics",
        sort: "-p95(value,http.request.duration,distribution,millisecond)",
      });

      expect(params.get("dataset")).toBe("tracemetrics");
      expect(params.get("sort")).toBe(
        "-p95(value,http.request.duration,distribution,millisecond)",
      );
    });
  });

  describe("buildEapApiQuery", () => {
    it("should build correct query for spans dataset with sampling", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildEapApiQuery({
        query: "span.op:db",
        fields: ["span.op", "span.description", "span.duration"],
        limit: 20,
        projectId: "frontend",
        dataset: "spans",
        statsPeriod: "1h",
        sort: "-span.duration",
      });

      expect(params.toString()).toMatchInlineSnapshot(
        `"per_page=20&query=span.op%3Adb&dataset=spans&statsPeriod=1h&project=frontend&sampling=NORMAL&sort=-span.duration&field=span.op&field=span.description&field=span.duration&referrer=api.mcp.search-events"`,
      );
    });

    it("should build correct query for logs dataset without sampling", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildEapApiQuery({
        query: "severity:error",
        fields: ["timestamp", "message", "severity"],
        limit: 30,
        dataset: "logs",
        sort: "-timestamp",
      });

      expect(params.toString()).toMatchInlineSnapshot(
        `"per_page=30&query=severity%3Aerror&dataset=logs&sort=-timestamp&field=timestamp&field=message&field=severity&referrer=api.mcp.search-events"`,
      );

      // Verify sampling is not added for logs
      expect(params.has("sampling")).toBe(false);
    });

    it("should pass aggregate sorts with dots through unchanged", () => {
      const apiService = new SentryApiService({ host: "sentry.io" });

      // @ts-expect-error - accessing private method for testing
      const params = apiService.buildEapApiQuery({
        query: "",
        fields: ["span.op", "avg(span.self_time)"],
        limit: 10,
        dataset: "spans",
        sort: "-avg(span.self_time)",
      });

      expect(params.get("sort")).toBe("-avg(span.self_time)");
    });
  });

  describe("searchEvents integration", () => {
    it("should route errors dataset to Discover API builder", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });

      // Mock the API response
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ data: [] }),
      });

      await apiService.searchEvents({
        organizationSlug: "test-org",
        query: "level:error",
        fields: ["title", "count()"],
        dataset: "errors",
        sort: "-count()",
      });

      // Verify the URL contains correct parameters
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("dataset=errors"),
        expect.any(Object),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("sort=-count%28%29"),
        expect.any(Object),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("referrer=api.mcp.search-events"),
        expect.any(Object),
      );
    });

    it("should route spans dataset to EAP API builder with sampling", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });

      // Mock the API response
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ data: [] }),
      });

      await apiService.searchEvents({
        organizationSlug: "test-org",
        query: "span.op:http",
        fields: ["span.op", "span.duration"],
        dataset: "spans",
      });

      // Verify the URL contains correct parameters
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("dataset=spans"),
        expect.any(Object),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("sampling=NORMAL"),
        expect.any(Object),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("referrer=api.mcp.search-events"),
        expect.any(Object),
      );
    });

    it("should normalize metrics dataset to tracemetrics for Discover queries", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ data: [] }),
      });

      await apiService.searchEvents({
        organizationSlug: "test-org",
        query: "",
        fields: [
          "transaction",
          "p95(value,http.request.duration,distribution,millisecond)",
        ],
        dataset: "metrics",
        sort: "-p95(value,http.request.duration,distribution,millisecond)",
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("dataset=tracemetrics"),
        expect.any(Object),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          "sort=-p95%28value%2Chttp.request.duration%2Cdistribution%2Cmillisecond%29",
        ),
        expect.any(Object),
      );
    });

    it("should build replay search requests with repeated environment params", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ data: [] }),
      });

      await apiService.searchReplays({
        organizationSlug: "test-org",
        query: "count_errors:>0",
        sort: "-count_errors",
        environment: ["production", "staging"],
        statsPeriod: "24h",
        limit: 25,
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/0/organizations/test-org/replays/?query=count_errors%3A%3E0&per_page=25&sort=-count_errors&environment=production&environment=staging&statsPeriod=24h",
        ),
        expect.any(Object),
      );
    });
  });

  describe("trace item attributes", () => {
    it("should list targeted attribute types with query filters", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
      const urls: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        urls.push(url);

        return Promise.resolve({
          ok: true,
          headers: {
            get: (key: string) =>
              key === "content-type" ? "application/json" : null,
          },
          json: () =>
            Promise.resolve([
              {
                key: "tags[type]",
                name: "type",
                attributeType: "string",
                attributeSource: {
                  source_type: "sentry",
                  is_transformed_alias: true,
                },
              },
              {
                key: "tags[enabled,boolean]",
                name: "enabled",
                attributeType: "boolean",
                attributeSource: { source_type: "user" },
              },
              {
                key: "tags[count,number]",
                name: "count",
                attributeType: "number",
                attributeSource: { source_type: "user" },
              },
              {
                key: "tags[secondary]",
                name: "secondary",
                attributeType: "string",
                attributeSource: { source_type: "user" },
                secondaryAliases: ["secondary.alias"],
              },
            ]),
        });
      });

      const result = await apiService.listTraceItemAttributes({
        organizationSlug: "test-org",
        itemType: "spans",
        project: "123",
        statsPeriod: "7d",
        attributeTypes: ["string", "boolean"],
        substringMatch: "tags[",
        query: 'transaction:"VPN connections"',
      });

      expect(result).toEqual([
        {
          key: "tags[type]",
          name: "type",
          type: "string",
          attributeSource: {
            source_type: "sentry",
            is_transformed_alias: true,
          },
        },
        {
          key: "tags[enabled,boolean]",
          name: "enabled",
          type: "boolean",
          attributeSource: { source_type: "user" },
        },
        {
          key: "tags[secondary]",
          name: "secondary",
          type: "string",
          attributeSource: { source_type: "user" },
          secondaryAliases: ["secondary.alias"],
        },
      ]);
      expect(urls).toHaveLength(1);
      const params = new URL(urls[0]!).searchParams;
      expect(params.get("itemType")).toBe("spans");
      expect(params.get("project")).toBe("123");
      expect(params.get("statsPeriod")).toBe("7d");
      expect(params.get("substringMatch")).toBe("tags[");
      expect(params.get("query")).toBe('transaction:"VPN connections"');
      expect(params.get("attributeType")).toBeNull();
      expect(params.get("expand")).toBeNull();
    });

    it("should request attribute context when context is enabled", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
      const urls: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        urls.push(url);

        return Promise.resolve({
          ok: true,
          headers: {
            get: (key: string) =>
              key === "content-type" ? "application/json" : null,
          },
          json: () => Promise.resolve([]),
        });
      });

      await apiService.listTraceItemAttributes({
        organizationSlug: "test-org",
        itemType: "spans",
        context: true,
      });

      expect(urls).toHaveLength(1);
      const params = new URL(urls[0]!).searchParams;
      expect(params.get("itemType")).toBe("spans");
      expect(params.get("expand")).toBe("context");
    });

    it("should validate events requests via the validate endpoint", async () => {
      const apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
      let requestUrl: string | undefined;
      let requestOptions: RequestInit | undefined;

      globalThis.fetch = vi
        .fn()
        .mockImplementation((url: string, options: RequestInit) => {
          requestUrl = url;
          requestOptions = options;
          return Promise.resolve({
            ok: false,
            status: 400,
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            json: () =>
              Promise.resolve({
                valid: false,
                projects: [{ valid: true, error: null }],
                dataset: [{ name: "spans", valid: true, error: null }],
                environment: [
                  {
                    valid: false,
                    error: "Unknown environments selected",
                  },
                ],
                field: [
                  {
                    name: "tags[type]",
                    valid: true,
                    attrType: "string",
                    error: null,
                  },
                  {
                    name: "tags[missing]",
                    valid: false,
                    attrType: null,
                    error: "Unknown attribute",
                  },
                ],
                query: {
                  valid: false,
                  error: "Invalid syntax",
                  fields: [
                    {
                      name: "transaction",
                      valid: true,
                      attrType: "string",
                      error: null,
                    },
                  ],
                },
                orderby: [
                  {
                    name: "-span.duration",
                    valid: false,
                    attrType: null,
                    error: "Orderby must also be a selected field",
                  },
                ],
              }),
          });
        });

      const result = await apiService.validateEvents({
        organizationSlug: "test-org",
        dataset: "spans",
        fields: ["tags[type]", "tags[missing]"],
        query: 'transaction:"VPN connections"',
        orderby: ["-span.duration"],
        environment: ["production", "staging"],
        project: "123",
        statsPeriod: "7d",
      });

      expect(result).toEqual({
        valid: false,
        projects: [{ valid: true }],
        dataset: [{ name: "spans", valid: true }],
        environment: [{ valid: false, error: "Unknown environments selected" }],
        field: [
          { name: "tags[type]", valid: true, type: "string" },
          {
            name: "tags[missing]",
            valid: false,
            error: "Unknown attribute",
          },
        ],
        query: {
          valid: false,
          error: "Invalid syntax",
          fields: [{ name: "transaction", valid: true, type: "string" }],
        },
        orderby: [
          {
            name: "-span.duration",
            valid: false,
            error: "Orderby must also be a selected field",
          },
        ],
      });
      expect(requestUrl).toContain(
        "/api/0/organizations/test-org/events/validate/?",
      );
      const params = new URL(String(requestUrl)).searchParams;
      expect(params.get("dataset")).toBe("spans");
      expect(params.get("project")).toBe("123");
      expect(params.get("statsPeriod")).toBe("7d");
      expect(params.get("query")).toBe('transaction:"VPN connections"');
      expect(params.getAll("field")).toEqual(["tags[type]", "tags[missing]"]);
      expect(params.getAll("orderby")).toEqual(["-span.duration"]);
      expect(params.getAll("environment")).toEqual(["production", "staging"]);
      expect(requestOptions?.method).toBeUndefined();
    });
  });

  describe("Web URL builders", () => {
    describe("buildDiscoverUrl", () => {
      it("should build correct URL for errors dataset on SaaS", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });

        // @ts-expect-error - accessing private method for testing
        const url = apiService.buildDiscoverUrl({
          organizationSlug: "my-org",
          query: "level:error",
          projectId: "backend",
          fields: ["title", "project", "timestamp"],
          sort: "-timestamp",
        });

        expect(url).toMatchInlineSnapshot(
          `"https://my-org.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=level%3Aerror&project=backend&field=title&field=project&field=timestamp&sort=-timestamp&statsPeriod=24h&yAxis=count%28%29"`,
        );
      });

      it("should include aggregate mode and yAxis for aggregate queries", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });

        // @ts-expect-error - accessing private method for testing
        const url = apiService.buildDiscoverUrl({
          organizationSlug: "my-org",
          query: "is:unresolved",
          fields: ["title", "count()"],
          sort: "-count()",
          aggregateFunctions: ["count()"],
          groupByFields: ["title"],
        });

        expect(url).toContain("mode=aggregate");
        expect(url).toContain("yAxis=count%28%29");
        expect(url).toContain("field=title");
        expect(url).toContain("field=count%28%29");
      });

      it("should build correct URL for self-hosted", () => {
        const apiService = new SentryApiService({ host: "sentry.example.com" });

        // @ts-expect-error - accessing private method for testing
        const url = apiService.buildDiscoverUrl({
          organizationSlug: "my-org",
          query: "level:error",
          fields: ["title", "project"],
        });

        expect(url).toMatchInlineSnapshot(
          `"https://sentry.example.com/organizations/my-org/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=level%3Aerror&field=title&field=project&sort=-timestamp&statsPeriod=24h&yAxis=count%28%29"`,
        );
      });
    });

    describe("spans explorer URLs", () => {
      it("should build correct URL for spans dataset with aggregate fields", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });
        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "is_transaction:True",
          "123456",
          "spans",
          ["span.description", "count()"],
          "-count()",
          ["count()"],
          ["span.description"],
        );

        expect(url).toContain("https://my-org.sentry.io/explore/traces/");
        expect(url).toContain("mode=aggregate");
        expect(url).toContain(
          `aggregateField=%7B%22groupBy%22%3A%22span.description%22%7D`,
        );
        expect(url).toContain(
          `aggregateField=%7B%22yAxes%22%3A%5B%22count%28%29%22%5D%7D`,
        );
        expect(url).toContain("project=123456");
        expect(url).toContain("query=is_transaction%3ATrue");
        expect(url).toContain("statsPeriod=24h");
      });

      it("should not include empty groupBy in aggregateField", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });
        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "span.op:db",
          undefined,
          "spans",
          ["count()"],
          "-count()",
          ["count()"],
          [],
        );

        expect(url).toContain("mode=aggregate");
        expect(url).toContain(
          `aggregateField=%7B%22yAxes%22%3A%5B%22count%28%29%22%5D%7D`,
        );
        expect(url).not.toContain("groupBy");
      });

      it("should handle multiple groupBy fields", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });
        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "",
          undefined,
          "spans",
          ["span.op", "span.description", "count()"],
          "-count()",
          ["count()"],
          ["span.op", "span.description"],
        );

        expect(url).toContain(
          `aggregateField=%7B%22groupBy%22%3A%22span.op%22%7D`,
        );
        expect(url).toContain(
          `aggregateField=%7B%22groupBy%22%3A%22span.description%22%7D`,
        );
        expect(url).toContain(
          `aggregateField=%7B%22yAxes%22%3A%5B%22count%28%29%22%5D%7D`,
        );
      });

      it("should handle non-aggregate queries", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });
        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "span.op:http",
          undefined,
          "spans",
          ["span.op", "span.description", "span.duration"],
          "-span.duration",
        );

        expect(url).not.toContain("mode=aggregate");
        expect(url).not.toContain("aggregateField");
        expect(url).toContain("field=span.op");
        expect(url).toContain("field=span.description");
        expect(url).toContain("field=span.duration");
        expect(url).toContain("sort=-span.duration");
      });

      it("should handle self-hosted URLs correctly", () => {
        const apiService = new SentryApiService({ host: "sentry.example.com" });
        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "",
          undefined,
          "spans",
          ["span.op"],
        );

        expect(url).toMatchInlineSnapshot(
          `"https://sentry.example.com/organizations/my-org/explore/traces/?query=&field=span.op&statsPeriod=24h&table=span"`,
        );
      });
    });

    describe("metrics page URLs", () => {
      it("should build a metrics page URL for metrics aggregates", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });

        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "",
          "123456",
          "metrics",
          [
            "transaction",
            "p95(value,http.request.duration,distribution,millisecond)",
            "count(value,http.request.duration,distribution,millisecond)",
          ],
          "-p95(value,http.request.duration,distribution,millisecond)",
          [
            "p95(value,http.request.duration,distribution,millisecond)",
            "count(value,http.request.duration,distribution,millisecond)",
          ],
          ["transaction"],
          "7d",
        );

        expect(url).toContain("https://my-org.sentry.io/explore/metrics/");
        expect(url).toContain("project=123456");
        expect(url).toContain("statsPeriod=7d");
        expect(url).toContain(`%22mode%22%3A%22aggregate%22`);
        expect(url).toContain(
          `%22field%22%3A%22p95%28value%2Chttp.request.duration%2Cdistribution%2Cmillisecond%29%22`,
        );
      });

      it("should derive concrete sample metrics from result rows", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });

        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "",
          "123456",
          "metrics",
          ["timestamp", "value"],
          "-timestamp",
          undefined,
          undefined,
          "14d",
          undefined,
          undefined,
          [
            {
              timestamp: "2026-04-13T14:19:18+00:00",
              "metric.name": "http.request.duration",
              "metric.type": "distribution",
              "metric.unit": "millisecond",
              value: 12.4,
            },
          ],
        );

        const parsedUrl = new URL(url);
        const metricQueries = parsedUrl.searchParams
          .getAll("metric")
          .map((value) => JSON.parse(value));

        expect(metricQueries).toEqual([
          {
            metric: {
              name: "http.request.duration",
              type: "distribution",
              unit: "millisecond",
            },
            query: "",
            aggregateFields: [{ yAxes: ["sum(value)"] }],
            aggregateSortBys: [{ field: "sum(value)", kind: "desc" }],
            mode: "samples",
          },
        ]);
      });
    });

    describe("profiles page URLs", () => {
      it("should preserve grouped profile field selection", () => {
        const apiService = new SentryApiService({ host: "sentry.io" });

        const url = apiService.getEventsExplorerUrl(
          "my-org",
          "",
          "123456",
          "profiles",
          ["release", "count()"],
          "-count()",
          ["count()"],
          ["release"],
          "7d",
        );

        const parsedUrl = new URL(url);

        expect(parsedUrl.pathname).toBe("/explore/profiling/");
        expect(parsedUrl.searchParams.get("project")).toBe("123456");
        expect(parsedUrl.searchParams.get("statsPeriod")).toBe("7d");
        expect(parsedUrl.searchParams.get("sort")).toBe("-count()");
        expect(parsedUrl.searchParams.getAll("field")).toEqual([
          "release",
          "count()",
        ]);
      });
    });
  });

  describe("listRepos", () => {
    let apiService: SentryApiService;

    beforeEach(() => {
      apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should call the repos endpoint without query", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () =>
          Promise.resolve([
            {
              id: "101",
              name: "getsentry/sentry",
              provider: { id: "integrations:github", name: "GitHub" },
              status: "active",
            },
          ]),
      });

      const repos = await apiService.listRepos({
        organizationSlug: "test-org",
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/test-org/repos/"),
        expect.any(Object),
      );
      expect(globalThis.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("query="),
        expect.any(Object),
      );
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("getsentry/sentry");
    });

    it("should paginate repos", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({
            "content-type": "application/json",
            link: '<https://sentry.io/api/0/organizations/test-org/repos/?cursor=cursor-2>; rel="next"; results="true"; cursor="cursor-2"',
          }),
          json: () =>
            Promise.resolve([
              {
                id: "101",
                name: "getsentry/sentry",
                provider: { id: "integrations:github", name: "GitHub" },
                status: "active",
              },
            ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({
            "content-type": "application/json",
          }),
          json: () =>
            Promise.resolve([
              {
                id: "102",
                name: "getsentry/sentry-javascript",
                provider: { id: "integrations:github", name: "GitHub" },
                status: "active",
              },
            ]),
        });
      globalThis.fetch = fetchMock;

      const repos = await apiService.listRepos({
        organizationSlug: "test-org",
      });

      expect(repos.map((repo) => repo.name)).toEqual([
        "getsentry/sentry",
        "getsentry/sentry-javascript",
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("per_page=100");
      expect(fetchMock.mock.calls[1][0]).toContain("cursor=cursor-2");
    });

    it("should include query parameter when provided", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () =>
          Promise.resolve([
            {
              id: "101",
              name: "getsentry/sentry",
              provider: { id: "integrations:github", name: "GitHub" },
              status: "active",
            },
          ]),
      });

      await apiService.listRepos({
        organizationSlug: "test-org",
        query: "getsentry/sentry",
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("query=getsentry"),
        expect.any(Object),
      );
    });

    it("should return empty array when no repos exist", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve([]),
      });

      const repos = await apiService.listRepos({
        organizationSlug: "test-org",
      });

      expect(repos).toHaveLength(0);
    });
  });

  describe("linkProjectRepository", () => {
    let apiService: SentryApiService;

    beforeEach(() => {
      apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should POST to the code mappings bulk endpoint", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () =>
          Promise.resolve({
            created: 1,
            updated: 0,
            errors: 0,
            mappings: [
              {
                stackRoot: "",
                sourceRoot: "",
                status: "created",
              },
            ],
          }),
      });

      const result = await apiService.linkProjectRepository({
        organizationSlug: "test-org",
        projectSlug: "my-project",
        repository: "getsentry/sentry",
        provider: "github",
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/organizations/test-org/code-mappings/bulk/"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            project: "my-project",
            repository: "getsentry/sentry",
            provider: "github",
            mappings: [
              {
                stackRoot: "",
                sourceRoot: "",
              },
            ],
          }),
        }),
      );
      expect(result.created).toBe(1);
      expect(result.mappings[0]!.status).toBe("created");
    });

    it("should handle updated mappings response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) =>
            key === "content-type" ? "application/json" : null,
        },
        json: () =>
          Promise.resolve({
            created: 0,
            updated: 1,
            errors: 0,
            mappings: [
              {
                stackRoot: "",
                sourceRoot: "",
                status: "updated",
              },
            ],
          }),
      });

      const result = await apiService.linkProjectRepository({
        organizationSlug: "test-org",
        projectSlug: "my-project",
        repository: "getsentry/sentry",
      });

      expect(result.updated).toBe(1);
      expect(result.mappings[0]!.status).toBe("updated");
    });
  });

  describe("listProjectTeams", () => {
    let apiService: SentryApiService;

    beforeEach(() => {
      apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("follows pagination cursors", async () => {
      const backendTeam = {
        ...teamFixture,
        id: "4509109078196224",
        slug: "backend",
        name: "Backend",
      };
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        const parsedUrl = new URL(url);
        const isNextPage =
          parsedUrl.searchParams.get("cursor") === "team-cursor";

        return Promise.resolve({
          ok: true,
          headers: {
            get: (key: string) => {
              if (key === "content-type") {
                return "application/json";
              }
              if (key === "link" && !isNextPage) {
                return '<https://sentry.io/api/0/projects/test-org/my-project/teams/?cursor=team-cursor>; rel="next"; results="true"; cursor="team-cursor"';
              }
              return null;
            },
          },
          json: () =>
            Promise.resolve(isNextPage ? [backendTeam] : [teamFixture]),
        });
      });

      const teams = await apiService.listProjectTeams({
        organizationSlug: "test-org",
        projectSlug: "my-project",
      });

      expect(teams.map((team) => team.slug)).toEqual(["the-goats", "backend"]);
    });
  });

  describe("project identifier request shape regressions", () => {
    let apiService: SentryApiService;

    beforeEach(() => {
      apiService = new SentryApiService({
        host: "sentry.io",
        accessToken: "test-token",
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("preserves replay project slugs in path parameters", async () => {
      let requestUrl: string | undefined;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        requestUrl = url;
        return Promise.resolve({
          ok: true,
          headers: {
            get: (key: string) =>
              key === "content-type" ? "application/json" : null,
          },
          json: () => Promise.resolve([["segment-1"]]),
        });
      });

      await apiService.getReplayRecordingSegments({
        organizationSlug: "test-org",
        projectSlugOrId: "frontend",
        replayId: "replay-123",
      });

      expect(requestUrl).toContain(
        "/projects/test-org/frontend/replays/replay-123/recording-segments/",
      );
      expect(requestUrl).not.toContain("NaN");
    });

    it("uses projectSlug for release deploy slug filters", async () => {
      let requestUrl: string | undefined;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        requestUrl = url;
        return Promise.resolve({
          ok: true,
          headers: {
            get: (key: string) =>
              key === "content-type" ? "application/json" : null,
          },
          json: () => Promise.resolve([]),
        });
      });

      await apiService.listReleaseDeploys({
        organizationSlug: "test-org",
        releaseVersion: "frontend@1.0.0",
        projectSlugOrId: "frontend",
      });

      const params = new URL(String(requestUrl)).searchParams;
      expect(params.get("projectSlug")).toBe("frontend");
      expect(params.get("project")).toBeNull();
      expect(requestUrl).not.toContain("NaN");
    });

    it("uses project for release deploy numeric ID filters", async () => {
      let requestUrl: string | undefined;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        requestUrl = url;
        return Promise.resolve({
          ok: true,
          headers: {
            get: (key: string) =>
              key === "content-type" ? "application/json" : null,
          },
          json: () => Promise.resolve([]),
        });
      });

      await apiService.listReleaseDeploys({
        organizationSlug: "test-org",
        releaseVersion: "frontend@1.0.0",
        projectSlugOrId: "12345",
      });

      const params = new URL(String(requestUrl)).searchParams;
      expect(params.get("project")).toBe("12345");
      expect(params.get("projectSlug")).toBeNull();
      expect(requestUrl).not.toContain("NaN");
    });
  });
});
