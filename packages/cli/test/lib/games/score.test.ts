import { metrics } from "@sentry/node-core/light";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getPlayerHandle } from "../../../src/lib/games/player.js";
import { reportSnakeScore } from "../../../src/lib/games/score.js";
import {
  isTelemetryEnabled,
  scrubAnonymousMetric,
} from "../../../src/lib/telemetry.js";
import { useTestConfigDir } from "../../helpers.js";

// Enabling real telemetry would also turn on traced DB access; stub only the gate.
vi.mock("../../../src/lib/telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/telemetry.js")>()),
  isTelemetryEnabled: vi.fn(() => true),
}));

vi.mock("../../../src/lib/games/player.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/games/player.js")>();
  return { ...actual, getPlayerHandle: vi.fn(actual.getPlayerHandle) };
});

useTestConfigDir("test-games-score-");

describe("reportSnakeScore", () => {
  let distribution: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    distribution = vi
      .spyOn(metrics, "distribution")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    distribution.mockRestore();
  });

  test("emits the score with only the handle attribute", () => {
    reportSnakeScore(12);
    expect(distribution).toHaveBeenCalledTimes(1);
    expect(distribution).toHaveBeenCalledWith("snake.score", 12, {
      attributes: { handle: getPlayerHandle() },
    });
  });

  test("is skipped when telemetry is disabled", () => {
    vi.mocked(isTelemetryEnabled).mockReturnValueOnce(false);
    reportSnakeScore(12);
    expect(distribution).not.toHaveBeenCalled();
  });

  test("does not throw when the handle cannot be stored", () => {
    vi.mocked(getPlayerHandle).mockImplementationOnce(() => {
      throw new Error("ENOTDIR: not a directory");
    });
    expect(() => reportSnakeScore(12)).not.toThrow();
    expect(distribution).not.toHaveBeenCalled();
  });

  test("does not throw when the metric cannot be sent", () => {
    distribution.mockImplementationOnce(() => {
      throw new Error("transport failed");
    });
    expect(() => reportSnakeScore(12)).not.toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN, 10_001])(
    "ignores invalid score %s",
    (score) => {
      reportSnakeScore(score);
      expect(distribution).not.toHaveBeenCalled();
    },
  );
});

describe("scrubAnonymousMetric", () => {
  test("keeps only allowlisted attributes for snake.score", () => {
    const result = scrubAnonymousMetric({
      name: "snake.score",
      type: "distribution",
      value: 5,
      attributes: {
        handle: "brave-otter-4242",
        "user.id": "1",
        "user.email": "a@b.c",
        "user.name": "x",
        "server.address": "host",
        "sentry.replay_id": "abc",
        trace_id: "t",
        span_id: "s",
        "sentry.release": "1.0.0",
        "sentry.environment": "production",
        "sentry.sdk.name": "sdk",
        "sentry.sdk.version": "1",
      },
    });
    expect(Object.keys(result.attributes ?? {}).sort()).toEqual([
      "handle",
      "sentry.environment",
      "sentry.release",
      "sentry.sdk.name",
      "sentry.sdk.version",
    ]);
  });

  test("leaves other metrics unchanged", () => {
    const metric = {
      name: "other.metric",
      type: "counter" as const,
      value: 1,
      attributes: { "user.id": "1", foo: "bar" },
    };
    expect(scrubAnonymousMetric(metric)).toBe(metric);
  });
});
