import { describe, expect, it } from "vitest";
import {
  extractConversationIdFromSearchQuery,
  getAIConversationUrl,
  getEventsExplorerUrl,
  getIssuesSearchUrl,
  getIssueUrl,
  getLogUrl,
  getMonitorUrl,
  getPreprodSnapshotUrl,
  getReleaseUrl,
  getReplaysSearchUrl,
  getReplayUrl,
  getTraceMetricsExploreUrl,
  getTraceUrl,
  getUptimeMonitorUrl,
  validateAndParseSentryUrlThrows,
  validateOpenAiBaseUrlThrows,
  validateSentryHostThrows,
} from "./url-utils";

describe("url-utils", () => {
  describe("validateSentryHostThrows", () => {
    it("should accept valid hostnames", () => {
      expect(() => validateSentryHostThrows("sentry.io")).not.toThrow();
      expect(() => validateSentryHostThrows("example.com")).not.toThrow();
      expect(() => validateSentryHostThrows("localhost:8000")).not.toThrow();
      expect(() =>
        validateSentryHostThrows("sentry.example.com"),
      ).not.toThrow();
    });

    it("should reject hostnames with http protocol", () => {
      expect(() => validateSentryHostThrows("http://sentry.io")).toThrow(
        "SENTRY_HOST should only contain a hostname",
      );
      expect(() => validateSentryHostThrows("http://example.com:8000")).toThrow(
        "SENTRY_HOST should only contain a hostname",
      );
    });

    it("should reject hostnames with https protocol", () => {
      expect(() => validateSentryHostThrows("https://sentry.io")).toThrow(
        "SENTRY_HOST should only contain a hostname",
      );
      expect(() => validateSentryHostThrows("https://example.com:443")).toThrow(
        "SENTRY_HOST should only contain a hostname",
      );
    });
  });

  describe("validateOpenAiBaseUrlThrows", () => {
    it("should accept valid HTTPS URLs", () => {
      expect(() =>
        validateOpenAiBaseUrlThrows("https://api.openai.com/v1"),
      ).not.toThrow();
      expect(() =>
        validateOpenAiBaseUrlThrows(
          "https://custom.example.com/openai/deployments/model",
        ),
      ).not.toThrow();
    });

    it("should accept valid HTTP URLs for local development", () => {
      expect(() =>
        validateOpenAiBaseUrlThrows("http://localhost:8080/v1"),
      ).not.toThrow();
    });

    it("should reject empty strings", () => {
      expect(() => validateOpenAiBaseUrlThrows(" ")).toThrow(
        "OPENAI base URL must not be empty.",
      );
    });

    it("should reject URLs with unsupported protocols", () => {
      expect(() => validateOpenAiBaseUrlThrows("ftp://example.com")).toThrow(
        "OPENAI base URL must use http or https scheme",
      );
    });

    it("should reject invalid URLs", () => {
      expect(() => validateOpenAiBaseUrlThrows("not-a-url")).toThrow(
        "OPENAI base URL must be a valid HTTP or HTTPS URL",
      );
    });
  });

  describe("validateAndParseSentryUrlThrows", () => {
    it("should accept and parse valid HTTPS URLs", () => {
      expect(validateAndParseSentryUrlThrows("https://sentry.io")).toBe(
        "sentry.io",
      );
      expect(validateAndParseSentryUrlThrows("https://example.com")).toBe(
        "example.com",
      );
      expect(validateAndParseSentryUrlThrows("https://localhost:8000")).toBe(
        "localhost:8000",
      );
      expect(
        validateAndParseSentryUrlThrows("https://sentry.example.com"),
      ).toBe("sentry.example.com");
      expect(validateAndParseSentryUrlThrows("https://example.com:443")).toBe(
        "example.com",
      );
    });

    it("should reject URLs without protocol", () => {
      expect(() => validateAndParseSentryUrlThrows("sentry.io")).toThrow(
        "SENTRY_URL must be a full HTTPS URL",
      );
      expect(() => validateAndParseSentryUrlThrows("example.com")).toThrow(
        "SENTRY_URL must be a full HTTPS URL",
      );
    });

    it("should reject HTTP URLs", () => {
      expect(() => validateAndParseSentryUrlThrows("http://sentry.io")).toThrow(
        "SENTRY_URL must be a full HTTPS URL",
      );
      expect(() =>
        validateAndParseSentryUrlThrows("http://example.com:8000"),
      ).toThrow("SENTRY_URL must be a full HTTPS URL");
    });

    it("should reject invalid URLs", () => {
      expect(() => validateAndParseSentryUrlThrows("https://")).toThrow(
        "SENTRY_URL must be a valid HTTPS URL",
      );
      expect(() =>
        validateAndParseSentryUrlThrows("https://[invalid-bracket"),
      ).toThrow("SENTRY_URL must be a valid HTTPS URL");
    });
  });

  describe("getIssueUrl", () => {
    it("should handle regional URLs correctly for SaaS", () => {
      const result = getIssueUrl("us.sentry.io", "myorg", "PROJ-123");
      expect(result).toBe("https://myorg.sentry.io/issues/PROJ-123");
    });

    it("should handle EU regional URLs correctly", () => {
      const result = getIssueUrl("eu.sentry.io", "myorg", "PROJ-456");
      expect(result).toBe("https://myorg.sentry.io/issues/PROJ-456");
    });

    it("should handle standard sentry.io correctly", () => {
      const result = getIssueUrl("sentry.io", "myorg", "PROJ-789");
      expect(result).toBe("https://myorg.sentry.io/issues/PROJ-789");
    });

    it("should handle self-hosted correctly", () => {
      const result = getIssueUrl("sentry.example.com", "myorg", "PROJ-123");
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/issues/PROJ-123",
      );
    });

    it("should support HTTP for self-hosted issue URLs when requested", () => {
      const result = getIssueUrl(
        "sentry.internal:9000",
        "myorg",
        "PROJ-123",
        "http",
      );
      expect(result).toBe(
        "http://sentry.internal:9000/organizations/myorg/issues/PROJ-123",
      );
    });
  });

  describe("getReleaseUrl", () => {
    it("should encode release versions in the path segment", () => {
      const result = getReleaseUrl(
        "sentry.io",
        "myorg",
        "backend/web 2025.04.13",
      );
      expect(result).toBe(
        "https://myorg.sentry.io/releases/backend%2Fweb%202025.04.13/",
      );
    });
  });

  describe("getMonitorUrl", () => {
    it("should encode project and monitor path segments independently", () => {
      const result = getMonitorUrl(
        "sentry.io",
        "myorg",
        "daily/import 1",
        "https",
        "backend",
      );
      expect(result).toBe(
        "https://myorg.sentry.io/crons/backend/daily%2Fimport%201/",
      );
    });

    it("should use self-hosted organization paths", () => {
      const result = getMonitorUrl(
        "sentry.internal:9000",
        "myorg",
        "daily-backup",
        "http",
        "backend",
      );
      expect(result).toBe(
        "http://sentry.internal:9000/organizations/myorg/crons/backend/daily-backup/",
      );
    });
  });

  describe("getPreprodSnapshotUrl", () => {
    it("should handle regional URLs correctly for SaaS", () => {
      const result = getPreprodSnapshotUrl("us.sentry.io", "myorg", "12");
      expect(result).toBe("https://myorg.sentry.io/preprod/snapshots/12/");
    });

    it("should handle standard sentry.io correctly", () => {
      const result = getPreprodSnapshotUrl("sentry.io", "myorg", "12");
      expect(result).toBe("https://myorg.sentry.io/preprod/snapshots/12/");
    });

    it("should handle self-hosted correctly", () => {
      const result = getPreprodSnapshotUrl("sentry.example.com", "myorg", "12");
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/preprod/snapshots/12/",
      );
    });

    it("should support HTTP for self-hosted snapshot URLs when requested", () => {
      const result = getPreprodSnapshotUrl(
        "sentry.internal:9000",
        "myorg",
        "12",
        "http",
      );
      expect(result).toBe(
        "http://sentry.internal:9000/organizations/myorg/preprod/snapshots/12/",
      );
    });
  });

  describe("getIssuesSearchUrl", () => {
    it("should handle regional URLs correctly for SaaS", () => {
      const result = getIssuesSearchUrl(
        "us.sentry.io",
        "myorg",
        "is:unresolved",
        "proj1",
      );
      expect(result).toBe(
        "https://myorg.sentry.io/issues/?project=proj1&query=is%3Aunresolved",
      );
    });

    it("should handle EU regional URLs correctly", () => {
      const result = getIssuesSearchUrl("eu.sentry.io", "myorg", "is:resolved");
      expect(result).toBe(
        "https://myorg.sentry.io/issues/?query=is%3Aresolved",
      );
    });

    it("should handle self-hosted correctly", () => {
      const result = getIssuesSearchUrl(
        "sentry.example.com",
        "myorg",
        "is:unresolved",
        "proj1",
      );
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/issues/?project=proj1&query=is%3Aunresolved",
      );
    });

    it("should support HTTP for self-hosted issue search URLs when requested", () => {
      const result = getIssuesSearchUrl(
        "sentry.internal:9000",
        "myorg",
        "is:unresolved",
        "proj1",
        "http",
      );
      expect(result).toBe(
        "http://sentry.internal:9000/organizations/myorg/issues/?project=proj1&query=is%3Aunresolved",
      );
    });
  });

  describe("getTraceUrl", () => {
    it("should handle regional URLs correctly for SaaS", () => {
      const result = getTraceUrl("us.sentry.io", "myorg", "abc123def456");
      expect(result).toBe(
        "https://myorg.sentry.io/explore/traces/trace/abc123def456",
      );
    });

    it("should handle EU regional URLs correctly", () => {
      const result = getTraceUrl("eu.sentry.io", "myorg", "xyz789");
      expect(result).toBe(
        "https://myorg.sentry.io/explore/traces/trace/xyz789",
      );
    });

    it("should handle self-hosted correctly", () => {
      const result = getTraceUrl("sentry.example.com", "myorg", "abc123");
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/explore/traces/trace/abc123",
      );
    });
  });

  describe("getLogUrl", () => {
    it("pins the log in the logs explorer for SaaS", () => {
      const result = getLogUrl("us.sentry.io", "myorg", "abc123");
      expect(result).toBe(
        "https://myorg.sentry.io/explore/logs/?project=-1&logsPinned=abc123",
      );
    });

    it("pins the log in the logs explorer for self-hosted", () => {
      const result = getLogUrl("sentry.example.com", "myorg", "abc123");
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/explore/logs/?project=-1&logsPinned=abc123",
      );
    });
  });

  describe("getReplaysSearchUrl", () => {
    it("should handle regional URLs correctly for SaaS", () => {
      const result = getReplaysSearchUrl("us.sentry.io", "myorg", {
        query: "count_errors:>0",
        projectSlugOrId: "123",
        environment: ["production", "staging"],
        sort: "-count_errors",
        statsPeriod: "24h",
      });
      expect(result).toBe(
        "https://myorg.sentry.io/explore/replays/?project=123&query=count_errors%3A%3E0&environment=production&environment=staging&sort=-count_errors&statsPeriod=24h",
      );
    });

    it("should handle self-hosted correctly", () => {
      const result = getReplaysSearchUrl("sentry.example.com", "myorg", {
        query: "url:*checkout*",
        start: "2025-01-01T00:00:00Z",
        end: "2025-01-02T00:00:00Z",
      });
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/explore/replays/?query=url%3A*checkout*&start=2025-01-01T00%3A00%3A00Z&end=2025-01-02T00%3A00%3A00Z",
      );
    });
  });

  describe("getReplayUrl", () => {
    it("should return the canonical replay details path for SaaS", () => {
      const result = getReplayUrl("us.sentry.io", "myorg", "abc123");
      expect(result).toBe("https://myorg.sentry.io/explore/replays/abc123/");
    });

    it("should handle self-hosted correctly", () => {
      const result = getReplayUrl("sentry.example.com", "myorg", "abc123");
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/explore/replays/abc123/",
      );
    });
  });

  describe("getEventsExplorerUrl", () => {
    it("should handle regional URLs correctly for SaaS", () => {
      const result = getEventsExplorerUrl(
        "us.sentry.io",
        "myorg",
        "level:error",
        "errors",
        "proj1",
      );
      expect(result).toBe(
        "https://myorg.sentry.io/explore/?query=level%3Aerror&dataset=errors&layout=table&project=proj1",
      );
    });

    it("should handle EU regional URLs correctly", () => {
      const result = getEventsExplorerUrl(
        "eu.sentry.io",
        "myorg",
        "level:warning",
        "spans",
      );
      expect(result).toBe(
        "https://myorg.sentry.io/explore/?query=level%3Awarning&dataset=spans&layout=table",
      );
    });

    it("should handle self-hosted correctly", () => {
      const result = getEventsExplorerUrl(
        "sentry.example.com",
        "myorg",
        "level:error",
        "logs",
        "proj1",
      );
      expect(result).toBe(
        "https://sentry.example.com/organizations/myorg/explore/?query=level%3Aerror&dataset=logs&layout=table&project=proj1",
      );
    });

    it("should build metrics aggregate URLs from the public helper fields", () => {
      const result = getEventsExplorerUrl(
        "us.sentry.io",
        "myorg",
        "",
        "metrics",
        "123456",
        [
          "transaction",
          "p95(value,http.request.duration,distribution,millisecond)",
          "count(value,http.request.duration,distribution,millisecond)",
        ],
      );

      expect(result).toContain("https://myorg.sentry.io/explore/metrics/");
      expect(result).toContain("project=123456");
      expect(result).toContain(`%22mode%22%3A%22aggregate%22`);
      expect(result).toContain(`%22groupBy%22%3A%22transaction%22`);
    });

    it("should keep derived metrics aggregate fields when options omit explicit overrides", () => {
      const result = getEventsExplorerUrl(
        "us.sentry.io",
        "myorg",
        "",
        "metrics",
        "123456",
        [
          "transaction",
          "p95(value,http.request.duration,distribution,millisecond)",
        ],
        {
          sort: "-p95(value,http.request.duration,distribution,millisecond)",
          aggregateFunctions: undefined,
          groupByFields: undefined,
        },
      );

      expect(result).toContain(`%22mode%22%3A%22aggregate%22`);
      expect(result).toContain(`%22groupBy%22%3A%22transaction%22`);
    });

    it("should preserve grouped profile fields for profiling explorer URLs", () => {
      const result = getEventsExplorerUrl(
        "us.sentry.io",
        "myorg",
        "",
        "profiles",
        "123456",
        ["release", "count()"],
        {
          sort: "-count()",
          statsPeriod: "7d",
          aggregateFunctions: undefined,
          groupByFields: undefined,
        },
      );

      const url = new URL(result);

      expect(url.pathname).toBe("/explore/profiling/");
      expect(url.searchParams.get("project")).toBe("123456");
      expect(url.searchParams.get("statsPeriod")).toBe("7d");
      expect(url.searchParams.get("sort")).toBe("-count()");
      expect(url.searchParams.getAll("field")).toEqual(["release", "count()"]);
    });
  });

  describe("extractConversationIdFromSearchQuery", () => {
    it("extracts a quoted conversation id", () => {
      expect(
        extractConversationIdFromSearchQuery(
          'gen_ai.conversation.id:"14365297"',
        ),
      ).toBe("14365297");
    });

    it("extracts an unquoted conversation id", () => {
      expect(
        extractConversationIdFromSearchQuery("gen_ai.conversation.id:14365297"),
      ).toBe("14365297");
    });

    it("extracts an unquoted conversation id from a grouped filter", () => {
      expect(
        extractConversationIdFromSearchQuery(
          "(gen_ai.conversation.id:14365297)",
        ),
      ).toBe("14365297");
    });

    it("returns undefined when no conversation id is present", () => {
      expect(
        extractConversationIdFromSearchQuery("span.op:ai"),
      ).toBeUndefined();
      expect(extractConversationIdFromSearchQuery("")).toBeUndefined();
      expect(extractConversationIdFromSearchQuery(null)).toBeUndefined();
    });

    it("returns undefined when multiple conversation ids are present", () => {
      expect(
        extractConversationIdFromSearchQuery(
          'gen_ai.conversation.id:"1" OR gen_ai.conversation.id:"2"',
        ),
      ).toBeUndefined();
    });

    it("returns undefined for negated conversation id filters", () => {
      expect(
        extractConversationIdFromSearchQuery(
          '!gen_ai.conversation.id:"14365297"',
        ),
      ).toBeUndefined();
      expect(
        extractConversationIdFromSearchQuery(
          'NOT gen_ai.conversation.id:"14365297"',
        ),
      ).toBeUndefined();
      expect(
        extractConversationIdFromSearchQuery(
          'NOT (gen_ai.conversation.id:"14365297")',
        ),
      ).toBeUndefined();
    });

    it("returns undefined when negated and positive conversation id filters are combined", () => {
      expect(
        extractConversationIdFromSearchQuery(
          '!gen_ai.conversation.id:"1" OR gen_ai.conversation.id:"2"',
        ),
      ).toBeUndefined();
    });

    it("returns undefined for IN-style bracket conversation id filters", () => {
      expect(
        extractConversationIdFromSearchQuery("gen_ai.conversation.id:[1,2]"),
      ).toBeUndefined();
    });
  });

  describe("getAIConversationUrl", () => {
    it("encodes conversation ids as path segments", () => {
      expect(
        getAIConversationUrl("us.sentry.io", "myorg", "thread/1?x=y"),
      ).toBe(
        "https://myorg.sentry.io/explore/conversations/thread%2F1%3Fx%3Dy/",
      );
    });
  });

  describe("getTraceMetricsExploreUrl", () => {
    it("should build sample metric URLs with concrete metric state", () => {
      const result = getTraceMetricsExploreUrl("sentry.io", "myorg", {
        query: "",
        projectId: "123456",
        statsPeriod: "14d",
        traceMetrics: [
          {
            name: "http.request.duration",
            type: "distribution",
            unit: "millisecond",
          },
        ],
      });

      const url = new URL(result);
      const metricQueries = url.searchParams
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

  describe("getUptimeMonitorUrl", () => {
    it("builds saas and self-hosted monitor urls", () => {
      expect(getUptimeMonitorUrl("sentry.io", "my-org", "12345")).toBe(
        "https://my-org.sentry.io/monitors/12345/",
      );
      expect(
        getUptimeMonitorUrl("sentry.internal:9000", "my-org", "12345", "http"),
      ).toBe(
        "http://sentry.internal:9000/organizations/my-org/monitors/12345/",
      );
    });

    it("normalizes regional saas hosts to sentry.io web urls", () => {
      expect(getUptimeMonitorUrl("us.sentry.io", "my-org", "12345")).toBe(
        "https://my-org.sentry.io/monitors/12345/",
      );
      expect(getUptimeMonitorUrl("de.sentry.io", "my-org", "12345")).toBe(
        "https://my-org.sentry.io/monitors/12345/",
      );
    });
  });
});
