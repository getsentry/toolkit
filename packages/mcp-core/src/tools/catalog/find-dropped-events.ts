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

const DROPPED_EVENTS_DATASETS = ["spans", "logs", "metrics", "errors"] as const;

const DROP_OUTCOMES = [
  "rate_limited",
  "filtered",
  "invalid",
  "abuse",
  "client_discard",
  "cardinality_limited",
] as const;

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
    "Find events dropped before they were stored in Sentry — ground-truth data-fidelity information about what was and wasn't captured.",
    "",
    "Events can be dropped client-side in the SDK (sample_rate, before_send) or",
    "server-side at ingest (rate limited, over quota, filtered, invalid, abuse/spike",
    "protection, cardinality limited). Accepted-only views (searches, aggregates,",
    "charts) can't show this, so the data may be incomplete in ways they don't reveal",
    "— for example, a flat or spiky chart caused entirely by drops.",
    "",
    "Use this tool when you need to:",
    "- Explain why a chart is flat, lower than expected, or doesn't match what the user is sending",
    "- Confirm the data you need is actually in Sentry (not dropped) before trusting a query, aggregate, or dashboard",
    "- Attribute a volume anomaly to a specific drop reason (quota, spike protection, sampling, filters)",
    "- Tell the user why their data is missing and what to do about it (raise quota, fix sampling, etc.)",
    "",
    "Returns dropped event volume bucketed over time, with the drop `outcome` and `reason`",
    "for each bucket, plus the accepted volume per bucket so you can compute the dropped share.",
    "",
    "<examples>",
    "find_dropped_events(organizationSlug='my-org', dataset='spans', projectSlug='my-project')",
    "find_dropped_events(organizationSlug='my-org', dataset='logs', statsPeriod='30d')",
    "find_dropped_events(organizationSlug='my-org', dataset='errors', outcome='rate_limited')",
    "</examples>",
    "",
    "<hints>",
    "- This is independent of any search query — it reports drops for the whole project/time range.",
    "- `outcome` is the drop kind (e.g. rate_limited, filtered); `reason` is the sub-cause (e.g. key_quota, sample_rate).",
    "- Pass `outcome` and/or `reason` to scope the dropped side to one classification; the accepted volume is always returned in full.",
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
    outcome: z
      .enum(DROP_OUTCOMES)
      .describe(
        "Scope the dropped side to one top-level drop classification. Accepted volume is still returned in full.",
      )
      .nullable()
      .default(null),
    reason: z
      .string()
      .trim()
      .describe(
        "Scope the dropped side to one reason (sub-classification within an outcome, e.g. 'spike_protection'). Combine with `outcome`.",
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
