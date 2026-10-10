import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { SentryApiService } from "../../../api-client";
import * as logging from "../../../telem/logging";
import {
  createValidateEventsSearchTool,
  fetchCustomAttributes,
  formatEventsValidationResults,
  formatEventValue,
  formatKnownUserValue,
  isSemanticFilterDowngrade,
  looksLikeSentrySearchSyntax,
} from "./utils";

describe("validateSearch tool contract", () => {
  it("does not expose a separate environment argument", () => {
    const tool = createValidateEventsSearchTool({
      apiService: new SentryApiService({ accessToken: "test-token" }),
      organizationSlug: "test-org",
    });

    const schema = tool.inputSchema as z.ZodObject;
    expect(Object.keys(schema.shape)).not.toContain("environment");
  });

  it.each([
    {
      name: "does not add an environment filter when none is requested",
      query: "span.duration:>100",
    },
    {
      name: "preserves environment filters in the candidate query",
      query: "span.duration:>100 environment:production",
    },
    {
      name: "does not forward a hallucinated separate environment argument",
      query: "span.duration:>100",
      environment: ":/",
    },
  ])("$name", async ({ query, environment }) => {
    const requests: URLSearchParams[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/events/validate/",
        ({ request }) => {
          requests.push(new URL(request.url).searchParams);
          return HttpResponse.json({
            valid: true,
            projects: [],
            dataset: [],
            environment: [],
            field: [],
            query: { valid: true, error: null, fields: [] },
            orderby: [],
          });
        },
      ),
    );
    const tool = createValidateEventsSearchTool({
      apiService: new SentryApiService({ accessToken: "test-token" }),
      organizationSlug: "test-org",
    });
    type ToolInput = Parameters<NonNullable<typeof tool.execute>>[0];
    const schema = tool.inputSchema as z.ZodType<ToolInput>;
    const input = schema.parse({
      dataset: "spans",
      query,
      fields: ["span.duration"],
      sort: "-span.duration",
      environment,
    });

    const result = await tool.execute!(input, {
      toolCallId: "validate-search-test",
      messages: [],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.getAll("environment")).toEqual([]);
    expect(requests[0]!.get("query")).toBe(query);
    expect(result).toEqual({
      result: { valid: true, message: "Search validation passed." },
    });
  });
});

describe("formatEventValue", () => {
  describe("primitives", () => {
    it("should return 'null' for null", () => {
      expect(formatEventValue(null)).toBe("null");
    });

    it("should return 'undefined' for undefined", () => {
      expect(formatEventValue(undefined)).toBe("undefined");
    });

    it("should return string values as-is", () => {
      expect(formatEventValue("hello")).toBe("hello");
    });

    it("should stringify numbers", () => {
      expect(formatEventValue(42)).toBe("42");
      expect(formatEventValue(0)).toBe("0");
      expect(formatEventValue(-1.5)).toBe("-1.5");
    });

    it("should stringify booleans", () => {
      expect(formatEventValue(true)).toBe("true");
      expect(formatEventValue(false)).toBe("false");
    });
  });

  describe("strings", () => {
    it("should collapse whitespace", () => {
      expect(formatEventValue("hello   world")).toBe("hello world");
      expect(formatEventValue("  leading")).toBe("leading");
      expect(formatEventValue("trailing  ")).toBe("trailing");
    });

    it("should truncate long strings", () => {
      const long = "a".repeat(300);
      const result = formatEventValue(long);
      expect(result.length).toBe(200);
      expect(result).toMatch(/\.\.\.$/);
    });

    it("should respect custom maxLength", () => {
      const result = formatEventValue("a".repeat(50), { maxLength: 20 });
      expect(result.length).toBe(20);
      expect(result).toMatch(/\.\.\.$/);
    });
  });

  describe("arrays", () => {
    it("should format empty arrays", () => {
      expect(formatEventValue([])).toBe("[]");
    });

    it("should format tag-pair arrays", () => {
      const tags = [
        { key: "os", value: "iOS 17" },
        { key: "device", value: "iPhone15,3" },
      ];
      expect(formatEventValue(tags)).toBe("os=iOS 17, device=iPhone15,3");
    });

    it("should format primitive arrays", () => {
      expect(formatEventValue([1, 2, 3])).toBe("1, 2, 3");
      expect(formatEventValue(["a", "b", "c"])).toBe("a, b, c");
    });

    it("should JSON-serialize mixed arrays", () => {
      const result = formatEventValue([1, "two", { key: "val" }]);
      expect(result).toContain("1");
      expect(result).toContain("two");
      expect(result).not.toContain("[object Object]");
    });
  });

  describe("objects", () => {
    it("should format user objects with identity fields", () => {
      const user = {
        id: "user-123",
        email: "foo@example.com",
        ip_address: "10.0.0.1",
      };
      const result = formatEventValue(user);
      expect(result).toContain("id=user-123");
      expect(result).toContain("email=foo@example.com");
      expect(result).toContain("ip_address=10.0.0.1");
    });

    it("should include geo summaries for known user objects", () => {
      const user = {
        id: "3c7631c0121d40e79e2f992ff5cf7671",
        geo: {
          country_code: "US",
          region: "United States",
        },
      };

      expect(formatKnownUserValue(user, { includeGeo: true })).toContain(
        "geo=US, United States",
      );
    });

    it("should omit geo summaries for known user objects when requested", () => {
      const user = {
        id: "3c7631c0121d40e79e2f992ff5cf7671",
        geo: {
          country_code: "US",
          region: "United States",
        },
      };

      expect(formatKnownUserValue(user, { includeGeo: false })).toBe(
        "id=3c7631c0121d40e79e2f992ff5cf7671",
      );
    });

    it("should omit summary text for geo-only known users", () => {
      const user = {
        geo: {
          country_code: "US",
          region: "United States",
        },
      };

      expect(formatKnownUserValue(user, { includeGeo: false })).toBeNull();
    });

    it("should NOT apply user formatting to objects with only id", () => {
      const obj = { id: "abc", type: "transaction", description: "GET /api" };
      const result = formatEventValue(obj);
      // Should fall through to JSON, preserving all fields
      expect(result).toContain("type");
      expect(result).toContain("transaction");
      expect(result).toContain("description");
    });

    it("should NOT apply user formatting to non-user objects with geo", () => {
      const obj = {
        method: "GET",
        path: "/api/0/issues/",
        geo: {
          country_code: "US",
        },
      };

      const result = formatEventValue(obj);
      expect(result).toContain('"method":"GET"');
      expect(result).toContain('"path":"/api/0/issues/"');
      expect(result).toContain('"country_code":"US"');
    });

    it("should format tag-pair objects", () => {
      const tag = { key: "browser", value: "Chrome 120" };
      expect(formatEventValue(tag)).toBe("browser=Chrome 120");
    });

    it("should JSON-serialize arbitrary objects", () => {
      const obj = { foo: "bar", count: 42 };
      const result = formatEventValue(obj);
      expect(result).toContain("foo");
      expect(result).toContain("bar");
      expect(result).not.toContain("[object Object]");
    });

    it("should handle circular references", () => {
      const obj: Record<string, unknown> = { type: "test" };
      obj.self = obj;
      const result = formatEventValue(obj);
      expect(result).toContain("[Circular]");
      expect(result).not.toContain("[object Object]");
    });
  });

  describe("truncation", () => {
    it("should truncate objects exceeding maxLength", () => {
      const obj = { key: "a".repeat(300) };
      const result = formatEventValue(obj, { maxLength: 50 });
      expect(result.length).toBe(50);
      expect(result).toMatch(/\.\.\.$/);
    });

    it("should handle maxLength <= 3", () => {
      const result = formatEventValue("abcdef", { maxLength: 3 });
      expect(result).toBe("abc");
    });
  });
});

describe("search query helpers", () => {
  it("should detect structured Sentry search syntax", () => {
    expect(looksLikeSentrySearchSyntax("vpn connections from China")).toBe(
      false,
    );
    expect(
      looksLikeSentrySearchSyntax(
        'transaction:"VPN connections" tags[type]:Unified tags[country]:CN',
      ),
    ).toBe(true);
    expect(looksLikeSentrySearchSyntax("span.op:http.client")).toBe(true);
    expect(looksLikeSentrySearchSyntax("http.status_code:500")).toBe(true);
    expect(looksLikeSentrySearchSyntax("customer:acme")).toBe(true);
    expect(looksLikeSentrySearchSyntax('!transaction:"healthcheck"')).toBe(
      true,
    );
  });

  it("should ignore common natural language colon patterns", () => {
    expect(looksLikeSentrySearchSyntax("open http://example.com")).toBe(false);
    expect(looksLikeSentrySearchSyntax("started at 10:30")).toBe(false);
    expect(looksLikeSentrySearchSyntax("Note: show slow spans")).toBe(false);
    expect(looksLikeSentrySearchSyntax("ERROR: service is down")).toBe(false);
  });

  it("detects message full-text downgrades but allows real field renames", () => {
    expect(
      isSemanticFilterDowngrade("conv_id:ZYGC-86ZR", 'message:"*ZYGC-86ZR*"'),
    ).toBe(true);
    expect(
      isSemanticFilterDowngrade(
        "conv_id:ZYGC-86ZR",
        "message:*ZYGC-86ZR* environment:prod",
      ),
    ).toBe(true);

    // Legitimate typo/rename repairs must not be treated as downgrades.
    expect(
      isSemanticFilterDowngrade(
        "spon.duration:>100 span.op:db",
        "span.duration:>100 span.op:db",
      ),
    ).toBe(false);
    expect(
      isSemanticFilterDowngrade(
        "tags[type]:Unified",
        "tags[type]:Unified has:span.status",
      ),
    ).toBe(false);
    expect(isSemanticFilterDowngrade("span.op:db AND", "span.op:db")).toBe(
      false,
    );

    // Natural language input is not a structured-filter downgrade case.
    expect(
      isSemanticFilterDowngrade(
        "errors mentioning ZYGC-86ZR",
        'message:"*ZYGC-86ZR*"',
      ),
    ).toBe(false);

    // message: inside a quoted value is not a full-text filter.
    expect(
      isSemanticFilterDowngrade(
        "custom:hello",
        'transaction:"handle message:hello"',
      ),
    ).toBe(false);

    // Duplicate structured keys must still catch a partial full-text downgrade.
    // Set-based key comparison would miss this because "custom" remains present.
    expect(
      isSemanticFilterDowngrade(
        "custom:foo custom:bar",
        'custom:bar message:"*foo*"',
      ),
    ).toBe(true);
    expect(
      isSemanticFilterDowngrade(
        "custom:foo custom:foo",
        'custom:foo message:"*foo*"',
      ),
    ).toBe(true);

    // Keeping both structured values (or renaming one) is not a downgrade.
    expect(
      isSemanticFilterDowngrade(
        "custom:foo custom:bar",
        "custom:foo custom:bar environment:prod",
      ),
    ).toBe(false);
    expect(
      isSemanticFilterDowngrade(
        "custom:foo custom:bar",
        "tags[custom]:foo custom:bar",
      ),
    ).toBe(false);

    // Quoted multi-word values must keep later words for downgrade detection.
    // Truncating at the first space would miss message rewrites of "world".
    expect(
      isSemanticFilterDowngrade(
        'transaction:"hello world"',
        'message:"*world*"',
      ),
    ).toBe(true);
    expect(
      isSemanticFilterDowngrade(
        "transaction:'hello world'",
        'log.body:"*hello world*"',
      ),
    ).toBe(true);

    // Bare substring matches are not enough — short values must not false-hit
    // inside unrelated full-text (e.g. "1" inside "401").
    expect(isSemanticFilterDowngrade("id:1", 'message:"error 401"')).toBe(
      false,
    );
    expect(isSemanticFilterDowngrade("id:1", 'message:"error 1"')).toBe(true);
  });
});

describe("fetchCustomAttributes", () => {
  let apiService: SentryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logging, "logWarn").mockImplementation(() => {});

    // Create a real SentryApiService instance
    apiService = new SentryApiService({
      accessToken: "test-token",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mswServer.resetHandlers();
  });

  describe("403 permission errors", () => {
    it("should throw 403 'no multi-project access' error as UserInputError", async () => {
      // Mock the API to return a 403 error like in the Sentry issue
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          () => {
            return HttpResponse.json(
              {
                detail:
                  "You do not have access to query across multiple projects. Please select a project for your query.",
              },
              { status: 403 },
            );
          },
        ),
      );

      // Should throw ApiPermissionError with the improved error message
      await expect(
        fetchCustomAttributes(apiService, "test-org", "spans"),
      ).rejects.toThrow(
        "You do not have access to query across multiple projects. Please select a project for your query.",
      );

      // Should NOT log - the caller handles logging
    });

    it("should throw 403 errors for logs dataset", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          () => {
            return HttpResponse.json(
              { detail: "Permission denied" },
              { status: 403 },
            );
          },
        ),
      );

      // Should throw ApiPermissionError with the raw error message
      await expect(
        fetchCustomAttributes(apiService, "test-org", "logs", "project-123"),
      ).rejects.toThrow("Permission denied");
    });

    it("should throw 404 errors for errors dataset", async () => {
      mswServer.use(
        http.get("https://sentry.io/api/0/organizations/test-org/tags/", () => {
          return HttpResponse.json(
            { detail: "Project not found" },
            { status: 404 },
          );
        }),
      );

      // Should throw ApiNotFoundError with the raw error message
      await expect(
        fetchCustomAttributes(apiService, "test-org", "errors", "non-existent"),
      ).rejects.toThrow("Project not found");
    });
  });

  describe("5xx server errors", () => {
    it("should re-throw 500 errors to be captured by Sentry", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          () => {
            return HttpResponse.json(
              { detail: "Internal server error" },
              { status: 500 },
            );
          },
        ),
      );

      // Should re-throw the error with the exact message (not wrapped as UserInputError)
      const error = await fetchCustomAttributes(
        apiService,
        "test-org",
        "spans",
      ).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Internal server error");
    });

    it("should re-throw 502 errors", async () => {
      mswServer.use(
        http.get("https://sentry.io/api/0/organizations/test-org/tags/", () => {
          return HttpResponse.json({ detail: "Bad gateway" }, { status: 502 });
        }),
      );

      const error = await fetchCustomAttributes(
        apiService,
        "test-org",
        "errors",
      ).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Bad gateway");
    });
  });

  describe("network errors", () => {
    it("should re-throw network errors to be captured by Sentry", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          () => {
            // Simulate network error by throwing
            throw new Error("Network error: ETIMEDOUT");
          },
        ),
      );

      await expect(
        fetchCustomAttributes(apiService, "test-org", "spans"),
      ).rejects.toThrow("Network error: ETIMEDOUT");
    });
  });

  describe("successful responses", () => {
    it("should return attributes for spans dataset", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          ({ request }) => {
            const url = new URL(request.url);
            const itemType = url.searchParams.get("itemType");

            if (!itemType) {
              return HttpResponse.json(
                { detail: "Missing required parameters" },
                { status: 400 },
              );
            }

            return HttpResponse.json([
              {
                key: "span.op",
                name: "Operation",
                attributeType: "string",
                attributeSource: { source_type: "sentry" },
              },
              {
                key: "sentry:internal",
                name: "Internal",
                attributeType: "string",
                attributeSource: { source_type: "sentry" },
              },
              {
                key: "span.duration",
                name: "Duration",
                attributeType: "number",
                attributeSource: { source_type: "sentry" },
              },
            ]);
          },
        ),
      );

      const result = await fetchCustomAttributes(
        apiService,
        "test-org",
        "spans",
      );

      expect(result).toEqual({
        attributes: {
          "span.op": "Operation",
          "span.duration": "Duration",
        },
        fieldTypes: {
          "span.op": "string",
          "span.duration": "number",
        },
      });
    });

    it("should return attributes for errors dataset", async () => {
      mswServer.use(
        http.get("https://sentry.io/api/0/organizations/test-org/tags/", () => {
          return HttpResponse.json([
            { key: "browser", name: "Browser", totalValues: 10 },
            { key: "sentry:user", name: "User", totalValues: 5 }, // Should be filtered
            { key: "environment", name: "Environment", totalValues: 3 },
          ]);
        }),
      );

      const result = await fetchCustomAttributes(
        apiService,
        "test-org",
        "errors",
      );

      expect(result).toEqual({
        attributes: {
          browser: "Browser",
          environment: "Environment",
        },
        fieldTypes: {},
      });
    });

    it("should return attributes for metrics dataset", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          ({ request }) => {
            const url = new URL(request.url);
            const itemType = url.searchParams.get("itemType");

            expect(itemType).toBe("tracemetrics");

            return HttpResponse.json([
              {
                key: "metric.name",
                name: "Metric Name",
                attributeType: "string",
                attributeSource: { source_type: "sentry" },
              },
              {
                key: "metric.type",
                name: "Metric Type",
                attributeType: "string",
                attributeSource: { source_type: "sentry" },
              },
              {
                key: "value",
                name: "Metric Value",
                attributeType: "number",
                attributeSource: { source_type: "sentry" },
              },
            ]);
          },
        ),
      );

      const result = await fetchCustomAttributes(
        apiService,
        "test-org",
        "metrics",
      );

      expect(result).toEqual({
        attributes: {
          "metric.name": "Metric Name",
          "metric.type": "Metric Type",
          value: "Metric Value",
        },
        fieldTypes: {
          "metric.name": "string",
          "metric.type": "string",
          value: "number",
        },
      });
    });

    it("should pass targeted trace item attribute filters through to Sentry", async () => {
      const requests: URLSearchParams[] = [];

      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/test-org/trace-items/attributes/",
          ({ request }) => {
            const url = new URL(request.url);
            requests.push(url.searchParams);

            return HttpResponse.json([
              {
                key: "tags[type]",
                name: "type",
                attributeType: "string",
                attributeSource: { source_type: "sentry" },
              },
              {
                key: "tags[sequence,number]",
                name: "sequence",
                attributeType: "number",
                attributeSource: { source_type: "user" },
              },
              {
                key: "tags[enabled,boolean]",
                name: "enabled",
                attributeType: "boolean",
                attributeSource: { source_type: "user" },
              },
            ]);
          },
        ),
      );

      const result = await fetchCustomAttributes(
        apiService,
        "test-org",
        "spans",
        "123",
        { statsPeriod: "7d" },
        {
          attributeTypes: ["string", "number", "boolean"],
          substringMatch: "tags[",
          query: 'transaction:"VPN connections"',
        },
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]!.get("attributeType")).toBeNull();
      for (const params of requests) {
        expect(params.get("itemType")).toBe("spans");
        expect(params.get("project")).toBe("123");
        expect(params.get("statsPeriod")).toBe("7d");
        expect(params.get("substringMatch")).toBe("tags[");
        expect(params.get("query")).toBe('transaction:"VPN connections"');
      }
      expect(result).toEqual({
        attributes: {
          "tags[type]": "type",
          "tags[sequence,number]": "sequence",
          "tags[enabled,boolean]": "enabled",
        },
        fieldTypes: {
          "tags[type]": "string",
          "tags[sequence,number]": "number",
          "tags[enabled,boolean]": "boolean",
        },
      });
    });
  });
});

describe("formatEventsValidationResults", () => {
  it("returns an empty string when there are no validation sections", () => {
    expect(
      formatEventsValidationResults({
        valid: true,
        projects: [],
        dataset: [],
        environment: [],
        field: [],
        query: { valid: true, fields: [] },
        orderby: [],
      }),
    ).toBe("");
  });

  it("formats all validation sections for a mixed result", () => {
    expect(
      formatEventsValidationResults({
        valid: false,
        projects: [{ valid: true }],
        dataset: [
          {
            name: "spans",
            valid: false,
            error: "dataset must be one of: spans, errors",
          },
        ],
        environment: [{ valid: true }],
        field: [
          { name: "span.duration", valid: true, type: "number" },
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
            name: "-spon.duration",
            valid: false,
            error: "Orderby must also be a selected field",
          },
        ],
      }),
    ).toBe(`Validation Result: invalid
Validated Dataset:
- INVALID spans — dataset must be one of: spans, errors

Validated Fields:
- INVALID tags[missing] — Unknown attribute

Validated Query:
- INVALID query — Invalid syntax

Validated Order By:
- INVALID -spon.duration — Orderby must also be a selected field
`);
  });

  it("formats invalid query with invalid query fields", () => {
    expect(
      formatEventsValidationResults({
        valid: false,
        projects: [],
        dataset: [],
        environment: [],
        field: [],
        query: {
          valid: false,
          error: 'quotes are not closed at "VPN connections',
          fields: [
            { name: "hello", valid: false, error: "Unknown attribute" },
            { name: "tags[fake]", valid: false, error: "Unknown attribute" },
          ],
        },
        orderby: [],
      }),
    ).toBe(`Validation Result: invalid
Validated Query:
- INVALID query — quotes are not closed at "VPN connections
  - INVALID hello — Unknown attribute
  - INVALID tags[fake] — Unknown attribute
`);
  });

  it("formats valid query field details when validation passes", () => {
    expect(
      formatEventsValidationResults({
        valid: true,
        projects: [],
        dataset: [],
        environment: [],
        field: [],
        query: {
          valid: true,
          fields: [{ name: "transaction", valid: true, type: "string" }],
        },
        orderby: [],
      }),
    ).toBe(`Validation Result: valid
Validated Query:
- OK query
  - OK transaction — type: string
`);
  });

  it("formats query-only validation failure", () => {
    expect(
      formatEventsValidationResults({
        valid: false,
        projects: [],
        dataset: [],
        environment: [],
        field: [],
        query: {
          valid: false,
          error: "Invalid syntax",
          fields: [],
        },
        orderby: [],
      }),
    ).toBe(`Validation Result: invalid
Validated Query:
- INVALID query — Invalid syntax
`);
  });
});
