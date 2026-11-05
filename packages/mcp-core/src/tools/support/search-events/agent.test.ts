import { expect, it } from "vitest";
import { normalizeTimeSeriesConfig } from "../../../utils/time-series";
import {
  hasSuccessfulSearchValidation,
  searchEventsAgentOutputSchema,
} from "./agent";

it("accepts ordered duplicate axes from embedded translation", () => {
  const translated = searchEventsAgentOutputSchema.parse({
    dataset: "spans",
    query: "span.op:db",
    fields: [],
    sort: "",
    timeRange: { statsPeriod: "24h" },
    timeSeries: {
      axes: [
        { yAxis: "count()", transformations: ["fill(zero)", "smooth(sma,3)"] },
        { yAxis: "count()", transformations: ["smooth(asap)"] },
      ],
      interval: "1h",
    },
  });

  expect(normalizeTimeSeriesConfig(translated.timeSeries!)).toEqual({
    axes: [
      { yAxis: "count()", transformations: ["fill(zero)", "smooth(sma,3)"] },
      { yAxis: "count()", transformations: ["smooth(asap)"] },
    ],
    interval: "1h",
  });
});

it("normalizes legacy embedded time series without dropping its pipeline", () => {
  const translated = searchEventsAgentOutputSchema.parse({
    dataset: "logs",
    query: "severity:error",
    fields: [],
    sort: "",
    timeRange: null,
    timeSeries: {
      yAxis: "count()",
      transformations: ["smooth(ema,5,0.3)", "fill(locf)"],
      interval: "1m",
    },
  });

  expect(normalizeTimeSeriesConfig(translated.timeSeries!)).toEqual({
    axes: [
      {
        yAxis: "count()",
        transformations: ["smooth(ema,5,0.3)", "fill(locf)"],
      },
    ],
    interval: "1m",
  });
});

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
