import * as Sentry from "@sentry/cloudflare";
import {
  asSchema,
  generateText,
  type Output,
  parsePartialJson,
  stepCountIs,
} from "ai";
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
 * (getsentry/cli-init-api/apps/server/src/mastra/agents/default-options.ts).
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
const MODEL_SETTINGS = {
  temperature: TEMPERATURE,
  // The model fallback chain is the only retry/fallback mechanism. See
  // createFallbackModel.
  maxRetries: 0,
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
 * Ask for the output schema as the response format on every step. The AI
 * SDK's own parsing is skipped: parseFeaturesOutput reads the steps instead.
 */
const featuresOutput: Output.Output<undefined, undefined> = {
  type: "object",
  responseFormat: {
    type: "json",
    schema: asSchema(featuresOutputSchema).jsonSchema,
  },
  parsePartial: () => Promise.resolve(undefined),
  parseOutput: () => Promise.resolve(undefined),
};

const MESSAGE_MARKER_RE = /<\|message\|>([\s\S]+)$/;
const JSON_FENCE_RE = /^```json\s*\n?([\s\S]*?)\n?\s*```\s*$/;
const JSON_FENCE_START_RE = /^```json\s*\n?/;

/** The last balanced `{...}` in text that does not itself start with JSON. */
function extractLastJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return undefined;
  }
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let last: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (!inString && char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        last = text.slice(start, i + 1);
      }
    }
  }
  return last;
}

const CONTROL_CHAR_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** Escape raw newlines, carriage returns, and tabs inside JSON strings. */
function escapeControlCharsInStrings(text: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      result += char + text[++i];
    } else {
      if (char === '"') {
        inString = !inString;
      }
      result += (inString && CONTROL_CHAR_ESCAPES[char]) || char;
    }
  }
  return result;
}

/** Turn model text into JSON text the way Mastra's object output did. */
function preprocessJsonText(text: string): string {
  let processed = text.match(MESSAGE_MARKER_RE)?.[1] ?? text;
  const trimmedStart = processed.trimStart();
  if (/^```json\b/.test(trimmedStart)) {
    processed =
      trimmedStart.match(JSON_FENCE_RE)?.[1]?.trim() ||
      trimmedStart.replace(JSON_FENCE_START_RE, "");
  }
  return escapeControlCharsInStrings(
    extractLastJsonObject(processed) ?? processed,
  );
}

interface FeaturesStep {
  finishReason: string;
  text: string;
  toolCalls: readonly unknown[];
}

/**
 * Read the structured output with the rules of the Mastra 1.83 agent this
 * code replaced, so results stay the same. Steps with no text, an error, or
 * tool calls are skipped; a step cut off by the length limit or the content
 * filter fails. Otherwise the step's text must match the schema: prose
 * around one JSON object, a ```json fence, and truncated JSON are accepted.
 * The last matching step wins, and no such step means no output.
 */
export async function parseFeaturesOutput(
  steps: readonly FeaturesStep[],
): Promise<z.infer<typeof featuresOutputSchema> | undefined> {
  let output: z.infer<typeof featuresOutputSchema> | undefined;
  for (const { finishReason, text, toolCalls } of steps) {
    const cutOff =
      finishReason === "length" || finishReason === "content-filter";
    if (
      !text.trim() ||
      finishReason === "error" ||
      (toolCalls.length > 0 && !cutOff)
    ) {
      continue;
    }
    if (cutOff) {
      throw new Error(
        `Structured output was truncated because the model finished with reason "${finishReason}".`,
      );
    }
    const { value } = await parsePartialJson(preprocessJsonText(text));
    const parsed = featuresOutputSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `- ${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("\n");
      throw new Error(`Structured output validation failed: ${issues}`);
    }
    output = parsed.data;
  }
  return output;
}

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

/**
 * Resolve lib slugs to canonical Sentry feature slugs.
 *
 * Runs discovery on every call. Feature results are not cached because
 * incomplete discoveries could hide supported features on later runs.
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
        const result = await generateText({
          ...MODEL_SETTINGS,
          experimental_output: featuresOutput,
          model: createNativeModelFallbacks(PRIMARY_MODEL, apiKey),
          prompt: userPrompt,
          stopWhen: stepCountIs(MAX_STEPS),
          system: SYSTEM_PROMPT,
          tools: {
            search_docs: createSearchDocsTool(),
            fetch_doc_page: createFetchDocPageTool(fetchedUrls),
          },
        });
        const output = await parseFeaturesOutput(result.steps);

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

        const rawFeatures = output?.features ?? [];
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
