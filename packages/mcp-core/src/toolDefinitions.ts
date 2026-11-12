import toolDefinitionsData from "./toolDefinitions.json";
import type { Scope } from "./permissions";
import type { Skill } from "./skills";

// Tool definition for UI/external consumption
export type ToolDefinitionSurface = "direct" | "catalog";

export interface ToolDefinition {
  name: string;
  // Human-readable display name
  title: string;
  description: string;
  // Full JSON Schema object for parameters
  inputSchema: unknown;
  // Full JSON Schema object for structured output, when declared
  outputSchema?: unknown;
  // Sentry API scopes required to use the tool
  requiredScopes: Scope[];
  // User-facing skill catalog memberships
  skills: Skill[];
  // Whether this tool is exposed directly or through the catalog.
  surface: ToolDefinitionSurface;
  // Set on names kept for backward compatibility; lists the replacements.
  deprecated?: { replacedBy: string[] };
}

const toolDefinitions = toolDefinitionsData as ToolDefinition[];

export const directToolDefinitions = toolDefinitions.filter(
  (tool) => tool.surface === "direct",
);

export const catalogToolDefinitions = toolDefinitions.filter(
  (tool) => tool.surface === "catalog",
);

export default toolDefinitions;
