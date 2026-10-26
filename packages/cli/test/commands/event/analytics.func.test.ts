import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  analyticsCommand,
  parseDataset,
} from "../../../src/commands/event/analytics.js";
import { ValidationError } from "../../../src/lib/errors.js";
import type { DroppedEventsResponse } from "../../../src/types/dropped-events.js";

describe("event analytics parseDataset", () => {
  test("maps the metrics alias to the tracemetrics API dataset", () => {
    expect(parseDataset("metrics")).toBe("tracemetrics");
  });

  test("accepts singular aliases like explore does", () => {
    expect(parseDataset("error")).toBe("errors");
    expect(parseDataset("span")).toBe("spans");
    expect(parseDataset("log")).toBe("logs");
  });

  test("is case-insensitive", () => {
    expect(parseDataset("Metrics")).toBe("tracemetrics");
  });

  test("rejects unknown datasets", () => {
    expect(() => parseDataset("replays")).toThrow(ValidationError);
  });
});

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

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

const RESPONSE: DroppedEventsResponse = {
  meta: { dataset: "errors", start: 0, end: 7200, interval: 3600000 },
  droppedEvents: [
    {
      type: "error",
      category: "error",
      outcome: "client_discard",
      reason: "sample_rate",
      start: 0,
      end: 3600,
      count: 100,
      tags: ["intentional"],
    },
    {
      type: "error",
      category: "error",
      outcome: "rate_limited",
      reason: "spike_protection",
      start: 0,
      end: 3600,
      count: 15,
      tags: ["unintentional"],
    },
    {
      type: "error",
      category: "error",
      outcome: "rate_limited",
      reason: "usage_exceeded",
      start: 0,
      end: 3600,
      count: 2,
      tags: ["unintentional"],
    },
  ],
  acceptedEvents: [
    {
      type: "error",
      category: "error",
      outcome: "accepted",
      reason: "accepted",
      start: 0,
      end: 3600,
      count: 883,
      tags: [],
    },
  ],
};

describe("event analytics command func()", () => {
  let getDroppedEventsSpy: ReturnType<typeof vi.spyOn>;
  let resolveProjectIdSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

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

  beforeEach(() => {
    resolveSpy = vi
      .spyOn(resolveTarget, "resolveProjectBoundFromArg")
      .mockResolvedValue({ org: "my-org", project: "my-project" });
    resolveProjectIdSpy = vi
      .spyOn(resolveTarget, "resolveLogProjectId")
      .mockResolvedValue(12345);
    getDroppedEventsSpy = vi
      .spyOn(apiClient, "getDroppedEvents")
      .mockResolvedValue(RESPONSE);
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    resolveProjectIdSpy.mockRestore();
    getDroppedEventsSpy.mockRestore();
  });

  test("scopes the request to the resolved numeric project id", async () => {
    const { context } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      {
        dataset: "errors",
        period: { type: "relative", period: "90d" },
        json: true,
      },
      "my-org/my-project",
    );

    expect(getDroppedEventsSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ dataset: "errors", projectId: "12345" }),
    );
  });

  test("forwards the parsed dataset to the API unchanged", async () => {
    const { context } = createMockContext();
    const func = await analyticsCommand.loader();
    // Mirror the flag pipeline: the dataset reaches func() already parsed, so
    // feed parseDataset's output (metrics → tracemetrics) the same way stricli
    // would. parseDataset's mapping is unit-tested separately above.
    await func.call(
      context,
      {
        dataset: parseDataset("metrics"),
        period: { type: "relative", period: "90d" },
        json: true,
      },
      "my-org/my-project",
    );

    expect(getDroppedEventsSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ dataset: "tracemetrics" }),
    );
  });

  test("JSON output is a flat array of outcome/reason rows", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      {
        dataset: "errors",
        period: { type: "relative", period: "90d" },
        json: true,
      },
      "my-org/my-project",
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((r: { outcome: string }) => r.outcome)).toEqual([
      "client_discard",
      "rate_limited",
      "rate_limited",
    ]);
    expect(parsed[0].reason).toBe("sample_rate");
    expect(parsed[0].share).toBeCloseTo(0.1, 10);
    expect(parsed[0].tags).toEqual(["intentional"]);
    // share is a raw ratio, not a formatted percentage string
    expect(typeof parsed[0].share).toBe("number");
  });

  test("--fields selects a subset of columns on each row", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      {
        dataset: "errors",
        period: { type: "relative", period: "90d" },
        json: true,
        fields: ["outcome", "reason", "events"],
      },
      "my-org/my-project",
    );

    const parsed = JSON.parse(stdoutWrite.mock.calls.map((c) => c[0]).join(""));
    expect(parsed[0]).toEqual({
      outcome: "client_discard",
      reason: "sample_rate",
      events: 100,
    });
  });

  test("human output renders tables with a Tags column", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      {
        dataset: "errors",
        period: { type: "relative", period: "90d" },
        json: false,
      },
      "my-org/my-project",
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Client Discard");
    expect(output).toContain("Rate Limited");
    expect(output).toContain("Tags");
    expect(output).toContain("unintentional");
  });

  test("prints a no-dropped-events hint when empty", async () => {
    getDroppedEventsSpy.mockResolvedValue({
      meta: { dataset: "errors", start: 0, end: 0, interval: 0 },
      droppedEvents: [],
      acceptedEvents: [],
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await analyticsCommand.loader();
    await func.call(
      context,
      {
        dataset: "errors",
        period: { type: "relative", period: "90d" },
        json: false,
      },
      "my-org/my-project",
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No dropped events for my-org/my-project.");
  });
});
