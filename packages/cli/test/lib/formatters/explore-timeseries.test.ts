import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ExploreTimeSeriesData,
  formatExploreTimeSeriesHuman,
  jsonTransformExploreTimeSeries,
} from "../../../src/lib/formatters/explore-timeseries.js";
import {
  renderCommandOutput,
  resolveRenderer,
} from "../../../src/lib/formatters/output.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- terminal capability boundary for vi.spyOn
import * as terminal from "../../../src/lib/sixel.js";
import type { DecodedImage } from "../../../src/lib/sixel-image.js";

/** Sanitized shape of a captured spans timeseries response, including ingestion metadata. */
function makeData(): ExploreTimeSeriesData {
  return {
    org: "test-org",
    project: "test-project",
    dataset: "spans",
    meta: {
      dataset: "spans",
      start: Date.UTC(2026, 0, 1) + 123,
      end: Date.UTC(2026, 0, 1, 0, 15) + 456,
      ingestion: {
        status: "healthy",
        delaySeconds: 288,
        completeThrough: Date.UTC(2026, 0, 1, 0, 10, 12),
      },
    },
    timeSeries: [
      {
        yAxis: "count()",
        meta: {
          valueType: "integer",
          valueUnit: null,
          interval: 300_000,
          dataScanned: "full",
        },
        values: [
          {
            timestamp: Date.UTC(2026, 0, 1),
            value: 1234,
            incomplete: false,
            sampleCount: 1234,
            sampleRate: 1,
            confidence: "high",
          },
          {
            timestamp: Date.UTC(2026, 0, 1, 0, 5),
            value: 0,
            incomplete: false,
            sampleCount: 0,
            sampleRate: 1,
            confidence: "high",
          },
          {
            timestamp: Date.UTC(2026, 0, 1, 0, 10),
            value: 52,
            incomplete: true,
            incompleteReason: "INGESTION_PENDING",
            sampleCount: 52,
            sampleRate: 1,
            confidence: "high",
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("formatExploreTimeSeriesHuman", () => {
  test("renders UTC buckets, the effective interval, and ingestion completeness", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const output = formatExploreTimeSeriesHuman(makeData());

    expect(output).toContain("Querying spans in test-org/test-project");
    expect(output).toContain(
      "Range (UTC): 2026-01-01 00:00:00 to 2026-01-01 00:15:00",
    );
    expect(output).toContain("count() over time");
    expect(output).toContain("Interval: 5m");
    expect(output).toContain("TIME (UTC)");
    expect(output).toContain("1,234");
    expect(output).toMatch(/2026-01-01 00:05:00\s+│\s+0/);
    expect(output).toContain("Ingestion pending");
    expect(output).toContain("Ingestion status: healthy");
    expect(output).toContain("Reported ingestion delay: 4m 48s");
  });

  test("renders each measure with its own metadata and distinguishes missing values from zero", () => {
    const data = makeData();
    data.timeSeries[0]!.values.pop();
    data.timeSeries.push({
      yAxis: "p95(span.duration)",
      meta: {
        valueType: "duration",
        valueUnit: "millisecond",
        interval: 600_000,
      },
      values: [
        { timestamp: Date.UTC(2026, 0, 1), value: null, incomplete: false },
        {
          timestamp: Date.UTC(2026, 0, 1, 0, 10),
          value: 12.5,
          incomplete: false,
        },
      ],
    });

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).toContain("count() over time");
    expect(output).toContain("p95(span.duration) over time");
    expect(output).toContain("Interval: 5m");
    expect(output).toContain("Interval: 10m");
    expect(output).toContain("Unit: millisecond");
    expect(output).toContain("12.5ms");
    expect(output).toMatch(/2026-01-01 00:05:00\s+│\s+0/);
    expect(output).toMatch(/2026-01-01 00:00:00\s+│\s+—/);
    expect(output).not.toContain("STATUS");
    expect(output).not.toContain("Ingestion status");
  });

  test("preserves identifier-like and markdown-like strings without coercion", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.yAxis = "latest_event()";
    series.meta.valueType = "string";
    series.values = [
      { timestamp: Date.UTC(2026, 0, 1), value: "00123", incomplete: false },
      {
        timestamp: Date.UTC(2026, 0, 1, 0, 5),
        value: "*literal_value*",
        incomplete: false,
      },
      {
        timestamp: Date.UTC(2026, 0, 1, 0, 10),
        value: null,
        incomplete: false,
      },
    ];

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).toContain("latest_event() over time");
    expect(output).toContain("00123");
    expect(output).toContain("*literal_value*");
    expect(output).toMatch(/2026-01-01 00:10:00\s+│\s+—/);
  });

  test("distinguishes retention, unfinished windows, and unavailable scan coverage", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.meta.dataScanned = "partial";
    series.values[0] = {
      timestamp: Date.UTC(2026, 0, 1),
      value: 100,
      incomplete: true,
      incompleteReason: "OUTSIDE_RETENTION",
      sampleCount: 10,
      sampleRate: 0.1,
      confidence: "low",
    };
    series.values[2]!.incompleteReason = "NOT_ELAPSED";

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).toContain("Outside retention");
    expect(output).toContain("Window not elapsed");
    expect(output).toContain("Only part of the available data was scanned");
    expect(output).toContain("Some buckets have low confidence");
    expect(output).toContain("Results include sampled data");
    expect(output).not.toContain("Ingestion pending");
    expect(output).not.toContain("Reported ingestion delay");
  });

  test("does not mistake absent series or buckets for zero-valued results", () => {
    const data = makeData();
    data.timeSeries[0]!.values = [];
    expect(formatExploreTimeSeriesHuman(data)).toContain(
      "No time buckets returned",
    );

    data.timeSeries = [];
    expect(formatExploreTimeSeriesHuman(data)).toContain(
      "No time series returned",
    );
  });
});

/** Decode the emitted Kitty RGBA payload, including continuation chunks. */
function kittyImages(output: string): DecodedImage[] {
  const images: DecodedImage[] = [];
  let payload = "";
  for (const packet of output.split("\x1b_G").slice(1)) {
    const separator = packet.indexOf(";");
    const keys = Object.fromEntries(
      packet
        .slice(0, separator)
        .split(",")
        .map((key) => key.split("=")),
    );
    if (keys.a === "T") {
      images.push({
        width: Number(keys.s),
        height: Number(keys.v),
        data: new Uint8Array(),
      });
      payload = "";
    }
    payload += packet.slice(separator + 1, packet.indexOf("\x1b\\"));
    if (keys.m === "0") {
      images.at(-1)!.data = Buffer.from(payload, "base64");
    }
  }
  return images;
}

function alphaAt(
  image: DecodedImage,
  x: number,
  y: number,
): number | undefined {
  return image.data[(y * image.width + x) * 4 + 3];
}

describe("Explore time-series graphics", () => {
  let savedColumns: number | undefined;

  beforeEach(() => {
    savedColumns = process.stdout.columns;
    process.stdout.columns = 80;
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");
    vi.spyOn(terminal, "selectGraphicsFormat").mockReturnValue("kitty");
    vi.spyOn(terminal, "graphicsCellSize").mockReturnValue({
      cellWidth: 8,
      cellHeight: 8,
    });
    vi.spyOn(terminal, "terminalPixelWidth").mockReturnValue(160);
  });

  afterEach(() => {
    process.stdout.columns = savedColumns;
  });

  test.each(["kitty", "sixel"] as const)(
    "renders one %s chart and scale per aggregate",
    (format) => {
      vi.mocked(terminal.selectGraphicsFormat).mockReturnValue(format);
      vi.stubEnv("TZ", "America/Los_Angeles");
      const data = makeData();
      const count = data.timeSeries[0]!;
      count.values[2]!.incomplete = false;
      data.timeSeries.push({
        yAxis: "p95(span.duration)",
        meta: {
          valueType: "duration",
          valueUnit: "millisecond",
          interval: 15_000,
        },
        values: [12.5, 25].map((value, index) => ({
          timestamp: Date.UTC(2026, 0, 1) + index * 15_000,
          value,
          incomplete: false,
        })),
      });
      const original = structuredClone(data);

      const output = formatExploreTimeSeriesHuman(data);

      expect(
        output.split(format === "kitty" ? "\x1b_Ga=T" : "\x1bP"),
      ).toHaveLength(3);
      expect(output).toContain("count() over time");
      expect(output).toContain("p95(span.duration) over time");
      expect(output).toContain("Scale: 0 to 1,234");
      expect(output).toContain("Scale: 0 to 25ms");
      expect(output).toContain("Unit: millisecond");
      expect(output).toContain("2026-01-01 00:00:00 to 2026-01-01 00:00:15");
      expect(output).not.toContain("TIME (UTC)");
      expect(data).toEqual(original);
    },
  );

  test("keeps gaps in place, distinguishes zero, and retains incomplete values and warnings", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.meta.dataScanned = "partial";
    series.values = [10_000, null, 0, 90_000, 80_000, 70_000, 5000, 1].map(
      (value, index) => ({
        timestamp: Date.UTC(2026, 0, 1) + index * series.meta.interval,
        value,
        incomplete: false,
      }),
    );
    series.values[3]!.incomplete = true;
    series.values[3]!.incompleteReason = "OUTSIDE_RETENTION";
    series.values[4]!.incomplete = true;
    series.values[4]!.incompleteReason = "INGESTION_PENDING";
    series.values[5]!.incomplete = true;
    series.values[5]!.incompleteReason = "NOT_ELAPSED";
    series.values[6]!.sampleRate = 0.1;
    series.values[6]!.confidence = "low";
    const original = structuredClone(data);

    const output = formatExploreTimeSeriesHuman(data);
    const images = kittyImages(output);

    expect(images).toHaveLength(1);
    const image = images[0]!;
    expect(image.data).toHaveLength(image.width * image.height * 4);
    // Eight slots span the image: absent values keep their slots, and a later
    // complete bucket keeps its time position instead of closing the gaps.
    expect(alphaAt(image, 10, 0)).toBe(255);
    expect(alphaAt(image, 30, 63)).toBe(0);
    expect(alphaAt(image, 50, 63)).toBe(255);
    expect(alphaAt(image, 50, 62)).toBe(0);
    expect(alphaAt(image, 70, 63)).toBe(0);
    expect(alphaAt(image, 90, 63)).toBe(0);
    expect(alphaAt(image, 110, 63)).toBe(0);
    expect(alphaAt(image, 130, 31)).toBe(0);
    expect(alphaAt(image, 130, 32)).toBe(255);
    // A small positive value must survive a large peak, just as zero does.
    expect(alphaAt(image, 150, 63)).toBe(255);
    expect(alphaAt(image, 150, 62)).toBe(0);
    expect(output).toContain("Scale: 0 to 10,000");
    expect(output).toContain("Gaps are missing or incomplete buckets");
    expect(output).toMatch(/2026-01-01 00:05:00\s+│\s+—/);
    expect(output).toMatch(
      /2026-01-01 00:15:00\s+│\s+90,000\s+│\s+Outside retention/,
    );
    expect(output).toMatch(
      /2026-01-01 00:20:00\s+│\s+80,000\s+│\s+Ingestion pending/,
    );
    expect(output).toMatch(
      /2026-01-01 00:25:00\s+│\s+70,000\s+│\s+Window not elapsed/,
    );
    expect(output).toContain("Only part of the available data was scanned");
    expect(output).toContain("Some buckets have low confidence");
    expect(output).toContain("Results include sampled data");
    expect(output).toContain("Reported ingestion delay: 4m 48s");
    expect(data).toEqual(original);
  });

  test("scales sub-centesimal measurements without labelling them zero", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.meta.valueType = "duration";
    series.meta.valueUnit = "millisecond";
    series.values = [0.001, 0.002].map((value, index) => ({
      timestamp: Date.UTC(2026, 0, 1) + index * series.meta.interval,
      value,
      incomplete: false,
    }));

    const output = formatExploreTimeSeriesHuman(data);
    const [image] = kittyImages(output);

    expect(output).toContain("Scale: 0 to 0.002ms");
    expect(image).toBeDefined();
    expect(alphaAt(image!, 10, 31)).toBe(0);
    expect(alphaAt(image!, 10, 32)).toBe(255);
    expect(alphaAt(image!, 90, 0)).toBe(255);
  });

  test.each(["negative", "string", "irregular", "missing"] as const)(
    "uses the table for a %s series",
    (kind) => {
      const data = makeData();
      const series = data.timeSeries[0]!;
      if (kind === "negative") {
        series.values[0]!.value = -5;
      } else if (kind === "string") {
        series.values[0]!.value = "00123";
      } else if (kind === "irregular") {
        series.values[1]!.timestamp += 1000;
      } else {
        series.values = series.values.map((bucket) => ({
          ...bucket,
          value: null,
        }));
      }

      const output = formatExploreTimeSeriesHuman(data);

      expect(output).toContain("TIME (UTC)");
      expect(output).toContain("Ingestion pending");
      expect(output).not.toContain("\x1b_G");
      expect(output).not.toContain("\x1bP");
      if (kind === "negative") expect(output).toContain("-5");
      if (kind === "string") expect(output).toContain("00123");
      if (kind === "irregular") expect(output).toContain("2026-01-01 00:05:01");
      if (kind === "missing") expect(output).toContain("—");
    },
  );

  test("uses the full table instead of averaging dense percentile buckets", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.yAxis = "p95(span.duration)";
    series.values = Array.from({ length: 81 }, (_, index) => ({
      timestamp: Date.UTC(2026, 0, 1) + index * series.meta.interval,
      value: index === 80 ? 999 : index,
      incomplete: false,
    }));

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).not.toContain("\x1b_G");
    expect(output).toContain("TIME (UTC)");
    expect(output).toMatch(/2026-01-01 06:40:00\s+│\s+999/);
  });

  test("falls back to the same table on a terminal without graphics", () => {
    vi.mocked(terminal.selectGraphicsFormat).mockReturnValue(undefined);
    const data = makeData();
    const unsupported = formatExploreTimeSeriesHuman(data);
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");

    expect(unsupported).toContain("TIME (UTC)");
    expect(unsupported).toContain("1,234");
    expect(unsupported).toContain("Ingestion pending");
    expect(unsupported).not.toContain("\x1b_G");
    expect(formatExploreTimeSeriesHuman(data)).toContain("TIME (UTC)");
  });

  test.each([undefined, ["timestamp", "value", "incomplete"]])(
    "preserves JSON with fields %j without probing the terminal",
    (fields) => {
      const data = makeData();
      data.timeSeries[0]!.values[1]!.value = null;
      const original = structuredClone(data);
      const chunks: (string | Uint8Array)[] = [];
      const config = {
        human: formatExploreTimeSeriesHuman,
        jsonTransform: jsonTransformExploreTimeSeries,
      };
      renderCommandOutput(
        {
          write: (chunk) => {
            chunks.push(chunk);
            return true;
          },
        },
        data,
        config,
        resolveRenderer(config.human),
        { json: true, fields },
      );

      const response = JSON.parse(chunks.join(""));
      const { org: _org, project: _project, ...expected } = original;
      expect(response).toEqual(
        fields
          ? {
              ...expected,
              timeSeries: expected.timeSeries.map((series) => ({
                ...series,
                values: series.values.map(
                  ({ timestamp, value, incomplete }) => ({
                    timestamp,
                    value,
                    incomplete,
                  }),
                ),
              })),
            }
          : expected,
      );
      expect(terminal.selectGraphicsFormat).not.toHaveBeenCalled();
      expect(terminal.graphicsCellSize).not.toHaveBeenCalled();
      expect(data).toEqual(original);
    },
  );
});
