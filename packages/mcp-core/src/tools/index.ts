import catalogTools from "./catalog";
import { createSearchToolsTool } from "./special/search-tools";
import { createExecuteTool } from "./special/execute-tool";
import type { ToolConfig } from "./types";

type ToolRegistry = Record<string, ToolConfig>;

function getAllTools(): ToolRegistry {
  return allTools;
}

const allTools = {
  ...catalogTools,
  search_sentry_tools: createSearchToolsTool(getAllTools),
  execute_sentry_tool: createExecuteTool(getAllTools),
} as const satisfies ToolRegistry;

// Default export: object mapping tool names to tools
export default allTools;

// Type export
export type ToolName = keyof typeof allTools;
