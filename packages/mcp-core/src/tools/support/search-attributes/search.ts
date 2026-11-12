import { ApiClientError, type TraceItemAttribute } from "../../../api-client";
import { ConfigurationError, UserInputError } from "../../../errors";
import { hasAgentProvider } from "../../../internal/agents/provider-factory";
import { withProviderFallback } from "../../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../../internal/tool-helpers/api";
import { logIssue, logWarn } from "../../../telem/logging";
import { setTargetTagsAndAttributes } from "../../../telem/scope";
import type { ServerContext } from "../../../types";
import { fetchCustomAttributes } from "../search-events/utils";
import {
  type AttributeMatches,
  generateKeyHintsAgent,
  shortlistAttributesAgent,
} from "./agent";
import {
  formatFindResult,
  formatListResult,
  getRecommendedKeysByDataset,
} from "./format";

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
const FIND_LIMIT = 10;
/**
 * The endpoint returns up to 1000 keys per type, sorted by name, then hides
 * some internal and superseded keys. So a list that was cut off can come back
 * a little short of 1000.
 */
const CUT_OFF_THRESHOLD = 900;

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
  const dataset = params.dataset;

  const fetchRows = async (substringMatch?: string) => {
    const { attributes } = await fetchCustomAttributes(
      apiService,
      organizationSlug,
      dataset,
      projectId,
      { statsPeriod: period },
      { context: true, substringMatch },
    );
    return Object.values(attributes) as TraceItemAttribute[];
  };

  let rows = await fetchRows();

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

  if (!query) return listAttributes();

  if (!hasAgentProvider()) {
    return listAttributes(
      [
        "Matching by `query` needs an AI provider, so these are the dataset's attributes instead.",
      ],
      [],
    );
  }

  // The endpoint sorts keys by name and stops at about 1000 per type, so in a
  // large org the right key can be past the cut. A substring search looks
  // through every key, so search again with hints made from the query.
  if (mayBeCutOff(rows)) {
    const keyHints = await withAgentFallback<string[]>({
      operation: "search_attributes.key_hints",
      fallback: () => [],
      run: () => generateKeyHintsAgent({ query, dataset }),
    });
    // A hint search only adds keys, so a failed one is skipped rather than
    // failing the call. 4xx and config errors aren't ours to report.
    const searchHint = (hint: string) =>
      fetchRows(hint).catch((error: unknown) => {
        if (
          !(error instanceof ApiClientError) &&
          !(error instanceof ConfigurationError)
        ) {
          logIssue(error, {
            loggerScope: ["tools", "search-attributes", "key-hint-search"],
            contexts: {
              request: { organizationSlug, dataset, substringMatch: hint },
            },
          });
        }
        return [];
      });

    // If there are results from the hints, use that + recommended keys
    // otherwise it defaults to the original exhaustive list
    const hintRows = await Promise.all(keyHints.map(searchHint));
    if (
      hintRows.length > 0 &&
      // as long as one of the hint calls have values we should use that
      hintRows.reduce((acc, hintRow) => hintRow.length > 0 || acc, false)
    ) {
      let recommendedRows: TraceItemAttribute[] = [];
      const recommendedKeys = getRecommendedKeysByDataset(params.dataset);
      recommendedRows = rows.filter((attribute) =>
        recommendedKeys.has(attribute.key),
      );
      rows = mergeByKey([recommendedRows, ...hintRows]);
    }
  }

  console.log(rows);

  const matches =
    rows.length === 0
      ? { candidates: [] }
      : await withAgentFallback<AttributeMatches | null>({
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

/**
 * Both agents here are optional, so also fall back when the model's reply is
 * unusable. callEmbeddedAgent reports that as a UserInputError, which
 * withProviderFallback lets through for tools that need the agent's answer.
 */
function withAgentFallback<T>({
  operation,
  fallback,
  run,
}: {
  operation: string;
  fallback: () => T;
  run: () => Promise<T>;
}): Promise<T> {
  return withProviderFallback({
    operation,
    fallback,
    run: async () => {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof UserInputError)) throw error;
        logWarn(error, {
          loggerScope: ["agents", "provider-fallback"],
          contexts: { aiProviderFallback: { operation, unusableOutput: true } },
        });
        return fallback();
      }
    },
  });
}

/** Whether any attribute type came back at or near the endpoint's per-type cap. */
function mayBeCutOff(attributes: TraceItemAttribute[]): boolean {
  const counts = new Map<string, number>();
  for (const { type } of attributes) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= CUT_OFF_THRESHOLD);
}

/** Merge attribute lists by key, keeping the first copy of each. */
function mergeByKey(lists: TraceItemAttribute[][]): TraceItemAttribute[] {
  const byKey = new Map<string, TraceItemAttribute>();
  for (const attribute of lists.flat()) {
    if (!byKey.has(attribute.key)) byKey.set(attribute.key, attribute);
  }
  return [...byKey.values()];
}
