import { describe, expect, it } from "vitest";
import { nextDevicePollInterval } from "./oauth-poll";

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
