/**
 * Event Dropped Command Tests
 *
 * Drives `droppedCommand.func()` with a mocked API + project resolution to
 * verify human and JSON output, including the drop-classification tags that
 * were added after the original (now-closed) sentry-cli PRs.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { droppedCommand } from "../../../src/commands/event/dropped.js";
import type { DroppedEventsResponse } from "../../../src/types/dropped-events.js";

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

describe("event dropped command func()", () => {
  let getDroppedEventsSpy: ReturnType<typeof vi.spyOn>;
  let getProjectSpy: ReturnType<typeof vi.spyOn>;
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
    getProjectSpy = vi
      .spyOn(apiClient, "getProject")
      // Only the numeric id is read by the command.
      .mockResolvedValue({ id: "12345", slug: "my-project" } as never);
    getDroppedEventsSpy = vi
      .spyOn(apiClient, "getDroppedEvents")
      .mockResolvedValue(RESPONSE);
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    getProjectSpy.mockRestore();
    getDroppedEventsSpy.mockRestore();
  });

  test("scopes the request to the resolved numeric project id", async () => {
    const { context } = createMockContext();
    const func = await droppedCommand.loader();
    await func.call(
      context,
      { dataset: "errors", json: true },
      "my-org/my-project",
    );

    expect(getDroppedEventsSpy).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ dataset: "errors", projectId: "12345" }),
    );
  });

  test("JSON output carries outcomes, shares, and tags", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await droppedCommand.loader();
    await func.call(
      context,
      { dataset: "errors", json: true },
      "my-org/my-project",
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual([
      "client_discard",
      "rate_limited",
    ]);
    const clientDiscard = parsed.outcomes[0];
    expect(clientDiscard.share).toBeCloseTo(0.1, 10);
    expect(clientDiscard.reasons[0].tags).toEqual(["intentional"]);
    // share is a raw ratio, not a formatted percentage string
    expect(typeof clientDiscard.reasons[0].share).toBe("number");
  });

  test("human output renders tables with a Tags column", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await droppedCommand.loader();
    await func.call(
      context,
      { dataset: "errors", json: false },
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
    const func = await droppedCommand.loader();
    await func.call(
      context,
      { dataset: "errors", json: false },
      "my-org/my-project",
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No dropped events for my-org/my-project.");
  });
});
