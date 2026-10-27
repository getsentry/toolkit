import type { TraceItemType } from "../../../api-client";
import { apiServiceFromContext } from "../../../internal/tool-helpers/api";
import { setTargetTagsAndAttributes } from "../../../telem/scope";
import type { ServerContext } from "../../../types";

export const SEARCH_ATTRIBUTES_DATASETS = ["spans", "logs", "metrics"] as const;

export type SearchAttributesDataset =
  (typeof SEARCH_ATTRIBUTES_DATASETS)[number];

export interface SearchAttributesParams {
  organizationSlug: string;
  projectSlug: string | null;
  query?: string;
  period?: string;
  regionUrl: string | null;
  limit: number;
  dataset?: SearchAttributesDataset;
}

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

  // The attributes API filters by numeric project ID, not slug.
  let projectId: string | undefined;
  if (params.projectSlug) {
    const project = await apiService.getProject({
      organizationSlug,
      projectSlugOrId: params.projectSlug,
    });
    projectId = String(project.id);
  }

  // The attributes API still calls the metrics dataset "tracemetrics".
  const itemType =
    params.dataset === "metrics" ? "tracemetrics" : params.dataset;
  const query = params.query || undefined;

  // TODO: search attributes with these inputs and format the results.
  let output = `# Attribute Search in **${organizationSlug}**\n\n`;
  output += "Not implemented yet. Parsed inputs:\n\n";
  output += `- Dataset: ${params.dataset} (API item type: ${itemType})\n`;
  output += `- Project: ${projectId ? `${params.projectSlug} (ID ${projectId})` : "all projects"}\n`;
  output += `- Query: ${query ?? "none (list all attributes)"}\n`;
  output += `- Period: ${params.period ?? "not set"}\n`;
  output += `- Limit: ${params.limit}\n`;

  return output;
}
