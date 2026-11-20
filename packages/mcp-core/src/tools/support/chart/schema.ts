/**
 * The render_sentry_chart result. Imports only zod, so the chart view parses
 * the same contract the tool declares.
 */
import { z } from "zod";
import { ingestionSchema } from "../ingestion";

const chartBucketSchema = z.object({
  time: z.string(),
  value: z.number(),
  incomplete: z
    .boolean()
    .describe("Data is still arriving, so the value may rise."),
  outsideRetention: z
    .boolean()
    .describe(
      "Starts before the retention window, so older data is missing and the value will not change.",
    ),
});

export const renderSentryChartOutputSchema = z.object({
  title: z.string(),
  dataset: z.string(),
  query: z.string(),
  yAxis: z.string(),
  groupBy: z.string().nullable(),
  valueType: z
    .string()
    .nullable()
    .describe("Such as integer, number, duration, percentage, or size."),
  valueUnit: z.string().nullable().describe("Such as millisecond or byte."),
  interval: z.string().describe("Bucket size, such as 5m or 1h."),
  timeRange: z.object({
    statsPeriod: z.string().nullable(),
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
  url: z.string(),
  series: z
    .array(
      z.object({
        label: z
          .string()
          .describe("The group's value, or the aggregate when ungrouped."),
        total: z
          .number()
          .nullable()
          .describe("Sum of all buckets; null for non-additive aggregates."),
        buckets: z
          .array(chartBucketSchema)
          .describe("Every bucket, oldest first."),
      }),
    )
    .describe("One series, or one per top group, largest first."),
  peak: z
    .object({ series: z.string(), time: z.string(), value: z.number() })
    .nullable()
    .describe("Highest bucket across series that is no longer receiving data."),
  ingestion: ingestionSchema,
});

export type ChartResult = z.output<typeof renderSentryChartOutputSchema>;
