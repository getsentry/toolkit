/**
 * Central policy for direct MCP exposure.
 *
 * Tool modules define behavior: name, description, schema, annotations, and
 * handler. Ordinary tools are catalog-eligible by default. This file only lists
 * wrapper/infrastructure tools outside the catalog and the explicit subset also
 * exposed through tools/list. With EXPOSE_ALL_TOOLS on, every catalog tool is
 * exposed through tools/list and the infrastructure tools are not registered.
 */

import { EXPOSE_ALL_TOOLS } from "./exposure";

export const CATALOG_INFRASTRUCTURE_TOOL_NAMES = [
  "search_sentry_tools",
  "execute_sentry_tool",
] as const;

export const WRAPPER_TOOL_NAMES = [] as const;

// The gateway surface used when EXPOSE_ALL_TOOLS is false. Kept only as a
// temporary fallback during the EXPOSE_ALL_TOOLS rollout (see exposure.ts);
// it may be removed along with the gateway tools later. Locked by
// ast-grep-rules/no-expand-top-level-tools.yml. Every name here ships in that
// tools/list payload; the rest stay deferred behind
// search_sentry_tools/execute_sentry_tool.
export const TOP_LEVEL_TOOL_NAMES = [
  "find_organizations",
  "find_projects",
  "update_issue",
  "search_errors",
  "search_logs",
  "search_traces",
  "search_metrics",
  "search_profiles",
  "search_replays",
  "analyze_issue_with_seer",
  "search_issues",
  "get_sentry_resource",
  ...CATALOG_INFRASTRUCTURE_TOOL_NAMES,
] as const;

// The experimental direct surface is intentionally aligned with the default
// surface now that search_sentry_tools and execute_sentry_tool are primary primitives.
export const EXPERIMENTAL_TOP_LEVEL_TOOL_NAMES = TOP_LEVEL_TOOL_NAMES;

const topLevelToolNames = new Set<string>(TOP_LEVEL_TOOL_NAMES);
const wrapperToolNames = new Set<string>(WRAPPER_TOOL_NAMES);
const catalogInfrastructureToolNames = new Set<string>(
  CATALOG_INFRASTRUCTURE_TOOL_NAMES,
);

export function isOutsideCatalogToolName(toolName: string): boolean {
  return (
    wrapperToolNames.has(toolName) ||
    catalogInfrastructureToolNames.has(toolName)
  );
}

export function isDefaultTopLevelToolName(toolName: string): boolean {
  if (EXPOSE_ALL_TOOLS) {
    return !isOutsideCatalogToolName(toolName);
  }
  return topLevelToolNames.has(toolName);
}

export function isTopLevelToolName(
  toolName: string,
  _experimentalMode: boolean,
): boolean {
  return isDefaultTopLevelToolName(toolName);
}

/**
 * Like {@link isTopLevelToolName}, but also keeps tools marked `deprecated`
 * out of tools/list. Harness tool search would otherwise return them next to
 * the tools that replaced them. On the gateway surface they stay reachable
 * through execute_sentry_tool.
 */
export function isTopLevelTool(
  tool: { name: string; deprecated?: unknown },
  experimentalMode: boolean,
): boolean {
  return !tool.deprecated && isTopLevelToolName(tool.name, experimentalMode);
}

export function isWrapperToolName(toolName: string): boolean {
  return wrapperToolNames.has(toolName);
}

export function isCatalogInfrastructureToolName(toolName: string): boolean {
  return catalogInfrastructureToolNames.has(toolName);
}
