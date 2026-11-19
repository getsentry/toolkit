import type { ServerContext } from "../../types";
import type { ToolConfig } from "../types";
import {
  getFilteredInputSchema,
  getSearchableTools,
  resolveToolDescription,
  type ToolRegistry,
} from "./availability";
import { zodFieldMapToJsonSchema } from "./schema";

interface SearchableToolText {
  name: string;
  description: string;
}

export interface ToolSearchResult {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolConfig["annotations"];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreTool(tool: SearchableToolText, query: string): number {
  const normalizedQuery = query.toLowerCase();
  const queryTokens = tokenize(query);
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const combinedText = `${name} ${description}`;

  let score = combinedText.includes(normalizedQuery) ? 20 : 0;

  for (const token of queryTokens) {
    if (name === token) {
      score += 12;
    } else if (name.includes(token)) {
      score += 8;
    }
    if (description.includes(token)) {
      score += 2;
    }
  }

  return score;
}

export function searchToolCatalog({
  tools,
  context,
  query,
  limit,
}: {
  tools: ToolRegistry;
  context: ServerContext;
  query: string;
  limit: number;
}): ToolSearchResult[] {
  const experimentalMode = context.experimentalMode ?? false;

  return getSearchableTools({
    tools,
    context,
    experimentalMode,
    useDefaultSurfacePolicy: true,
  })
    .map(({ tool }) => {
      const inputSchema = getFilteredInputSchema(tool, context);
      const description = resolveToolDescription(tool, {
        experimentalMode,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      });
      const searchable: SearchableToolText = {
        name: tool.name,
        description,
      };

      return {
        score: scoreTool(searchable, query),
        tool,
        description,
        inputSchema,
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool, description, inputSchema }) => ({
      name: tool.name,
      description,
      inputSchema: zodFieldMapToJsonSchema(inputSchema),
      annotations: tool.annotations,
    }));
}
