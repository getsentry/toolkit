/**
 * Expose every tool directly in tools/list and drop search_sentry_tools and
 * execute_sentry_tool.
 *
 * Tier 1 harnesses now defer MCP tool schemas behind their own tool search
 * (docs/mcp/harnesses.md), so our gateway is redundant there.
 * This is a code constant on purpose, not a runtime option: set it to false
 * to restore the gateway surface in surfaces.ts if a harness regresses.
 *
 * TEMPORARY: this flag exists only while we roll the change out and verify
 * that harness tool search behaves as expected. Once it has proven out, we
 * may remove the search_sentry_tools/execute_sentry_tool gateway concepts
 * entirely (this flag, TOP_LEVEL_TOOL_NAMES, tools/special/, and the
 * catalog-runtime search path) instead of keeping both surfaces.
 *
 * It lives in its own module so tests can pin the gateway surface with
 * `vi.mock("./exposure", () => ({ EXPOSE_ALL_TOOLS: false }))`.
 */
export const EXPOSE_ALL_TOOLS: boolean = true;
