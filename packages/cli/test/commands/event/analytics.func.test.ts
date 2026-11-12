import type { ListOrganizationEventsDroppedResponse } from "@sentry/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { analyticsCommand } from "../../../src/commands/event/analytics.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { parsePeriod } from "../../../src/lib/time-range.js";

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

function boundTarget(org: string, project: string) {
  return { resolved: Promise.resolve({ org, project }) };
}

function response(
  overrides: Partial<ListOrganizationEventsDroppedResponse> = {},
): ListOrganizationEventsDroppedResponse {
  return {
    meta: {
      dataset: "errors",
      start: 0,
      end: 10,
      interval: 1,
      suppressedDrops: [],
    },
    droppedEvents: [],
    acceptedEvents: [],
    ...overrides,
  };
}

let getDroppedEventsSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(resolveTarget, "fetchProjectId").mockResolvedValue(42);
  getDroppedEventsSpy = vi.spyOn(apiClient, "getDroppedEvents");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("event analytics", () => {
  test("sends the resolved numeric project id and API dataset", async () => {
    getDroppedEventsSpy.mockResolvedValue(response());

    const { context } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      { dataset: "tracemetrics", period: parsePeriod("24h"), json: true },
      boundTarget("my-org", "my-proj"),
    );

    expect(getDroppedEventsSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({
        dataset: "tracemetrics",
        projectId: "42",
        statsPeriod: "24h",
      }),
    );
  });

  test("renders a no-dropped-events hint when empty", async () => {
    getDroppedEventsSpy.mockResolvedValue(response());

    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      { dataset: "errors", period: parsePeriod("90d"), json: false },
      boundTarget("my-org", "my-proj"),
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No dropped events for my-org/my-proj");
  });

  test("hints that nothing was dropped when only accepted volume exists", async () => {
    getDroppedEventsSpy.mockResolvedValue(
      response({
        acceptedEvents: [
          {
            type: "error",
            category: "error",
            outcome: "accepted",
            reason: "accepted",
            start: 0,
            end: 1,
            count: 7,
            tags: [],
          },
        ],
      }),
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      { dataset: "errors", period: parsePeriod("90d"), json: false },
      boundTarget("my-org", "my-proj"),
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Accepted: 7 (100.00%)");
    expect(output).toContain("No dropped events for my-org/my-proj");
  });

  test("emits summarized rows as JSON", async () => {
    getDroppedEventsSpy.mockResolvedValue(
      response({
        droppedEvents: [
          {
            type: "error",
            category: "error",
            outcome: "rate_limited",
            reason: "key_quota",
            start: 0,
            end: 1,
            count: 5,
            tags: ["unintentional"],
          },
        ],
      }),
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      { dataset: "errors", period: parsePeriod("90d"), json: true },
      boundTarget("my-org", "my-proj"),
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : parsed.data;
    expect(rows[0].outcome).toBe("rate_limited");
    expect(rows[0].reason).toBe("key_quota");
    expect(rows[0].events).toBe(5);
  });
});
