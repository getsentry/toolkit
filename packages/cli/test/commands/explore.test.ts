/**
 * Tests for `sentry explore` command.
 *
 * Verifies target resolution (org, org/project, bare slug, auto-detect),
 * API call parameters, output formatting, pagination, and dataset handling.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exploreCommand } from "../../src/commands/explore.js";

vi.mock("../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";

vi.mock("../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as paginationDb from "../../src/lib/db/pagination.js";
import { ContextError, ValidationError } from "../../src/lib/errors.js";
import { DEFAULT_REPLAY_EXPLORE_FIELDS } from "../../src/lib/replay-search.js";

vi.mock("../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../src/lib/resolve-target.js";
import { parsePeriod } from "../../src/lib/time-range.js";
import { useTestConfigDir } from "../helpers.js";

// Keep namespace references alive so biome doesn't strip the imports
const _apiRef = apiClient;
const _paginationRef = paginationDb;
const _resolveRef = resolveTarget;

useTestConfigDir("explore-test-");

type ExploreFunc = (
  this: unknown,
  flags: Record<string, unknown>,
  ...args: unknown[]
) => Promise<void>;

let func: ExploreFunc;

function createContext() {
  const stdoutChunks: string[] = [];
  return {
    context: {
      stdout: {
        write: vi.fn((s: string) => {
          stdoutChunks.push(s);
        }),
      },
      stderr: {
        write: vi.fn((_s: string) => {
          /* no-op */
        }),
      },
      cwd: "/tmp/test-explore",
    },
    getStdout: () => stdoutChunks.join(""),
  };
}

const MOCK_EVENTS_RESPONSE = {
  data: [
    { title: "TypeError: Cannot read property 'foo'", "count()": 1234 },
    { title: "ReferenceError: bar is not defined", "count()": 567 },
  ],
  meta: {
    fields: { title: "string", "count()": "integer" },
    units: {},
  },
};

const MOCK_REPLAYS_RESPONSE = [
  {
    id: "346789a703f6454384f1de473b8b9fcc",
    count_dead_clicks: 1,
    count_errors: 2,
    count_rage_clicks: 3,
    duration: 125,
    error_ids: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    info_ids: [],
    started_at: "2025-01-30T14:32:15+00:00",
    tags: {},
    trace_ids: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    urls: ["/checkout"],
    user: { email: "user@example.com" },
    warning_ids: [],
  },
];

let queryEventsSpy: ReturnType<typeof spyOn>;
let queryMetricsMetaSpy: ReturnType<typeof spyOn>;
let listReplaysSpy: ReturnType<typeof spyOn>;
let resolveTargetSpy: ReturnType<typeof spyOn>;
let resolveCursorSpy: ReturnType<typeof spyOn>;
let advancePaginationStateSpy: ReturnType<typeof spyOn>;
let hasPreviousPageSpy: ReturnType<typeof spyOn>;

const MOCK_METRICS_META = [
  { name: "llm.token_usage", type: "distribution", unit: "none" },
  { name: "cache.hit_rate", type: "distribution", unit: "none" },
];

beforeEach(async () => {
  func = (await exploreCommand.loader()) as unknown as ExploreFunc;

  queryEventsSpy = vi.spyOn(apiClient, "queryEvents");
  queryEventsSpy.mockResolvedValue({
    data: MOCK_EVENTS_RESPONSE,
    nextCursor: undefined,
  });
  queryMetricsMetaSpy = vi.spyOn(apiClient, "queryMetricsMeta");
  queryMetricsMetaSpy.mockResolvedValue(MOCK_METRICS_META);
  listReplaysSpy = vi.spyOn(apiClient, "listReplays");
  listReplaysSpy.mockResolvedValue({
    data: MOCK_REPLAYS_RESPONSE,
    nextCursor: undefined,
  });

  // Default: resolveOrgOptionalFromArg returns org-only (auto-detect)
  resolveTargetSpy = vi.spyOn(resolveTarget, "resolveOrgOptionalFromArg");
  resolveTargetSpy.mockResolvedValue({ org: "test-org" });

  resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
    cursor: undefined,
    direction: "next" as const,
  });
  advancePaginationStateSpy = vi
    .spyOn(paginationDb, "advancePaginationState")
    .mockReturnValue(undefined);
  hasPreviousPageSpy = vi
    .spyOn(paginationDb, "hasPreviousPage")
    .mockReturnValue(false);
});

afterEach(() => {
  queryEventsSpy.mockRestore();
  queryMetricsMetaSpy.mockRestore();
  listReplaysSpy.mockRestore();
  resolveTargetSpy.mockRestore();
  resolveCursorSpy.mockRestore();
  advancePaginationStateSpy.mockRestore();
  hasPreviousPageSpy.mockRestore();
});

const DEFAULT_FLAGS = {
  limit: 25,
  agg: "sum",
  dataset: "errors",
  period: parsePeriod("24h"),
  json: false,
  fresh: false,
};

const parseExploreDataset = (
  exploreCommand.parameters.flags!.dataset as {
    parse: (value: string) => string;
  }
).parse;

describe("sentry explore", () => {
  describe("dataset parsing", () => {
    test.each([
      "transaction",
      "transactions",
    ])("accepts %s as the legacy transactions view", (dataset) => {
      expect(parseExploreDataset(dataset)).toBe(dataset);
    });
  });

  describe("target resolution", () => {
    test("`<org>/` uses org without project filter", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "my-org/");

      expect(resolveTargetSpy).toHaveBeenCalledWith(
        "my-org/",
        "/tmp/test-explore",
        "explore"
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "my-org",
        expect.objectContaining({ query: undefined })
      );
    });

    test("`<org>/<project>` adds project:<slug> to query automatically", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org", project: "cli" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "my-org/cli");

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "my-org",
        expect.objectContaining({ query: "project:cli" })
      );
    });

    test("`<org>/<project>` with --query merges project filter and user query", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org", project: "cli" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, query: "level:error" },
        "my-org/cli"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "my-org",
        expect.objectContaining({ query: "project:cli level:error" })
      );
    });

    test("bare slug resolves project across orgs and adds project filter", async () => {
      resolveTargetSpy.mockResolvedValue({
        org: "test-org",
        project: "test-project",
      });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "cli");

      expect(resolveTargetSpy).toHaveBeenCalledWith(
        "cli",
        "/tmp/test-explore",
        "explore"
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: "project:test-project" })
      );
    });

    test("auto-detects org when no target provided", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS);

      expect(resolveTargetSpy).toHaveBeenCalledWith(
        undefined,
        "/tmp/test-explore",
        "explore"
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: undefined })
      );
    });

    test("throws ContextError when resolution fails", async () => {
      resolveTargetSpy.mockRejectedValue(
        new ContextError("Organization", "sentry explore <target>", [
          "SENTRY_ORG environment variable",
          "sentry cli defaults",
        ])
      );
      const { context } = createContext();

      await expect(func.call(context, DEFAULT_FLAGS)).rejects.toThrow(
        "Organization"
      );
    });
  });

  describe("API call parameters", () => {
    test("passes default fields and dataset when none specified", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "test-org/");

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["title", "count()"],
          dataset: "errors",
        })
      );
    });

    test("passes custom fields from --field flag", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          field: ["transaction", "p50(span.duration)"],
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["transaction", "p50(span.duration)"],
        })
      );
    });

    test("passes custom dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "spans" },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ dataset: "spans" })
      );
    });

    test("routes transactions through spans with an automatic filter", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "transactions",
          query: "environment:production",
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "spans",
          fields: ["transaction", "count()"],
          query: "environment:production is_transaction:true",
        })
      );
    });

    test("does not duplicate an explicit transaction filter", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "transactions",
          query: "is_transaction:true",
        },
        "test-org/cli"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "spans",
          query: "project:cli is_transaction:true",
        })
      );
    });

    test("passes user query unchanged when no project filter", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, query: "is:unresolved" },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: "is:unresolved" })
      );
    });

    test("passes limit", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, { ...DEFAULT_FLAGS, limit: 100 }, "test-org/");

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ limit: 100 })
      );
    });

    test("routes replay dataset queries through the replay index API", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "replays",
          environment: ["production,canary"],
          field: ["id", "user.email", "count_errors", "url"],
          sort: "-count_errors",
        },
        "test-org/cli"
      );

      expect(listReplaysSpy).toHaveBeenCalledWith("test-org", {
        cursor: undefined,
        environment: ["production", "canary"],
        fields: ["id", "user", "count_errors", "urls"],
        limit: 25,
        projectSlugs: ["cli"],
        query: undefined,
        sort: "-count_errors",
        statsPeriod: "24h",
      });
      expect(queryEventsSpy).not.toHaveBeenCalled();
    });

    test("passes replay query text without project: prefix (uses projectSlugs instead)", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "replays",
          query: "count_errors:>0",
        },
        "test-org/cli"
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          projectSlugs: ["cli"],
          query: "count_errors:>0",
        })
      );
    });

    test("requests trace_ids when replay fields derive count_traces", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "replays",
          field: ["id", "count_traces"],
        },
        "test-org/"
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["id", "trace_ids"],
        })
      );
    });
  });

  describe("sort handling", () => {
    test("auto-sorts errors by first aggregate descending", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "test-org/");

      // Default fields are ["title", "count()"]; the errors dataset accepts
      // sort and needs a stable order for correct cursor pagination (#1519).
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-count()" })
      );
    });

    test("applies explicit sort on spans dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "spans", sort: "-count()" },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-count()", dataset: "spans" })
      );
    });

    test("omits sort for metrics dataset even when auto-detected", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          field: ["sum(value,llm.token_usage,distribution,none)"],
        },
        "test-org/"
      );

      // metrics/logs reject sort with 400, so it stays unset.
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: undefined })
      );
    });

    test("applies auto-derived sort on errors for grouped aggregates", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "errors",
          field: ["task.name", "failure.node", "count()"],
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-count()", dataset: "errors" })
      );
    });

    test("defaults replay dataset sort to -started_at", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "replays" },
        "test-org/"
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-started_at" })
      );
    });

    test("requests canonical replay API fields for default replay columns", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "replays" },
        "test-org/"
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: [
            "id",
            "started_at",
            "duration",
            "count_errors",
            "count_rage_clicks",
            "count_dead_clicks",
            "urls",
            "user",
          ],
        })
      );
    });
  });

  describe("metrics dataset validation", () => {
    test("rejects standard aggregates on metrics dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      const promise = func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          field: ["title", "count()"],
        },
        "test-org/"
      );

      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(/Invalid metrics aggregate/);
    });

    test("accepts valid tracemetrics aggregate format", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          field: [
            "gen_ai.request.model",
            "sum(value,llm.token_usage,distribution,none)",
          ],
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ dataset: "tracemetrics" })
      );
    });

    test("requires --metric or --field for metrics dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      const promise = func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "tracemetrics" },
        "test-org/"
      );

      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        /requires --metric or explicit --field/
      );
    });

    test("allows non-aggregate fields without tracemetrics format", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          field: ["gen_ai.request.model"],
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalled();
    });

    test("--metric auto-resolves metric type and unit", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          metric: "llm.token_usage",
        },
        "test-org/"
      );

      expect(queryMetricsMetaSpy).toHaveBeenCalledWith("test-org", {
        statsPeriod: "24h",
        project: undefined,
      });
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["sum(value,llm.token_usage,distribution,none)"],
          dataset: "tracemetrics",
        })
      );
    });

    test("--metric with -F preserves grouping fields", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          metric: "llm.token_usage",
          field: ["gen_ai.request.model"],
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: [
            "gen_ai.request.model",
            "sum(value,llm.token_usage,distribution,none)",
          ],
        })
      );
    });

    test("--metric with --agg uses specified aggregation", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          metric: "cache.hit_rate",
          agg: "avg",
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["avg(value,cache.hit_rate,distribution,none)"],
        })
      );
    });

    test("--metric without --dataset metrics auto-switches to tracemetrics", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "errors",
          metric: "llm.token_usage",
        },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "tracemetrics",
          fields: ["sum(value,llm.token_usage,distribution,none)"],
        })
      );
    });
  });

  describe("output", () => {
    test("renders human-readable table with results", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context, getStdout } = createContext();

      await func.call(context, DEFAULT_FLAGS, "test-org/");

      const output = getStdout();
      expect(output).toContain("errors");
      expect(output).toContain("test-org");
    });

    test("includes project in human header when target is org/project", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org", project: "cli" });
      const { context, getStdout } = createContext();

      await func.call(context, DEFAULT_FLAGS, "my-org/cli");

      expect(getStdout()).toContain("my-org/cli");
    });

    test("preserves user --field order in table columns", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      // API returns fields in a different order than requested
      queryEventsSpy.mockResolvedValue({
        data: {
          data: [{ title: "Error A", "count_unique(user)": 5, "count()": 100 }],
          meta: {
            // Note: API returns in alphabetical-ish order, NOT request order
            fields: {
              "count_unique(user)": "integer",
              "count()": "integer",
              title: "string",
            },
          },
        },
        nextCursor: undefined,
      });
      const { context, getStdout } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          field: ["title", "count()", "count_unique(user)"],
        },
        "test-org/"
      );

      const output = getStdout();
      const titleIdx = output.indexOf("TITLE");
      const countIdx = output.indexOf("COUNT()");
      const uniqueIdx = output.indexOf("COUNT_UNIQUE(USER)");

      // All three columns must appear
      expect(titleIdx).toBeGreaterThan(-1);
      expect(countIdx).toBeGreaterThan(-1);
      expect(uniqueIdx).toBeGreaterThan(-1);

      // Order must match user input: TITLE < COUNT() < COUNT_UNIQUE(USER)
      expect(titleIdx).toBeLessThan(countIdx);
      expect(countIdx).toBeLessThan(uniqueIdx);
    });

    test("renders JSON output with envelope", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context, getStdout } = createContext();

      await func.call(context, { ...DEFAULT_FLAGS, json: true }, "test-org/");

      const parsed = JSON.parse(getStdout());
      expect(parsed.data).toBeArray();
      expect(parsed.dataset).toBe("errors");
      expect(parsed.hasMore).toBe(false);
      expect(parsed.hasPrev).toBe(false);
      expect(parsed.meta).toBeDefined();
    });

    test("renders replay dataset JSON output with flattened replay rows", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context, getStdout } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "replays",
          field: ["id", "user.email", "count_errors", "url"],
          json: true,
        },
        "test-org/"
      );

      const parsed = JSON.parse(getStdout());
      expect(parsed.dataset).toBe("replays");
      expect(parsed.data[0]).toEqual({
        id: "346789a703f6454384f1de473b8b9fcc",
        "user.email": "user@example.com",
        count_errors: 2,
        url: "/checkout",
      });
    });

    test("shows empty message when no results", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockResolvedValue({
        data: { data: [], meta: { fields: {} } },
        nextCursor: undefined,
      });
      const { context, getStdout } = createContext();

      await func.call(context, DEFAULT_FLAGS, "test-org/");

      expect(getStdout()).toContain("No results matched the query.");
    });
  });

  describe("pagination", () => {
    test("includes nextCursor in JSON when more results available", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockResolvedValue({
        data: MOCK_EVENTS_RESPONSE,
        nextCursor: "1735689600:0:1",
      });
      const { context, getStdout } = createContext();

      await func.call(context, { ...DEFAULT_FLAGS, json: true }, "test-org/");

      const parsed = JSON.parse(getStdout());
      expect(parsed.hasMore).toBe(true);
      expect(parsed.nextCursor).toBe("1735689600:0:1");
    });

    test("advances pagination state after query", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockResolvedValue({
        data: MOCK_EVENTS_RESPONSE,
        nextCursor: "cursor123",
      });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "test-org/");

      expect(advancePaginationStateSpy).toHaveBeenCalledWith(
        "explore",
        expect.any(String),
        "next",
        "cursor123"
      );
    });

    test("preserves transactions in pagination hints", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockResolvedValue({
        data: MOCK_EVENTS_RESPONSE,
        nextCursor: "cursor123",
      });
      const { context, getStdout } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "transactions" },
        "test-org/"
      );

      expect(getStdout()).toContain(
        "sentry explore test-org/ -c next --dataset transactions"
      );
    });

    test("omits replay default fields from pagination hints", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      listReplaysSpy.mockResolvedValue({
        data: MOCK_REPLAYS_RESPONSE,
        nextCursor: "cursor123",
      });
      const { context, getStdout } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "replays",
          field: [...DEFAULT_REPLAY_EXPLORE_FIELDS],
        },
        "test-org/"
      );

      const output = getStdout();
      expect(output).toContain(
        "sentry explore test-org/ -c next --dataset replays"
      );
      expect(output).not.toContain('-F "id"');
      expect(output).not.toContain('-F "started_at"');
      expect(output).not.toContain('--sort "-started_at"');
    });
  });

  describe("validation", () => {
    test("translates --environment into query filter terms on non-replay datasets", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockResolvedValue({
        data: MOCK_EVENTS_RESPONSE,
        nextCursor: undefined,
      });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, environment: ["production"] },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: "environment:production" })
      );
    });

    test("translates multiple --environment values into environment:[...] syntax", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockResolvedValue({
        data: MOCK_EVENTS_RESPONSE,
        nextCursor: undefined,
      });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, environment: ["production", "canary"] },
        "test-org/"
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          query: "environment:[production,canary]",
        })
      );
    });

    test("rejects replay detail-only fields on the replay dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await expect(
        func.call(
          context,
          { ...DEFAULT_FLAGS, dataset: "replays", field: ["replay_type"] },
          "test-org/"
        )
      ).rejects.toThrow(ValidationError);
    });
  });
});
