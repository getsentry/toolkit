import { expect, it } from "vitest";
import { hasSuccessfulSearchValidation } from "./agent";

it("identifies a passing validateSearch result", () => {
  expect(hasSuccessfulSearchValidation([])).toBe(false);
  expect(
    hasSuccessfulSearchValidation([
      { toolName: "datasetAttributes", output: { result: {} } },
    ]),
  ).toBe(false);
  expect(
    hasSuccessfulSearchValidation([
      { toolName: "validateSearch", output: { result: { valid: false } } },
    ]),
  ).toBe(false);
  expect(
    hasSuccessfulSearchValidation([
      { toolName: "validateSearch", output: { error: "API unavailable" } },
    ]),
  ).toBe(false);
  expect(
    hasSuccessfulSearchValidation([
      { toolName: "validateSearch", output: { result: { valid: true } } },
    ]),
  ).toBe(true);
});

it("accepts any successful validation among candidates checked in one step", () => {
  const passing = {
    toolName: "validateSearch",
    output: { result: { valid: true } },
  };
  const failing = {
    toolName: "validateSearch",
    output: { result: { valid: false } },
  };

  expect(hasSuccessfulSearchValidation([passing, failing])).toBe(true);
  expect(hasSuccessfulSearchValidation([failing, passing])).toBe(true);
  expect(hasSuccessfulSearchValidation([failing, failing])).toBe(false);
});
