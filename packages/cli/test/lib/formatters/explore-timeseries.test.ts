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
import {
  createPixelCanvas,
  drawPixelText,
  type Rgb,
} from "../../../src/lib/formatters/pixel-canvas.js";
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

/** Read a bitmap text region independently of the chart's layout calculation. */
function textPixels(
  image: DecodedImage,
  x: number,
  y: number,
  columns: number,
): Buffer {
  const rows = Array.from({ length: 8 }, (_, row) => {
    const start = ((y + row) * image.width + x) * 4;
    return image.data.slice(start, start + columns * 8 * 4);
  });
  return Buffer.concat(rows);
}

/** Reference glyphs for the literal labels a user should see in the image. */
function labelPixels(text: string, color: Rgb = [128, 128, 128]): Buffer {
  const image = createPixelCanvas({ width: text.length * 8, height: 8 });
  drawPixelText(image, text, {
    x: 0,
    y: 0,
    cellWidth: 8,
    cellHeight: 8,
    maxColumns: text.length,
    color,
  });
  return Buffer.from(image.data);
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
    vi.spyOn(terminal, "terminalPixelWidth").mockReturnValue(640);
  });

  afterEach(() => {
    process.stdout.columns = savedColumns;
  });

  test.each(["kitty", "sixel"] as const)(
    "renders one %s chart per aggregate before its caption without repeating its labels",
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

      const imageStart = format === "kitty" ? "\x1b_Ga=T" : "\x1bP";
      expect(output.split(imageStart)).toHaveLength(3);
      expect(output.indexOf(imageStart)).toBeLessThan(
        output.indexOf("Interval: 5m"),
      );
      expect(output.indexOf("Interval: 5m")).toBeLessThan(
        output.lastIndexOf(imageStart),
      );
      expect(output.lastIndexOf(imageStart)).toBeLessThan(
        output.indexOf("Interval: 15s"),
      );
      expect(output).not.toContain("count()");
      expect(output).not.toContain("p95(span.duration)");
      expect(output).not.toContain("Scale:");
      expect(output).not.toContain("Unit:");
      expect(output).not.toContain("Bucket starts");
      // The query window remains distinct from the last bucket start on the axis.
      expect(output).toContain(
        "Range (UTC): 2026-01-01 00:00:00 to 2026-01-01 00:15:00",
      );
      expect(output).not.toContain("TIME (UTC)");
      expect(data).toEqual(original);
      if (format === "kitty") {
        const [countImage, durationImage] = kittyImages(output);
        expect(textPixels(countImage!, 0, 0, 5)).toEqual(labelPixels("1,234"));
        expect(textPixels(durationImage!, 0, 0, 4)).toEqual(
          labelPixels("25ms"),
        );
        expect(textPixels(durationImage!, 41, 48, 23)).toEqual(
          labelPixels("2026-01-01 00:00:00 UTC"),
        );
        expect(textPixels(durationImage!, 449, 48, 23)).toEqual(
          labelPixels("2026-01-01 00:00:15 UTC"),
        );
        expect(textPixels(durationImage!, 8, 56, 17)).toEqual(
          labelPixels("p95 span.duration", [224, 224, 224]),
        );
        expect([
          ...durationImage!.data.subarray(58 * 640 * 4, 58 * 640 * 4 + 4),
        ]).toEqual([117, 83, 255, 255]);
      }
    },
  );

  test.each([
    "p95(custom.measurement.with.a.long.name)",
    "count_if(span.op,equals,http.client)",
    "equation|count()/2",
    "count()/2",
    "sum(value)",
  ])(
    "retains the complete expression %s below an abbreviated legend",
    (yAxis) => {
      const data = makeData();
      data.timeSeries[0]!.yAxis = yAxis;

      const output = formatExploreTimeSeriesHuman(data);

      expect(kittyImages(output)).toHaveLength(1);
      expect(output).toContain(yAxis);
      expect(output.indexOf(yAxis)).toBeGreaterThan(
        output.indexOf("\x1b_Ga=T"),
      );
      expect(output.indexOf(yAxis)).toBeLessThan(
        output.indexOf("Interval: 5m"),
      );
    },
  );

  test.each([
    { valueType: "rate", maximum: 1234, label: "1,234" },
    { valueType: "rate", maximum: 0.002, label: "0.002" },
    { valueType: "number", maximum: 0.002, label: "0.002" },
  ])(
    "keeps $valueType units in the caption on a narrow chart (maximum $maximum)",
    ({ valueType, maximum, label }) => {
      const data = makeData();
      const series = data.timeSeries[0]!;
      series.meta.valueType = valueType;
      series.meta.valueUnit = "1/second";
      series.values[0]!.value = maximum;
      // A redundant axis unit would consume the space needed by the UTC labels.
      process.stdout.columns = 56;
      vi.mocked(terminal.terminalPixelWidth).mockReturnValue(448);

      const output = formatExploreTimeSeriesHuman(data);
      const images = kittyImages(output);

      expect(images).toHaveLength(1);
      expect(textPixels(images[0]!, 0, 0, label.length)).toEqual(
        labelPixels(label),
      );
      expect(output).toContain("Interval: 5m · Unit: 1/second");
      expect(output.indexOf("Unit: 1/second")).toBeGreaterThan(
        output.indexOf("\x1b_Ga=T"),
      );
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
    // Eight slots follow the value-axis gutter. Gaps keep their time positions
    // and the axis below the plot must not turn them into visible data ticks.
    expect(alphaAt(image, 90, 0)).toBe(255);
    expect(alphaAt(image, 160, 46)).toBe(0);
    expect(alphaAt(image, 230, 46)).toBe(255);
    expect(alphaAt(image, 230, 45)).toBe(0);
    expect(alphaAt(image, 310, 46)).toBe(0);
    expect(alphaAt(image, 380, 46)).toBe(0);
    expect(alphaAt(image, 460, 46)).toBe(0);
    expect(alphaAt(image, 530, 22)).toBe(0);
    expect(alphaAt(image, 530, 23)).toBe(255);
    // A small positive value must survive a large peak, just as zero does.
    expect(alphaAt(image, 610, 46)).toBe(255);
    expect(alphaAt(image, 610, 45)).toBe(0);
    expect(textPixels(image, 0, 0, 6)).toEqual(labelPixels("10,000"));
    expect(output).toContain("Missing or incomplete buckets:");
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
    const caption = output.slice(
      output.indexOf("Interval: 5m"),
      output.indexOf("Missing or incomplete buckets:"),
    );
    expect(caption.trim()).not.toContain("\n\n");
    expect(output.indexOf("Interval: 5m")).toBeGreaterThan(
      output.indexOf("\x1b_Ga=T"),
    );
    expect(
      output.indexOf("Only part of the available data was scanned"),
    ).toBeGreaterThan(output.indexOf("\x1b_Ga=T"));
    expect(output.indexOf("Ingestion status: healthy")).toBeGreaterThan(
      output.indexOf("Window not elapsed"),
    );
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

    expect(image).toBeDefined();
    expect(textPixels(image!, 0, 0, 7)).toEqual(labelPixels("0.002ms"));
    expect(alphaAt(image!, 100, 22)).toBe(0);
    expect(alphaAt(image!, 100, 23)).toBe(255);
    expect(alphaAt(image!, 400, 0)).toBe(255);
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

  test("uses the full table when axes leave too little plot width for percentile buckets", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.yAxis = "p95(span.duration)";
    series.values = Array.from({ length: 300 }, (_, index) => ({
      timestamp: Date.UTC(2026, 0, 1) + index * series.meta.interval,
      value: index === 299 ? 999 : index,
      incomplete: false,
    }));

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).not.toContain("\x1b_G");
    expect(output).toContain("TIME (UTC)");
    expect(output).toMatch(/2026-01-02 00:55:00\s+│\s+999/);
  });

  test("uses the table when UTC labels cannot fit without truncation", () => {
    vi.mocked(terminal.terminalPixelWidth).mockReturnValue(400);

    const output = formatExploreTimeSeriesHuman(makeData());

    expect(output).toContain("TIME (UTC)");
    expect(output).toContain("1,234");
    expect(output).not.toContain("\x1b_G");
  });

  test("uses tables without graphics support or when plain output is requested", () => {
    vi.mocked(terminal.selectGraphicsFormat).mockReturnValue(undefined);
    const data = makeData();
    const unsupported = formatExploreTimeSeriesHuman(data);

    expect(unsupported).toContain("TIME (UTC)");
    expect(unsupported).toContain("1,234");
    expect(unsupported).toContain("Ingestion pending");
    expect(unsupported).not.toContain("\x1b_G");

    vi.mocked(terminal.selectGraphicsFormat).mockReturnValue("kitty");
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");
    const plain = formatExploreTimeSeriesHuman(data);

    expect(plain).toContain("TIME (UTC)");
    expect(plain).not.toContain("\x1b_G");
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
