import { describe, expect, it } from "vitest";
import { advanceDevicePoll, nextDevicePollInterval } from "./oauth-poll";

describe("nextDevicePollInterval", () => {
  it.each([1, 5, 30])(
    "keeps a %is interval while authorization is pending",
    (interval) => {
      expect(nextDevicePollInterval(interval, "authorization_pending")).toBe(
        interval,
      );
    },
  );

  it.each([1, 5, 30])(
    "adds five seconds to a %is interval on slow_down",
    (interval) => {
      expect(nextDevicePollInterval(interval, "slow_down")).toBe(interval + 5);
    },
  );

  it("accumulates repeated slow_down responses", () => {
    const first = nextDevicePollInterval(1, "slow_down");
    expect(nextDevicePollInterval(first, "slow_down")).toBe(11);
  });
});

describe("advanceDevicePoll", () => {
  it("retains the interval for pending and increases it for repeated slow_down", () => {
    const pending = advanceDevicePoll(1, "authorization_pending");
    expect(pending).toEqual({ status: "retry", intervalSeconds: 1 });

    const first = advanceDevicePoll(1, "slow_down");
    expect(first).toEqual({ status: "retry", intervalSeconds: 6 });
    if (first.status !== "retry") {
      throw new Error("slow_down must retry");
    }
    expect(advanceDevicePoll(first.intervalSeconds, "slow_down")).toEqual({
      status: "retry",
      intervalSeconds: 11,
    });
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
    ["invalid_grant", "unexpected"],
    [undefined, "unexpected"],
  ] as const)("classifies %s without retrying", (errorCode, status) => {
    expect(advanceDevicePoll(5, errorCode)).toEqual({ status });
  });
});
