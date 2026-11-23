/**
 * The result of every tool that renders the chart view, such as
 * render_sentry_chart and render_issue_chart. Imports only zod, so the view
 * parses the same contract the tools declare.
 */
import { z } from "zod";
import { ingestionSchema } from "../ingestion";

const bucketIndexesSchema = z.array(z.number().int().nonnegative());

export const chartOutputSchema = z.object({
  tool: z
    .enum(["render_sentry_chart", "render_issue_chart"])
    .describe("Tool that drew this chart; changing the range calls it again."),
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
  times: z
    .array(z.string())
    .describe("Start of each bucket, oldest first; shared by every series."),
  incomplete: bucketIndexesSchema.describe(
    "Indexes into `times` of buckets still receiving data, whose values may rise.",
  ),
  outsideRetention: bucketIndexesSchema.describe(
    "Indexes into `times` of buckets that start before the retention window, so older data is missing and the value will not change.",
  ),
  series: z
    .array(
      z.object({
        label: z
          .string()
          .describe("The group's value, or what the series measures."),
        count: z
          .number()
          .nullable()
          .describe(
            "Events behind this series; null when not measured. A small count means a noisy series.",
          ),
        total: z
          .number()
          .nullable()
          .describe("Sum of all buckets; null for non-additive aggregates."),
        values: z
          .array(z.number().nullable())
          .describe(
            "One value per entry of `times`; null where the bucket has no data.",
          ),
      }),
    )
    .describe("One series per measure or top group, most events first."),
  peak: z
    .object({ series: z.string(), time: z.string(), value: z.number() })
    .nullable()
    .describe(
      "Highest bucket that is no longer receiving data; null for grouped charts.",
    ),
  ingestion: ingestionSchema,
});

export type ChartResult = z.output<typeof chartOutputSchema>;
