import type { Tag, TraceItemAttribute } from "../../../api-client";
import { UserInputError } from "../../../errors";
import { hasAgentProvider } from "../../../internal/agents/provider-factory";
import { withProviderFallback } from "../../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../../internal/tool-helpers/api";
import { setTargetTagsAndAttributes } from "../../../telem/scope";
import type { ServerContext } from "../../../types";
import { fetchCustomAttributes } from "../search-events/utils";
import { formatListResult } from "./format";

export const SEARCH_ATTRIBUTES_DATASETS = ["spans", "logs", "metrics"] as const;

export type SearchAttributesDataset =
  (typeof SEARCH_ATTRIBUTES_DATASETS)[number];

export interface SearchAttributesParams {
  organizationSlug: string;
  projectSlug: string | null;
  query?: string;
  period?: string;
  regionUrl: string | null;
  limit?: number;
  dataset?: SearchAttributesDataset;
}

const DEFAULT_PERIOD = "14d";
const LIST_LIMIT = 50;

/**
 * Handler for search_attributes.
 */
export async function runSearchAttributes(
  params: SearchAttributesParams,
  context: ServerContext,
): Promise<string> {
  const apiService = apiServiceFromContext(context, {
    regionUrl: params.regionUrl ?? undefined,
  });
  const organizationSlug = params.organizationSlug;

  setTargetTagsAndAttributes(params);

  if (!params.dataset) {
    throw new UserInputError(
      "Choose a dataset: `spans` (requests, latency, database and AI calls), `logs` (log lines), or `metrics` (counters, gauges, distributions).",
    );
  }

  // The attributes API filters by numeric project ID, not slug.
  let projectId: string | undefined;
  if (params.projectSlug) {
    const project = await apiService.getProject({
      organizationSlug,
      projectSlugOrId: params.projectSlug,
    });
    projectId = String(project.id);
  }

  const query = params.query || undefined;
  const period = params.period ?? DEFAULT_PERIOD;

  const { attributes } = await fetchCustomAttributes(
    apiService,
    organizationSlug,
    params.dataset,
    projectId,
    { statsPeriod: period },
    { context: true },
  );
  const rows = Object.values(attributes) as TraceItemAttribute[];

  const dataset = params.dataset;
  const listAttributes = (importantInfo?: string[], notes?: string[]) =>
    formatListResult({
      organizationSlug,
      dataset,
      period,
      attributes: rows,
      limit: params.limit ?? LIST_LIMIT,
      notes,
      importantInfo,
    });

  if (query) {
    if (!hasAgentProvider()) {
      return listAttributes(
        [
          "Matching by `query` needs an AI provider, so these are the dataset's attributes instead.",
        ],
        [],
      );
    }
    return listAttributes(
      [
        "Matching by `query` is not available yet. Here are all of the dataset's attributes instead.",
      ],
      [],
    );
  }

  return listAttributes();
}
