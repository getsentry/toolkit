import { describe, expect, it } from "vitest";
import { ParamPeriod } from "./schema";

describe("ParamPeriod", () => {
  it.each(["30m", "1h", "24h", "7d", "2w"])("accepts %s", (period) => {
    expect(ParamPeriod.parse(period)).toBe(period);
  });

  it.each(["1mo", "last hour", "1.5h"])("rejects %s", (period) => {
    expect(ParamPeriod.safeParse(period).success).toBe(false);
  });
});
