/**
 * Expose every tool directly in tools/list and drop search_sentry_tools and
 * execute_sentry_tool.
 *
 * Tier 1 harnesses now defer MCP tool schemas behind their own tool search
 * (docs/mcp/harnesses.md), so our gateway is redundant there.
 * This is a code constant on purpose, not a runtime option: set it to false
 * to restore the gateway surface in surfaces.ts if a harness regresses.
 *
 * It lives in its own module so tests can pin the gateway surface with
 * `vi.mock("./exposure", () => ({ EXPOSE_ALL_TOOLS: false }))`.
 */
export const EXPOSE_ALL_TOOLS: boolean = true;
