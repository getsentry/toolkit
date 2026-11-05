import { afterEach, beforeEach, expect, test } from "vitest";
import { listCommand } from "../../../src/commands/monitor/list.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { metricMonitor } from "../../fixtures/metric-monitors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const configDir = useTestConfigDir("monitor-all-types-", {
  isolateProjectRoot: true,
});
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

test("cross-type listing retains metric, cron, uptime and other monitors across native pages", async () => {
  const metric = metricMonitor();
  const cron = metricMonitor({
    id: "10",
    name: "Nightly import",
    type: "monitor_check_in_failure",
    config: {},
    conditionGroup: null,
    dataSources: [],
  });
  const uptime = metricMonitor({
    id: "11",
    name: "Public API",
    type: "uptime_domain_failure",
    config: {},
    conditionGroup: null,
    dataSources: [],
  });
  const other = metricMonitor({
    id: "12",
    name: "Slow queries",
    type: "performance_slow_db_query",
    config: {},
    conditionGroup: null,
    dataSources: [],
  });
  const cursors: (string | null)[] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    const url = new URL(new Request(input!, init).url);
    expect(url.pathname).toBe("/api/0/organizations/test-org/detectors/");
    expect(url.searchParams.get("query")).toBe("!type:issue_stream");
    expect(url.searchParams.getAll("project")).toEqual(["-1"]);
    cursors.push(url.searchParams.get("cursor"));
    return cursors.length === 1
      ? Response.json([metric, cron], {
          headers: {
            Link: '<https://sentry.io/api/0/organizations/test-org/detectors/?cursor=page-two>; rel="next"; results="true"; cursor="page-two"',
          },
        })
      : Response.json([uptime, other]);
  });
  const chunks: string[] = [];
  const context = {
    cwd: configDir(),
    commandPrefix: ["sentry", "monitor", "list"],
    stdout: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
    stderr: { write: () => true },
  };
  const func = (await listCommand.loader()) as unknown as (
    this: typeof context,
    flags: Record<string, unknown>,
    target: string,
  ) => Promise<void>;
  await func.call(
    context,
    { json: true, limit: 4, fresh: false, web: false },
    "test-org/",
  );
  const result = JSON.parse(chunks.join("")) as {
    data: { id: string; type: string }[];
  };
  expect(result.data.map(({ id, type }) => ({ id, type }))).toEqual([
    { id: "9", type: "metric_issue" },
    { id: "10", type: "monitor_check_in_failure" },
    { id: "11", type: "uptime_domain_failure" },
    { id: "12", type: "performance_slow_db_query" },
  ]);
  expect(cursors).toEqual([null, "page-two"]);
});
