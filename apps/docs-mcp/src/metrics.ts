/**
 * Centralized Sentry metrics helpers for the docs-mcp server.
 *
 * Follows the same pattern as getsentry/cli-init-api/apps/server/src/mastra/lib/metrics.ts.
 * Uses the Sentry Metrics API (count, distribution) from @sentry/cloudflare.
 */
import * as Sentry from "@sentry/cloudflare";

// ── Tool Metrics ────────────────────────────────────────────────────

/** Track an MCP tool call (count). */
export function trackToolCall(tool: string, success: boolean): void {
  Sentry.metrics.count("docs_mcp.tool.call", 1, {
    attributes: { tool, success },
  });
}

/** Track MCP tool call duration (distribution). */
export function trackToolDuration(tool: string, durationMs: number): void {
  Sentry.metrics.distribution("docs_mcp.tool.duration", durationMs, {
    unit: "millisecond",
    attributes: { tool },
  });
}

// ── Fetch Metrics ───────────────────────────────────────────────────

/** Track a docs.sentry.io fetch duration with cache hit/miss info. */
export function trackFetchDuration(
  url: string,
  cacheHit: boolean,
  durationMs: number,
): void {
  Sentry.metrics.distribution("docs_mcp.fetch.duration", durationMs, {
    unit: "millisecond",
    attributes: { url, cache_hit: cacheHit },
  });
}

// ── Agent Metrics ───────────────────────────────────────────────────

/** Track LLM token usage for an agent call. */
export function trackAgentTokens(
  promptTokens: number,
  completionTokens: number,
): void {
  Sentry.metrics.distribution("docs_mcp.agent.tokens.prompt", promptTokens, {
    attributes: { kind: "prompt" },
  });
  Sentry.metrics.distribution(
    "docs_mcp.agent.tokens.completion",
    completionTokens,
    { attributes: { kind: "completion" } },
  );
}

/** Track how many tool-call steps the agent took before finishing. */
export function trackAgentSteps(stepCount: number): void {
  Sentry.metrics.distribution("docs_mcp.agent.steps", stepCount);
}

/** Track an agent invocation (success/failure count). */
export function trackAgentCall(success: boolean): void {
  Sentry.metrics.count("docs_mcp.agent.call", 1, {
    attributes: { success },
  });
}

/**
 * Track when the tailor agent's primary call returned empty text and
 * we had to run a fallback synthesis pass.
 */
export function trackAgentFallbackSynthesis(): void {
  Sentry.metrics.count("docs_mcp.agent.fallback_synthesis", 1);
}

// ── Cache Metrics ───────────────────────────────────────────────────

/** Track an agent-result cache lookup (hit/miss). */
export function trackAgentCacheLookup(scope: string, hit: boolean): void {
  Sentry.metrics.count("docs_mcp.agent.cache", 1, {
    attributes: { scope, hit },
  });
}
