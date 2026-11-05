/**
 * Tests for monitor list schedule formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  formatSchedule,
  listCommand,
} from "../../../../src/commands/monitor/cron/list.js";
import type { SentryMonitor } from "../../../../src/types/index.js";
import { DEFAULT_SENTRY_URL } from "../../../../src/lib/constants.js";
import { setAuthToken } from "../../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../../helpers.js";

const configDir = useTestConfigDir("monitor-cron-list-");
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

function monitor(config: SentryMonitor["config"]): SentryMonitor {
  return {
    id: "1",
    slug: "m",
    name: "Monitor",
    status: "active",
    config,
  };
}

describe("formatSchedule", () => {
  test("returns an empty string when no schedule is configured", () => {
    expect(formatSchedule(monitor(undefined))).toBe("");
    expect(formatSchedule(monitor({}))).toBe("");
  });

  test("renders a crontab schedule verbatim", () => {
    expect(formatSchedule(monitor({ schedule: "0 * * * *" }))).toBe(
      "0 * * * *",
    );
  });

  test("renders a well-formed interval schedule", () => {
    expect(formatSchedule(monitor({ schedule: [1, "hour"] }))).toBe(
      "every 1 hour",
    );
  });

  test("falls back to the first element for a single-element interval", () => {
    expect(formatSchedule(monitor({ schedule: [5] }))).toBe("5");
  });

  test("returns an empty string for an empty interval array", () => {
    expect(formatSchedule(monitor({ schedule: [] }))).toBe("");
  });
});

test("monitor cron list retains the cron endpoint and JSON response", async () => {
  const cron = monitor({ schedule: "0 * * * *" });
  globalThis.fetch = mockFetch(async (input, init) => {
    const url = new URL(new Request(input!, init).url);
    expect(url.pathname).toBe("/api/0/organizations/test-org/monitors/");
    return Response.json([cron]);
  });
  const chunks: string[] = [];
  const context = {
    cwd: configDir(),
    commandPrefix: ["sentry", "monitor", "cron", "list"],
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
    { json: true, limit: 10, fresh: false },
    "test-org/",
  );
  expect(JSON.parse(chunks.join(""))).toMatchObject({
    data: [{ ...cron, orgSlug: "test-org" }],
  });
});
