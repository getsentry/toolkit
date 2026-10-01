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

// events-dropped only supports the datasets in its DATASET_TO_CATEGORY map.
const DROPPED_EVENTS_DATASETS = ["spans", "logs", "metrics"] as const;

const droppedBucketSchema = z.object({
  outcome: z.string(),
  reason: z.string(),
  category: z.string(),
  start: z.number(),
  end: z.number(),
  count: z.number(),
});

export const findDroppedEventsOutputSchema = z.object({
  dataset: z.string(),
  interval: z.number(),
  droppedEvents: z.array(droppedBucketSchema),
  acceptedEvents: z.array(droppedBucketSchema),
});

export default defineTool({
  name: "find_dropped_events",
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  description: [
    "Find events Sentry received but dropped — ground-truth data-fidelity information.",
    "",
    "Events can be dropped before they reach a chart (rate limited, over quota, filtered,",
    "invalid, abuse/spike protection, client-discarded via sample_rate or before_send,",
    "cardinality limited). A normal timeseries only shows what was accepted, so a flat,",
    "spiky, or unexpectedly low chart can be caused entirely by drops that the chart does",
    "not reveal.",
    "",
    "Use this tool when you need to:",
    "- Explain why a chart is flat, lower than expected, or doesn't match what the user is sending",
    "- Check whether data was dropped before trusting a query result or dashboard",
    "- Attribute a volume anomaly to a specific drop reason (quota, spike protection, sampling, filters)",
    "- Tell the user why their data is missing and what to do about it (raise quota, fix sampling, etc.)",
    "",
    "Returns dropped event volume bucketed over time, with the drop `outcome` and `reason`",
    "for each bucket, plus the accepted volume per bucket so you can compute the dropped share.",
    "",
    "<examples>",
    "find_dropped_events(organizationSlug='my-org', dataset='spans', projectSlug='my-project')",
    "find_dropped_events(organizationSlug='my-org', dataset='logs', statsPeriod='30d')",
    "</examples>",
    "",
    "<hints>",
    "- This is independent of any search query — it reports drops for the whole project/time range.",
    "- `outcome` is the drop kind (e.g. rate_limited, filtered); `reason` is the sub-cause (e.g. key_quota, sample_rate).",
    "- An empty `droppedEvents` list means no drops in the window — the data can be trusted.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    dataset: z
      .enum(DROPPED_EVENTS_DATASETS)
      .describe("Which data type to report drops for.")
      .default("spans"),
    projectSlug: ParamProjectSlug.nullable().default(null),
    statsPeriod: z
      .string()
      .trim()
      .describe(
        "Relative time range, e.g. '24h', '7d', '30d'. Mutually exclusive with start/end.",
      )
      .nullable()
      .default(null),
    start: z
      .string()
      .trim()
      .describe("Absolute start (ISO 8601). Must be paired with end.")
      .nullable()
      .default(null),
    end: z
      .string()
      .trim()
      .describe("Absolute end (ISO 8601). Must be paired with start.")
      .nullable()
      .default(null),
    interval: z
      .string()
      .trim()
      .describe(
        "Bucket size, e.g. '1h', '1d'. Omit to let Sentry pick for the range.",
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
    });

    const toBucket = (bucket: {
      outcome: string;
      reason: string;
      category: string;
      start: number;
      end: number;
      count: number;
    }) => ({
      outcome: bucket.outcome,
      reason: bucket.reason,
      category: bucket.category,
      start: bucket.start,
      end: bucket.end,
      count: bucket.count,
    });

    return structuredResult({
      dataset: response.meta.dataset,
      interval: response.meta.interval,
      droppedEvents: response.droppedEvents.map(toBucket),
      acceptedEvents: response.acceptedEvents.map(toBucket),
    });
  },
});
