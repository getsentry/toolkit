import type { Tag, TraceItemAttribute } from "../../../api-client";
import { UserInputError } from "../../../errors";
import { hasAgentProvider } from "../../../internal/agents/provider-factory";
import { withProviderFallback } from "../../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../../internal/tool-helpers/api";
import { setTargetTagsAndAttributes } from "../../../telem/scope";
import type { ServerContext } from "../../../types";
import { fetchCustomAttributes } from "../search-events/utils";
import { type AttributeMatches, shortlistAttributesAgent } from "./agent";
import { formatFindResult, formatListResult } from "./format";

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
const FIND_LIMIT = 10;
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

  // Capture after the check above so the narrowed type survives in closures.
  const dataset = params.dataset;
  const listAttributes = (notes?: string[]) =>
    formatListResult({
      organizationSlug,
      dataset,
      period,
      attributes: rows,
      limit: params.limit ?? LIST_LIMIT,
      notes,
    });

  if (!query) return listAttributes();

  // Until keyword ranking lands, matching by query needs the shortlist agent.
  if (!hasAgentProvider()) {
    return listAttributes([
      "Matching by `query` needs an AI provider, so these are the dataset's attributes instead.",
    ]);
  }

  const matches =
    rows.length === 0
      ? { candidates: [] } // nothing to match, so skip the model call
      : await withProviderFallback<AttributeMatches | null>({
          operation: "search_attributes.shortlist",
          fallback: () => null,
          run: () =>
            shortlistAttributesAgent({
              query,
              dataset,
              attributes: rows,
              limit: params.limit ?? FIND_LIMIT,
            }),
        });

  if (!matches) {
    return listAttributes([
      "The AI provider couldn't match `query` right now, so these are the dataset's attributes instead.",
    ]);
  }

  return formatFindResult({
    organizationSlug,
    dataset,
    period,
    query,
    matches,
    totalAttributes: rows.length,
  });
}
