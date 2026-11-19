import { describe, expect, it } from "vitest";
import { scaleFraction, valueScale } from "./chart";

function plotted(values: number[]) {
  const scale = valueScale(values);
  return {
    scale,
    fractions: values.map((value) => scaleFraction(scale, value)),
    baseline: scaleFraction(scale, 0),
  };
}

describe("valueScale", () => {
  it("keeps all-negative series inside the plot, with 0 at the top", () => {
    const { scale, fractions, baseline } = plotted([-4, -2]);

    expect(scale).toEqual({ bottom: -4, top: 0, step: 1 });
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect(baseline).toBe(1);
  });

  it("spans mixed-sign series with the 0 baseline between them", () => {
    const { scale, fractions, baseline } = plotted([-30, 5, 70]);

    expect(scale.bottom).toBeLessThanOrEqual(-30);
    expect(scale.top).toBeGreaterThanOrEqual(70);
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect(baseline).toBeGreaterThan(fractions[0] ?? 0);
    expect(baseline).toBeLessThan(fractions[2] ?? 1);
  });

  it("puts 0 at the bottom of an all-positive series", () => {
    const { scale, baseline } = plotted([56, 140]);

    expect(scale).toEqual({ bottom: 0, top: 150, step: 50 });
    expect(baseline).toBe(0);
  });

  it("gives an all-zero series a one-step domain", () => {
    expect(valueScale([0, 0])).toEqual({ bottom: 0, top: 1, step: 1 });
  });
});
