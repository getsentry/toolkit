/**
 * Tests for `sentry explore` command.
 *
 * Verifies target resolution (org, org/project, bare slug, auto-detect),
 * API call parameters, output formatting, pagination, and dataset handling.
 */

import { execFileSync } from "node:child_process";
import { buildApplication, run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exploreCommand } from "../../src/commands/explore.js";
import { buildContext } from "../../src/context.js";
import { createSentrySDK } from "../../src/index.js";

vi.mock("../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";

vi.mock("../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as paginationDb from "../../src/lib/db/pagination.js";
import { classifySilenced } from "../../src/lib/error-reporting.js";
import {
  ApiError,
  ContextError,
  isUserError,
  ValidationError,
} from "../../src/lib/errors.js";
import { DEFAULT_REPLAY_EXPLORE_FIELDS } from "../../src/lib/replay-search.js";

vi.mock("../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../src/lib/resolve-target.js";
import { parsePeriod } from "../../src/lib/time-range.js";
import { useTestConfigDir } from "../helpers.js";

// Keep namespace references alive so linting doesn't strip the imports
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
  const stderrChunks: string[] = [];
  return {
    context: {
      stdout: {
        write: vi.fn((s: string) => {
          stdoutChunks.push(s);
        }),
      },
      stderr: {
        write: vi.fn((s: string | Uint8Array) => {
          stderrChunks.push(
            typeof s === "string" ? s : new TextDecoder().decode(s),
          );
          return true;
        }),
      },
      cwd: "/tmp/test-explore",
      commandPrefix: ["sentry", "explore"],
    },
    getStdout: () => stdoutChunks.join(""),
    getStderr: () => stderrChunks.join(""),
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

// Shape from events-timeseries responses, with anonymized values and timestamps.
const MOCK_TIME_SERIES_RESPONSE = {
  meta: {
    dataset: "errors",
    start: 1_735_689_600_000,
    end: 1_735_689_900_000,
  },
  timeSeries: [
    {
      yAxis: "count()",
      meta: { valueType: "integer", valueUnit: null, interval: 60_000 },
      values: [
        { timestamp: 1_735_689_600_000, value: 0, incomplete: false },
        {
          timestamp: 1_735_689_660_000,
          value: 12,
          incomplete: true,
          incompleteReason: "INGESTION_PENDING",
          sampleCount: 6,
          sampleRate: 0.5,
          confidence: "low",
        },
        {
          timestamp: 1_735_689_720_000,
          value: null,
          incomplete: true,
          incompleteReason: "NOT_ELAPSED",
          sampleCount: 0,
          sampleRate: null,
          confidence: null,
        },
      ],
    },
  ],
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
let queryEventsTimeSeriesSpy: ReturnType<typeof spyOn>;
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
  queryEventsTimeSeriesSpy = vi.spyOn(apiClient, "queryEventsTimeSeries");
  queryEventsTimeSeriesSpy.mockResolvedValue(MOCK_TIME_SERIES_RESPONSE);
  queryMetricsMetaSpy = vi.spyOn(apiClient, "queryMetricsMeta");
  queryMetricsMetaSpy.mockResolvedValue(MOCK_METRICS_META);
  listReplaysSpy = vi.spyOn(apiClient, "listReplays");
  listReplaysSpy.mockResolvedValue({
    data: MOCK_REPLAYS_RESPONSE,
    nextCursor: undefined,
  });

  // Default: resolveOrgOptionalTarget returns org-only (auto-detect)
  resolveTargetSpy = vi.spyOn(resolveTarget, "resolveOrgOptionalTarget");
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
  queryEventsTimeSeriesSpy.mockRestore();
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

const TIME_SERIES_FLAGS = {
  ...DEFAULT_FLAGS,
  limit: undefined,
  "time-series": true,
};

async function runExploreArgs(args: string[]) {
  const { context, getStdout, getStderr } = createContext();
  const cliContext = {
    ...buildContext(process).forCommand({ prefix: ["sentry", "explore"] }),
    ...context,
    process: {
      ...process,
      stderr: { ...process.stderr, write: context.stderr.write },
      exitCode: undefined,
    },
  };
  await run(
    buildApplication(exploreCommand, { name: "explore" }),
    args,
    cliContext,
  );
  return { getStdout, getStderr, exitCode: cliContext.process.exitCode };
}

const parseExploreDataset = (
  exploreCommand.parameters.flags!.dataset as {
    parse: (value: string) => string;
  }
).parse;

describe("sentry explore", () => {
  describe("dataset parsing", () => {
    test.each(["transaction", "transactions"])(
      "accepts %s as the legacy transactions view",
      (dataset) => {
        expect(parseExploreDataset(dataset)).toBe(dataset);
      },
    );
  });

  describe("target resolution", () => {
    test("`<org>/` uses org without project filter", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "my-org/");

      expect(resolveTargetSpy).toHaveBeenCalledWith(
        { type: "org-all", org: "my-org" },
        "/tmp/test-explore",
        "explore",
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "my-org",
        expect.objectContaining({ query: undefined }),
      );
    });

    test("`<org>/<project>` adds project:<slug> to query automatically", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org", project: "cli" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "my-org/cli");

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "my-org",
        expect.objectContaining({ query: "project:cli" }),
      );
    });

    test("`<org>/<project>` with --query merges project filter and user query", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "my-org", project: "cli" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, query: "level:error" },
        "my-org/cli",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "my-org",
        expect.objectContaining({ query: "project:cli (level:error)" }),
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
        { type: "project-search", projectSlug: "cli" },
        "/tmp/test-explore",
        "explore",
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: "project:test-project" }),
      );
    });

    test("auto-detects org when no target provided", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS);

      expect(resolveTargetSpy).toHaveBeenCalledWith(
        { type: "auto-detect" },
        "/tmp/test-explore",
        "explore",
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: undefined }),
      );
    });

    test("throws ContextError when resolution fails", async () => {
      resolveTargetSpy.mockRejectedValue(
        new ContextError("Organization", "sentry explore <target>", [
          "SENTRY_ORG environment variable",
          "sentry cli defaults",
        ]),
      );
      const { context } = createContext();

      await expect(func.call(context, DEFAULT_FLAGS)).rejects.toThrow(
        "Organization",
      );
    });
  });

  describe("API call parameters", () => {
    test.each(["errors", "spans", "logs"])(
      "accepts boolean queries through the %s command parser",
      async (dataset) => {
        resolveTargetSpy.mockResolvedValue({
          org: "test-org",
          project: "backend",
        });
        const query =
          "(span.op:http.client OR span.status:internal_error) AND !has:release";
        const context = {
          ...buildContext(process).forCommand({
            prefix: ["sentry", "explore"],
          }),
          ...createContext().context,
          process: { ...process, exitCode: undefined },
        };
        await run(
          buildApplication(exploreCommand, { name: "explore" }),
          [
            "test-org/backend",
            "--dataset",
            dataset,
            "-F",
            "count()",
            "-q",
            query,
            "--environment",
            "production",
            "--json",
          ],
          context,
        );
        expect(context.process.exitCode).toBe(0);
        expect(queryEventsSpy).toHaveBeenCalledWith(
          "test-org",
          expect.objectContaining({
            dataset,
            query: `project:backend environment:production (${query})`,
          }),
        );
      },
    );

    test("scopes both OR branches when transactions already appears in one branch", async () => {
      resolveTargetSpy.mockResolvedValue({
        org: "test-org",
        project: "backend",
      });
      const { context } = createContext();
      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "transactions",
          environment: ["production"],
          query: "is_transaction:true OR span.op:http.client",
        },
        "test-org/backend",
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "spans",
          query:
            "project:backend environment:production is_transaction:true (is_transaction:true OR span.op:http.client)",
        }),
      );
    });

    test("keeps Events syntax repairs without rewriting boolean operators", async () => {
      const { context } = createContext();
      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "spans",
          query: "project:123 OR span.op:[http.client,http.server,]",
        },
        "test-org/",
      );
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          query: "project_id:123 OR span.op:[http.client,http.server]",
        }),
      );
    });

    test.each([
      "count_if(`release:example`,value,request_duration,distribution,none)",
      "equation|count_if(`release:example`,value,request_duration,distribution,none) + count_if(`!release:example`,value,request_duration,distribution,none)",
    ])(
      "passes valid advanced metrics expressions to the backend: %s",
      async (field) => {
        const { context } = createContext();
        await func.call(
          context,
          { ...DEFAULT_FLAGS, dataset: "tracemetrics", field: [field] },
          "test-org/",
        );
        expect(queryEventsSpy).toHaveBeenCalledWith(
          "test-org",
          expect.objectContaining({
            dataset: "tracemetrics",
            fields: [field],
          }),
        );
      },
    );
    test("passes default fields and dataset when none specified", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, DEFAULT_FLAGS, "test-org/");

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["title", "count()"],
          dataset: "errors",
        }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["transaction", "p50(span.duration)"],
        }),
      );
    });

    test("passes custom dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "spans" },
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ dataset: "spans" }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "spans",
          fields: ["transaction", "count()"],
          query: "is_transaction:true (environment:production)",
        }),
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
        "test-org/cli",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "spans",
          query: "project:cli is_transaction:true",
        }),
      );
    });

    test("passes user query unchanged when no project filter", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, query: "is:unresolved" },
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: "is:unresolved" }),
      );
    });

    test("passes limit", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(context, { ...DEFAULT_FLAGS, limit: 100 }, "test-org/");

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ limit: 100 }),
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
        "test-org/cli",
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
        "test-org/cli",
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          projectSlugs: ["cli"],
          query: "count_errors:>0",
        }),
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
        "test-org/",
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["id", "trace_ids"],
        }),
      );
    });
  });

  describe("time series", () => {
    test("parses --time-series and chooses a usable interval for a five-minute window", async () => {
      const result = await runExploreArgs([
        "test-org/",
        "--time-series",
        "--period",
        "5m",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(queryEventsTimeSeriesSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["count()"],
          dataset: "errors",
          statsPeriod: "5m",
          interval: "1m",
        }),
      );
      expect(JSON.parse(result.getStdout())).toEqual({
        ...MOCK_TIME_SERIES_RESPONSE,
        dataset: "errors",
      });
      expect(queryEventsSpy).not.toHaveBeenCalled();
      expect(resolveCursorSpy).not.toHaveBeenCalled();
      expect(advancePaginationStateSpy).not.toHaveBeenCalled();
      expect(hasPreviousPageSpy).not.toHaveBeenCalled();
    });

    test.each([
      { period: "1h", timeParams: { statsPeriod: "1h" } },
      {
        period: "2025-01-01T00:00:00Z..2025-01-01T01:00:00Z",
        timeParams: {
          start: "2025-01-01T00:00:00.000Z",
          end: "2025-01-01T01:00:00.000Z",
        },
      },
    ])(
      "accepts the SDK's string period $period",
      async ({ period, timeParams }) => {
        const sdk = createSentrySDK({ cwd: "/tmp/test-explore" });
        await sdk.explore({
          target: "test-org/",
          timeSeries: true,
          period,
          interval: "15m",
        });

        expect(queryEventsTimeSeriesSpy).toHaveBeenCalledWith("test-org", {
          fields: ["count()"],
          dataset: "errors",
          query: undefined,
          interval: "15m",
          ...timeParams,
        });
      },
    );

    test("keeps legacy transaction filtering in temporal mode", async () => {
      const { context } = createContext();

      await func.call(
        context,
        {
          ...TIME_SERIES_FLAGS,
          dataset: "transactions",
          query: "span.op:http.server",
          field: ["p95(span.duration)"],
        },
        "test-org/",
      );

      expect(queryEventsTimeSeriesSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["p95(span.duration)"],
          dataset: "spans",
          query: "span.op:http.server is_transaction:true",
        }),
      );
    });

    test("resolves --metric with the requested aggregation and time window", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "web" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...TIME_SERIES_FLAGS,
          metric: "cache.hit_rate",
          agg: "avg",
          period: parsePeriod("7d"),
        },
        "test-org/web",
      );

      expect(queryMetricsMetaSpy).toHaveBeenCalledWith("test-org", {
        statsPeriod: "7d",
        project: "web",
      });
      expect(queryEventsTimeSeriesSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["avg(value,cache.hit_rate,distribution,none)"],
          dataset: "tracemetrics",
          query: "project:web",
          statsPeriod: "7d",
        }),
      );
    });

    test("shows the public metrics name while querying raw aggregates without discovery", async () => {
      const aggregate = "sum(value,llm.token_usage,distribution,none)";
      const result = await runExploreArgs([
        "test-org/",
        "--time-series",
        "--dataset",
        "metrics",
        "-F",
        aggregate,
      ]);

      expect(result.exitCode).toBe(0);
      expect(queryEventsTimeSeriesSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: [aggregate],
          dataset: "tracemetrics",
        }),
      );
      expect(queryMetricsMetaSpy).not.toHaveBeenCalled();
      expect(result.getStdout()).toContain("Querying metrics in test-org");
      expect(result.getStdout()).not.toContain("tracemetrics");
      expect(result.getStdout()).not.toContain("Next:");
    });

    test.each([
      {
        name: "interval without temporal mode",
        args: ["--interval", "15m"],
        error: "--interval requires --time-series",
      },
      {
        name: "non-aggregate fields",
        args: ["--time-series", "-F", "project", "-F", "count()"],
        error: "Grouping is not supported: project",
      },
      {
        name: "replays",
        args: ["--time-series", "--dataset", "replays"],
        error: "The replays dataset is only available as a table",
      },
      {
        name: "cursor",
        args: ["--time-series", "--cursor", "next"],
        error: "--cursor is only available for tables",
      },
      {
        name: "sort",
        args: ["--time-series", "--sort", "-count()"],
        error: "--sort is only available for tables",
      },
      {
        name: "explicit limit",
        args: ["--time-series", "--limit", "25"],
        error: "--limit is only available for tables",
      },
      {
        name: "invalid interval",
        args: ["--time-series", "--interval", "bad"],
        error: 'Invalid interval "bad"',
      },
      {
        name: "metrics without an aggregate",
        args: ["--time-series", "--dataset", "metrics"],
        error:
          "The metrics dataset requires --metric or explicit --field flags",
      },
      {
        name: "metric grouping fields",
        args: ["--time-series", "--metric", "llm.token_usage", "-F", "project"],
        error: "Grouping is not supported: project",
      },
    ])("rejects $name before querying the API", async ({ args, error }) => {
      const result = await runExploreArgs(["test-org/", ...args]);

      expect(result.exitCode).not.toBe(0);
      expect(result.getStderr()).toContain(error);
      expect(queryEventsTimeSeriesSpy).not.toHaveBeenCalled();
      expect(queryEventsSpy).not.toHaveBeenCalled();
      expect(queryMetricsMetaSpy).not.toHaveBeenCalled();
      expect(listReplaysSpy).not.toHaveBeenCalled();
    });

    test("keeps the default tabular path and row limit when temporal mode is omitted", async () => {
      const result = await runExploreArgs(["test-org/", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["title", "count()"],
          limit: 25,
        }),
      );
      expect(queryEventsTimeSeriesSpy).not.toHaveBeenCalled();
      expect(JSON.parse(result.getStdout())).toEqual({
        ...MOCK_EVENTS_RESPONSE,
        dataset: "errors",
        hasMore: false,
        hasPrev: false,
      });
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
        expect.objectContaining({ sort: "-count()" }),
      );
    });

    test("applies explicit sort on spans dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "spans", sort: "-count()" },
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-count()", dataset: "spans" }),
      );
    });

    test("applies explicit sort on errors dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "errors",
          field: ["failure.node", "count()"],
          sort: "-count()",
        },
        "test-org/",
      );

      // --sort + --limit must be a real top N, not an arbitrary subset (#1477).
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-count()", dataset: "errors" }),
      );
    });

    test("auto-sorts metrics by their aggregate", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "tracemetrics",
          field: ["sum(value,llm.token_usage,distribution,none)"],
        },
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "tracemetrics",
          sort: "-sum(value,llm.token_usage,distribution,none)",
        }),
      );
    });

    test("applies explicit sort on logs dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "logs",
          field: ["severity", "count()"],
          sort: "-count()",
        },
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "logs",
          fields: ["severity", "count()"],
          sort: "-count()",
        }),
      );
    });

    test("selects an aggregate sort column the user did not request", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        {
          ...DEFAULT_FLAGS,
          dataset: "errors",
          field: ["failure.node", "count()"],
          sort: "-count_unique(user)",
        },
        "test-org/",
      );

      // Sentry 400s when the sort column is not selected, on every dataset.
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["failure.node", "count()", "count_unique(user)"],
          sort: "-count_unique(user)",
        }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-count()", dataset: "errors" }),
      );
    });

    test("defaults replay dataset sort to -started_at", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "replays" },
        "test-org/",
      );

      expect(listReplaysSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ sort: "-started_at" }),
      );
    });

    test("requests canonical replay API fields for default replay columns", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "replays" },
        "test-org/",
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
        }),
      );
    });
  });

  describe("backend expression recovery", () => {
    test.each(["spans", "transaction", "transactions"])(
      "explains how to count %s without retrying or hiding the failure",
      async (dataset) => {
        resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "web" });
        const detail =
          "span is invalid for parameter 1 in count. Its a string type field, but it must be one of these types: {'number', 'duration'}";
        queryEventsSpy.mockRejectedValue(
          new ApiError("Bad request", 400, detail),
        );
        const { context, getStdout } = createContext();

        const error = await func
          .call(
            context,
            {
              ...DEFAULT_FLAGS,
              dataset,
              field: ["span.op", "count(span)"],
              sort: "-count(span)",
            },
            "test-org/web",
          )
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ field: "field" });
        expect((error as Error).message).toContain(detail);
        expect((error as Error).message).toContain('--field "count(span)"');
        expect((error as Error).message).toContain('dataset "spans"');
        expect((error as Error).message).toContain(
          "Use count() to count spans",
        );
        expect(isUserError(error)).toBe(true);
        expect(classifySilenced(error)).toBeNull();
        expect(queryEventsSpy).toHaveBeenCalledTimes(1);
        expect(queryEventsSpy).toHaveBeenCalledWith(
          "test-org",
          expect.objectContaining({
            dataset: "spans",
            fields: ["span.op", "count(span)"],
            sort: "-count(span)",
          }),
        );
        expect(advancePaginationStateSpy).not.toHaveBeenCalled();
        expect(getStdout()).toBe("");
      },
    );

    test.each(["min", "max"])(
      "preserves earliest/latest intent and units for logs %s(timestamp)",
      async (aggregate) => {
        resolveTargetSpy.mockResolvedValue({ org: "test-org" });
        const detail = `timestamp is invalid for parameter 1 in ${aggregate}. Its a string type field, but it must be one of these types: {'number'}`;
        queryEventsSpy.mockRejectedValue(
          new ApiError("Bad request", 400, detail),
        );
        const { context } = createContext();

        const error = await func
          .call(
            context,
            {
              ...DEFAULT_FLAGS,
              dataset: "logs",
              field: ["severity", `${aggregate}(timestamp)`],
            },
            "test-org/",
          )
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ValidationError);
        expect((error as Error).message).toContain(detail);
        expect((error as Error).message).toContain(
          `${aggregate}(timestamp_precise)`,
        );
        expect((error as Error).message).toContain(
          "Unix timestamps in nanoseconds",
        );
      },
    );

    test("identifies an unsupported function supplied only through --sort", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockRejectedValue(
        new ApiError("Bad request", 400, "Unknown function p10"),
      );
      const { context } = createContext();

      const error = await func
        .call(
          context,
          {
            ...DEFAULT_FLAGS,
            dataset: "spans",
            field: ["span.op", "count()"],
            sort: "-p10(span.duration)",
          },
          "test-org/",
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ field: "sort" });
      expect((error as Error).message).toContain(
        '--sort "-p10(span.duration)"',
      );
      expect((error as Error).message).toContain("Unknown function p10");
      expect((error as Error).message).toContain("sentry explore --help");
      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["span.op", "count()", "p10(span.duration)"],
          sort: "-p10(span.duration)",
        }),
      );
    });

    test("identifies an unsupported function supplied through --field", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      queryEventsSpy.mockRejectedValue(
        new ApiError("Bad request", 400, "Unknown function p10"),
      );
      const { context } = createContext();

      const error = await func
        .call(
          context,
          { ...DEFAULT_FLAGS, dataset: "logs", field: ["p10(duration)"] },
          "test-org/",
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain('--field "p10(duration)"');
      expect((error as Error).message).toContain('dataset "logs"');
      expect((error as Error).message).not.toContain("attribute list");
    });

    test.each([
      ["default fields", {}, "Unknown function count"],
      [
        "default fields with a user query",
        { query: "level:error" },
        "Unknown function count",
      ],
      [
        "an unrelated user field",
        { field: ["title"] },
        "Unknown function count",
      ],
      [
        "a query expression",
        { query: "p10(duration):>0" },
        "Unknown function p10",
      ],
      [
        "a spans backend without timestamp aggregates",
        { dataset: "spans", field: ["min(timestamp)"] },
        "timestamp is invalid for parameter 1 in min. Its a string type field",
      ],
      [
        "an unknown rejection",
        { field: ["count()"] },
        "Invalid dataset configuration",
      ],
      [
        "a generated metric expression",
        {
          dataset: "tracemetrics",
          metric: "llm.token_usage",
          field: ["sum(value,llm.token_usage,distribution,none)"],
        },
        "Unknown function sum",
      ],
    ])("preserves the API error for %s", async (_label, flags, detail) => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const original = new ApiError("Bad request", 400, detail);
      queryEventsSpy.mockRejectedValue(original);
      const { context } = createContext();

      await expect(
        func.call(context, { ...DEFAULT_FLAGS, ...flags }, "test-org/"),
      ).rejects.toBe(original);
      expect(isUserError(original)).toBe(false);
      expect(classifySilenced(original)).toBeNull();
    });

    test("preserves non-400 errors even when their detail mentions a user field", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const original = new ApiError(
        "Server failure",
        500,
        "Unknown function p10",
      );
      queryEventsSpy.mockRejectedValue(original);
      const { context } = createContext();

      await expect(
        func.call(
          context,
          { ...DEFAULT_FLAGS, dataset: "spans", field: ["p10(span.duration)"] },
          "test-org/",
        ),
      ).rejects.toBe(original);
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
        "test-org/",
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ dataset: "tracemetrics" }),
      );
    });

    test("requires --metric or --field for metrics dataset", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      const promise = func.call(
        context,
        { ...DEFAULT_FLAGS, dataset: "tracemetrics" },
        "test-org/",
      );

      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        /requires --metric or explicit --field/,
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
        "test-org/",
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
        "test-org/",
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
        }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: [
            "gen_ai.request.model",
            "sum(value,llm.token_usage,distribution,none)",
          ],
        }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          fields: ["avg(value,cache.hit_rate,distribution,none)"],
        }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          dataset: "tracemetrics",
          fields: ["sum(value,llm.token_usage,distribution,none)"],
        }),
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
        "test-org/",
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
        "test-org/",
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
    test.runIf(process.platform !== "win32").each([
      {
        dataset: "errors",
        query: 'transaction:"GET /checkout"',
        field: ["title", "count()"],
      },
      {
        dataset: "tracemetrics",
        query: "release:example",
        field: [
          "count_if(`release:example`,value,request_duration,distribution,none)",
        ],
      },
    ])(
      "a copied next-page hint preserves the query and fields for $dataset",
      async ({ dataset, query, field }) => {
        const actual = await vi.importActual<
          typeof import("../../src/lib/db/pagination.js")
        >("../../src/lib/db/pagination.js");
        resolveCursorSpy.mockImplementation(actual.resolveCursor);
        advancePaginationStateSpy.mockImplementation(
          actual.advancePaginationState,
        );
        hasPreviousPageSpy.mockImplementation(actual.hasPreviousPage);
        queryEventsSpy.mockResolvedValue({
          data: MOCK_EVENTS_RESPONSE,
          nextCursor: "page-2",
        });
        const { context, getStdout } = createContext();

        await func.call(
          context,
          { ...DEFAULT_FLAGS, dataset, query, field },
          "test-org/",
        );

        const hint = getStdout().match(/Next: (sentry explore[^\n]+)/)?.[1];
        expect(hint).toBeDefined();
        const args = execFileSync(
          "/bin/sh",
          ["-c", `sentry() { printf '%s\\0' "$@"; }\n${hint}`],
          { encoding: "utf8" },
        )
          .split("\0")
          .slice(0, -1);
        const resumedContext = {
          ...buildContext(process).forCommand({
            prefix: ["sentry", "explore"],
          }),
          ...createContext().context,
          process: { ...process, exitCode: undefined },
        };
        await run(
          buildApplication(exploreCommand, { name: "explore" }),
          args.slice(1),
          resumedContext,
        );
        expect(resumedContext.process.exitCode).toBe(0);

        expect(queryEventsSpy).toHaveBeenLastCalledWith(
          "test-org",
          expect.objectContaining({ query, fields: field, cursor: "page-2" }),
        );
      },
    );

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
        "cursor123",
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
        "test-org/",
      );

      expect(getStdout()).toContain(
        "sentry explore test-org/ -c next --dataset transactions",
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
        "test-org/",
      );

      const output = getStdout();
      expect(output).toContain(
        "sentry explore test-org/ -c next --dataset replays",
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({ query: "environment:production" }),
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
        "test-org/",
      );

      expect(queryEventsSpy).toHaveBeenCalledWith(
        "test-org",
        expect.objectContaining({
          query: "environment:[production,canary]",
        }),
      );
    });

    test("rejects fields missing from the replay schema", async () => {
      resolveTargetSpy.mockResolvedValue({ org: "test-org" });
      const { context } = createContext();

      await expect(
        func.call(
          context,
          { ...DEFAULT_FLAGS, dataset: "replays", field: ["device.model_id"] },
          "test-org/",
        ),
      ).rejects.toThrow(ValidationError);
    });
  });
});
