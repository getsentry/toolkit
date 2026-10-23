import { Agent } from "@mastra/core/agent";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import { trackAgentCall, trackAgentSteps, trackAgentTokens } from "../metrics";
import { libToPlatformPath } from "../sentry-docs/doctree";
import { createNativeModelFallbacks, PRIMARY_MODEL } from "./model-fallback";
import { createFetchDocPageTool, createSearchDocsTool } from "./tools";

/**
 * Discovery agent runs are short — typically one search + one or two
 * fetches before the structured output is produced. The extra step
 * provides headroom for unmapped libs that need a search round-trip
 * before fetching the canonical getting-started page.
 */
const MAX_STEPS = 5;

/**
 * Match the temperature used by all server-side workflow agents
 * (getsentry/cli-init-api/apps/server/src/mastra/agents/default-options.ts). Determinism makes
 * results stable for the CF Cache key by sorted-libs hash.
 */
const TEMPERATURE = 0;

/**
 * Canonical Sentry feature slugs. Anything outside this list is rejected
 * before being returned to the caller — this prevents the agent from
 * hallucinating new feature names that would later fail downstream.
 *
 * Stays in sync with the FEATURE_TO_SUBPATH map in
 * `src/sentry-docs/doctree.ts` and the SLUG_TO_FEATURE map in
 * `getsentry/cli-init-api/apps/server/src/mastra/lib/docs-mcp-client.ts`.
 */
const KNOWN_FEATURE_SLUGS = [
  "error-monitoring",
  "tracing",
  "session-replay",
  "profiling",
  "logs",
  "source-maps",
  "crons",
  "metrics",
  "ai-monitoring",
  "mcp-observability",
  "user-feedback",
  "react-features",
] as const;

/**
 * Hardcoded fallback when the agent fails entirely.
 *
 * Error monitoring is universally available across every Sentry SDK,
 * and tracing is supported on every platform that has a getting-started
 * guide on docs.sentry.io. These are safe defaults that won't crash the
 * wizard's downstream feature picker even if our docs lookup is broken.
 */
const FALLBACK_FEATURES = ["error-monitoring", "tracing"];
const AGENT_DEFAULT_OPTIONS = {
  modelSettings: {
    temperature: TEMPERATURE,
    // Disable p-retry's inner retries so the outer fallback loop is the
    // sole retry/fallback mechanism. See default-options.ts in getsentry/cli-init-api/apps/server.
    maxRetries: 0,
  },
};

function getUsedModelId(result: {
  steps?: Array<{ response?: { modelId?: string } }>;
  response?: { modelId?: string };
}): string {
  return (
    result.steps?.[result.steps.length - 1]?.response?.modelId ??
    result.response?.modelId ??
    PRIMARY_MODEL
  );
}

const SYSTEM_PROMPT = `You are a Sentry SDK feature-discovery specialist.

Given a list of user libraries, identify which Sentry features are documented for that platform on docs.sentry.io. Use search_docs and fetch_doc_page as needed to confirm support.

Return ONLY canonical slugs from this allow-list:
${KNOWN_FEATURE_SLUGS.map((s) => `- ${s}`).join("\n")}

Always include "error-monitoring" — it is supported by every Sentry SDK.

WHERE TO LOOK
The fastest and most authoritative way to determine supported features is to fetch_doc_page on the platform's getting-started page (e.g. /platforms/javascript/guides/<lib>/) and look for the "Choose the features you want to configure" toggle list near the top of the page. This is the canonical, Sentry-maintained list of supported features per platform — it is far more reliable than guessing from the presence of side-bar topic links (which exist for many platforms regardless of actual support).

Map the displayed feature names from that toggle list to canonical slugs as follows:
- "Error Monitoring" / "Issues" → error-monitoring
- "Tracing" / "Performance" → tracing
- "Session Replay" → session-replay
- "Profiling" → profiling
- "Logs" → logs
- "User Feedback" → user-feedback

If the getting-started page also documents source map upload (look for a "Source Maps" step or section, or a "sentryVitePlugin"/"sentryWebpackPlugin"/"@sentry/wizard -i sourcemaps" code block), include "source-maps".

If the getting-started page documents AI Agent Monitoring or AI agent instrumentation in the toggle list or as a primary feature, include "ai-monitoring".

If the docs show MCP Observability or Sentry MCP monitoring setup for MCP servers, include "mcp-observability".

Be conservative: include a feature only if the docs clearly show it for the requested platform. If the platform's docs can't be determined, return ["error-monitoring"] as a safe minimum. Never invent feature slugs.

OUTPUT
Use the structured output schema. Return { features: string[] } where each entry is one of the allow-listed slugs above.`;

const featuresOutputSchema = z.object({
  features: z
    .array(z.string())
    .describe("Canonical Sentry feature slugs available for the given libs"),
});

/**
 * Filter agent output to only canonical slugs and ensure error-monitoring is present.
 *
 * Defends against the model returning slugs outside the allow-list, even
 * with the system prompt's restriction. Always returns at least
 * `error-monitoring` so callers never get an empty list.
 */
function sanitizeFeatures(raw: string[]): string[] {
  const allowed = new Set<string>(KNOWN_FEATURE_SLUGS);
  const out = new Set<string>();
  out.add("error-monitoring");
  for (const slug of raw) {
    const normalized = slug.trim().toLowerCase();
    if (allowed.has(normalized)) {
      out.add(normalized);
    }
  }
  return [...out];
}

function createFeaturesAgent(
  apiKey: string | undefined,
  fetchedUrls: string[],
) {
  return new Agent({
    id: "docs-features-agent",
    name: "Docs Features Agent",
    instructions: SYSTEM_PROMPT,
    defaultOptions: AGENT_DEFAULT_OPTIONS,
    model: createNativeModelFallbacks(PRIMARY_MODEL, apiKey),
    tools: {
      search_docs: createSearchDocsTool(),
      fetch_doc_page: createFetchDocPageTool(fetchedUrls),
    },
  });
}

/**
 * Resolve lib slugs to canonical Sentry feature slugs.
 *
 * Caches results in the CF Cache API by sorted-libs key (1h TTL) so
 * repeat wizard runs for the same platform combo skip the LLM call.
 *
 * Falls back to FALLBACK_FEATURES on any error so the wizard never
 * sees an empty list.
 */
export async function runFeaturesAgent(
  apiKey: string | undefined,
  libs: string[],
): Promise<string[]> {
  return await Sentry.startSpan(
    {
      op: "docs.agent.features",
      name: "featuresAgent",
      attributes: {
        "agent.libs": libs.join(","),
        "agent.model": PRIMARY_MODEL,
        "agent.max_steps": MAX_STEPS,
      },
    },
    async (span) => {
      const fetchedUrls: string[] = [];

      const setUrlAttrs = () => {
        const urls = [...new Set(fetchedUrls)];
        span.setAttribute("docs.urls_accessed_count", urls.length);
        if (urls.length > 0) {
          span.setAttribute(
            "docs.urls_accessed",
            urls.join(",").slice(0, 2000),
          );
        }
      };

      const seedPaths = libs
        .map((lib) => libToPlatformPath(lib))
        .filter((p): p is string => p !== null);

      span.setAttribute("agent.seed_paths_count", seedPaths.length);

      const seedSection =
        seedPaths.length > 0
          ? `Platform doc paths to investigate:\n${seedPaths.map((p) => `- ${p}`).join("\n")}`
          : "No platform paths matched the libs. Use search_docs to find what platform docs exist.";

      const userPrompt = `Libraries: ${libs.join(", ")}

${seedSection}

Return the canonical feature slugs available for this platform.`;

      try {
        const agent = createFeaturesAgent(apiKey, fetchedUrls);
        const result = await agent.generate(userPrompt, {
          maxSteps: MAX_STEPS,
          structuredOutput: { schema: featuresOutputSchema },
        });

        const inputTokens = result.totalUsage?.inputTokens ?? 0;
        const outputTokens = result.totalUsage?.outputTokens ?? 0;
        const stepCount = result.steps?.length ?? 0;
        const usedModelId = getUsedModelId(result);

        span.setAttribute("agent.model", usedModelId);
        span.setAttribute("agent.tokens.input", inputTokens);
        span.setAttribute("agent.tokens.output", outputTokens);
        span.setAttribute("agent.steps", stepCount);

        trackAgentTokens(inputTokens, outputTokens);
        trackAgentSteps(stepCount);
        trackAgentCall(true);

        const rawFeatures = result.object?.features ?? [];
        const features = sanitizeFeatures(rawFeatures);

        span.setAttribute("agent.feature_count", features.length);
        setUrlAttrs();

        return features;
      } catch (err) {
        span.setStatus({ code: 2, message: "error" });
        Sentry.captureException(err);
        Sentry.addBreadcrumb({
          category: "docs.agent.features",
          message: `Features agent failed for libs=${libs.join(",")}: ${err instanceof Error ? err.message : String(err)}`,
          level: "warning",
        });
        trackAgentCall(false);
        setUrlAttrs();
        // Never throw — wizard's select-features step has its own fallback,
        // but we want to give it *something* useful.
        return [...FALLBACK_FEATURES];
      }
    },
  );
}
