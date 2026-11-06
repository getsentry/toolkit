import { describe, expect, it } from "vitest";
import { getSeerActionabilityLabel } from "./formatting";

describe("getSeerActionabilityLabel", () => {
  it("returns correct labels for threshold boundaries", () => {
    expect(getSeerActionabilityLabel(0.77)).toBe("super_high");
    expect(getSeerActionabilityLabel(0.67)).toBe("high");
    expect(getSeerActionabilityLabel(0.41)).toBe("medium");
    expect(getSeerActionabilityLabel(0.26)).toBe("low");
    expect(getSeerActionabilityLabel(0.25)).toBe("super_low");
    expect(getSeerActionabilityLabel(0)).toBe("super_low");
  });

  it("returns super_high for scores above 0.76", () => {
    expect(getSeerActionabilityLabel(0.99)).toBe("super_high");
    expect(getSeerActionabilityLabel(0.8)).toBe("super_high");
    expect(getSeerActionabilityLabel(0.761)).toBe("super_high");
  });

  it("returns high for scores between 0.66 and 0.76", () => {
    expect(getSeerActionabilityLabel(0.76)).toBe("high");
    expect(getSeerActionabilityLabel(0.7)).toBe("high");
    expect(getSeerActionabilityLabel(0.661)).toBe("high");
  });

  it("returns medium for scores between 0.40 and 0.66", () => {
    expect(getSeerActionabilityLabel(0.66)).toBe("medium");
    expect(getSeerActionabilityLabel(0.5)).toBe("medium");
    expect(getSeerActionabilityLabel(0.401)).toBe("medium");
  });

  it("returns low for scores between 0.25 and 0.40", () => {
    expect(getSeerActionabilityLabel(0.4)).toBe("low");
    expect(getSeerActionabilityLabel(0.3)).toBe("low");
    expect(getSeerActionabilityLabel(0.251)).toBe("low");
  });

  it("returns super_low for scores at or below 0.25", () => {
    expect(getSeerActionabilityLabel(0.25)).toBe("super_low");
    expect(getSeerActionabilityLabel(0.1)).toBe("super_low");
    expect(getSeerActionabilityLabel(0)).toBe("super_low");
  });
});
