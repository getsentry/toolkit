import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { DROPPED_EVENTS_DATASETS } from "../../utils/events-datasets";

const DROP_OUTCOMES = [
  "rate_limited",
  "filtered",
  "invalid",
  "abuse",
  "client_discard",
  "cardinality_limited",
] as const;

// Sentry parses `interval` with `^(\d+)([hdmsw]?)$` (no unit means seconds),
// and its Outcomes query (`get_constrained_date_range` in
// src/sentry/snuba/sessions_v2.py) rejects a bucket that is not a whole number
// of minutes, is longer than one day, or does not divide one day evenly.
const INTERVAL_UNIT_SECONDS: Record<string, number> = {
  "": 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};
const ONE_DAY_SECONDS = 86_400;

function isSupportedInterval(value: string): boolean {
  const match = /^(\d+)([hdmsw]?)$/.exec(value);
  if (!match) {
    return false;
  }
  const seconds = Number(match[1]) * INTERVAL_UNIT_SECONDS[match[2]];
  return seconds > 0 && seconds % 60 === 0 && ONE_DAY_SECONDS % seconds === 0;
}

const droppedBucketSchema = z.object({
  outcome: z.string(),
  reason: z.string(),
  category: z.string(),
  start: z.number(),
  end: z.number(),
  count: z.number(),
  tags: z.array(z.string()).default([]),
});

export const findDroppedEventsOutputSchema = z.object({
  dataset: z.string(),
  interval: z.number(),
  droppedEvents: z.array(droppedBucketSchema),
  acceptedEvents: z.array(droppedBucketSchema),
});

export default defineTool({
  name: "find_dropped_events",
  title: "Find Dropped Events",
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  description:
    "Find events Sentry dropped before storing them (SDK sampling, filters, rate limits, quota, spike protection), as dropped and accepted volume over time by outcome and reason. Each drop is tagged intentional (sampling, filters) or unintentional (quota, abuse). Use it to explain flat, low, or missing data that searches, charts, and dashboards cannot show; no drops means the data is complete.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    dataset: z
      .enum(DROPPED_EVENTS_DATASETS)
      .describe("Data type to report drops for.")
      .default("spans"),
    projectSlug: ParamProjectSlug.nullable().default(null),
    statsPeriod: z
      .string()
      .trim()
      .describe(
        "Relative time range such as 24h or 7d. Do not combine with start and end.",
      )
      .nullable()
      .default(null),
    start: z
      .string()
      .trim()
      .describe("Absolute start, ISO 8601; requires end.")
      .nullable()
      .default(null),
    end: z
      .string()
      .trim()
      .describe("Absolute end, ISO 8601; requires start.")
      .nullable()
      .default(null),
    interval: z
      .string()
      .trim()
      .refine(isSupportedInterval, {
        message:
          "Must be at most '1d' and divide one day evenly, e.g. '1h', '6h', or '1d', with the range split into at most 1000 buckets. For a total over a longer range, use '1d' and sum the buckets, or omit interval to let Sentry pick.",
      })
      .describe(
        "Bucket size such as 1h or 1d, at most 1d. Omit to let Sentry pick.",
      )
      .nullable()
      .default(null),
    outcome: z
      .enum(DROP_OUTCOMES)
      .describe(
        "Only count drops of this kind; accepted volume is always returned in full.",
      )
      .nullable()
      .default(null),
    reason: z
      .string()
      .trim()
      .describe(
        "Only count drops with this sub-cause of an outcome, such as key_quota, sample_rate, or spike_protection.",
      )
      .nullable()
      .default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findDroppedEventsOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes({
      organizationSlug,
      projectSlug: params.projectSlug ?? undefined,
    });

    let projectId: string | undefined;
    if (params.projectSlug) {
      const project = await apiService.getProject({
        organizationSlug,
        projectSlugOrId: params.projectSlug,
      });
      projectId = String(project.id);
    }

    const response = await apiService.getDroppedEvents({
      organizationSlug,
      dataset: params.dataset,
      projectId,
      interval: params.interval ?? undefined,
      statsPeriod: params.statsPeriod ?? undefined,
      start: params.start ?? undefined,
      end: params.end ?? undefined,
      outcome: params.outcome ?? undefined,
      reason: params.reason ?? undefined,
    });

    const toBucket = (bucket: {
      outcome: string;
      reason: string;
      category: string;
      start: number;
      end: number;
      count: number;
      tags?: string[];
    }) => ({
      outcome: bucket.outcome,
      reason: bucket.reason,
      category: bucket.category,
      start: bucket.start,
      end: bucket.end,
      count: bucket.count,
      tags: bucket.tags ?? [],
    });

    return structuredResult({
      dataset: response.meta.dataset,
      interval: response.meta.interval,
      droppedEvents: response.droppedEvents.map(toBucket),
      acceptedEvents: response.acceptedEvents.map(toBucket),
    });
  },
});
