import { Agent } from "@mastra/core/agent";
import * as Sentry from "@sentry/cloudflare";
import {
  trackAgentCall,
  trackAgentFallbackSynthesis,
  trackAgentSteps,
  trackAgentTokens,
} from "../metrics";
import { findPagesForLibsFeatures } from "../sentry-docs/doctree";
import { createNativeModelFallbacks, PRIMARY_MODEL } from "./model-fallback";
import { createFetchDocPageTool, createSearchDocsTool } from "./tools";

/**
 * Maximum tool-call steps the agent can take before forced stop.
 *
 * 10 leaves room for ~8-9 tool steps (seed fetches + additional discovery)
 * + 1 forced synthesis step. The last step is gated by `prepareStep` to
 * disallow tools so the model is guaranteed to produce a final text response.
 *
 * Wall-clock: ~10 × 15–20s = ~150–200s for complex stacks (iOS + many
 * features). The CF Workers 30s limit is CPU time — async LLM calls don't
 * count against it, so wall-clock can be much longer. The real constraint
 * is the MCP client timeout set by the caller (getsentry/cli-init-api/apps/server/src/mastra/lib/
 * docs-mcp-client.ts).
 */
const MAX_STEPS = 10;

/**
 * Match the temperature used by all server-side workflow agents
 * (getsentry/cli-init-api/apps/server/src/mastra/agents/default-options.ts). Determinism
 * makes synthesis output stable across repeat runs and easier to debug.
 */
const TEMPERATURE = 0;
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

const SYSTEM_PROMPT = `You are a Sentry integration documentation specialist.

Your job is to produce a single, coherent Markdown guide that walks a developer through integrating Sentry into THEIR specific stack with THEIR selected features. The output is consumed by another agent that generates code modifications, so it must be precise, complete, and reflect the current SDK API exactly.

You have two tools at your disposal:
- search_docs(query): finds relevant pages on docs.sentry.io. Use it when you need to discover a page (e.g. "celery integration", "session replay privacy").
- fetch_doc_page(path): fetches the full Markdown of a docs.sentry.io page. Use it whenever you need the actual content.

WORKFLOW
1. The user prompt will list the libraries (libs) and selected features. A SEED SET of likely doc paths will be pre-loaded for you — START by fetching those in parallel. The seed set includes install/ and manual-setup/ sub-pages for each lib (the two patterns Sentry platforms use for package installation instructions). In that same parallel step, also call search_docs("<lib> install") for each lib — this catches platforms that embed install instructions in their root index rather than a dedicated sub-page (e.g. Python, Ruby, Go).
2. When you need multiple pages, call fetch_doc_page in PARALLEL within one step rather than sequentially. Claude supports parallel tool calls and step budget is limited.
3. If the seed set is incomplete (e.g. an unmapped lib or feature), use search_docs to discover the right pages, then fetch_doc_page on the best matches.
3b. If a "Project stack" is provided in the user prompt, use search_docs to find integration pages for any notable 3rd-party libraries mentioned that aren't already in the seed set (e.g. if the stack mentions "@supabase/supabase-js", call search_docs("supabase") and fetch the most relevant integration page). Do this in the same parallel step as the seed fetches.
4. Read carefully and synthesize — DO NOT just concatenate raw doc content. Merge getting-started + per-feature config into a single coherent setup that initializes the SDK once and configures all selected features together.
5. Preserve EXACT API signatures, import paths, file names, configuration keys, AND package install commands from the docs. Do not invent any of these from training data — including package manager commands. If you reach the ## Installation section without a confirmed install page, call search_docs("<lib> install") or search_docs("<lib> setup") before writing it.

OUTPUT FORMAT
Return Markdown with this structure:

\`\`\`
# Sentry Integration: <Primary Lib>

## Overview
<1-2 sentence summary of what's being set up>

## Installation
<package install commands for selected stack>

## Configuration
<a SINGLE Sentry.init / SDK initialization block that includes ALL selected features>

## Feature Setup
### <Feature Name>
<any feature-specific setup beyond the init block — e.g. error boundaries, server middleware, source map upload>

(repeat per feature)

## Notes
<framework-specific gotchas, required headers (e.g. Document-Policy for browser profiling), env vars, etc.>
\`\`\`

CRITICAL RULES
- Only include features that are explicitly in the selected features list. Don't enable extras "for completeness".
- Use the file paths and code patterns from the docs verbatim. If the docs say to put SDK init in \`instrumentation.ts\`, do not call it \`sentry.config.ts\`.
- Keep code blocks copy-pasteable. Prefer one well-commented init block over multiple snippets that have to be merged.
- Cite source URLs at the bottom under "## Sources" so the downstream agent (and the developer) can verify.

PLACEHOLDERS AND MARKERS (preserve verbatim from the docs)
The Sentry docs occasionally embed placeholders that the downstream codemod-planner agent replaces with real values. If you encounter any of these in the source docs, leave them EXACTLY as-is in your output:
- ___PUBLIC_DSN___    (replaced with the project's DSN)
- ___ORG_SLUG___      (replaced with the Sentry org slug)
- ___PROJECT_SLUG___  (replaced with the Sentry project slug)
- ___PRODUCT_OPTION_START___ <feature> ... ___PRODUCT_OPTION_END___ <feature>
  (feature-gated config blocks; only emit the inner code if <feature> is in the selected features list)

The known feature names inside ___PRODUCT_OPTION_*___ markers are: performance, session-replay, user-feedback, logs. Map them to the selected feature slugs as follows: performance→tracing, session-replay→session-replay, user-feedback→user-feedback, logs→logs. Never include the marker comment lines themselves in your output.`;

/** Final-step instruction sent during the fallback synthesis pass. */
const FALLBACK_SYNTHESIS_INSTRUCTION =
  "You have gathered enough context. Now produce the final tailored guide as Markdown, following the OUTPUT FORMAT in the system prompt. Do not call any tools.";

interface SpanAttributeWriter {
  setAttribute: (name: string, value: number | string) => unknown;
}

export function setSynthesizedMarkdownAttributes(
  span: SpanAttributeWriter,
  markdown: string,
): void {
  // Keep the complete synthesized guide in Sentry so a wizard run can
  // be audited without relying on the transient MCP response body.
  // Intentionally do not truncate this attribute.
  span.setAttribute("docs.synthesized_markdown", markdown);
  span.setAttribute("docs.synthesized_markdown_chars", markdown.length);
}

function createTailorAgent(apiKey: string | undefined, fetchedUrls: string[]) {
  return new Agent({
    id: "docs-tailor-agent",
    name: "Docs Tailor Agent",
    instructions: SYSTEM_PROMPT,
    defaultOptions: AGENT_DEFAULT_OPTIONS,
    model: createNativeModelFallbacks(PRIMARY_MODEL, apiKey),
    tools: {
      search_docs: createSearchDocsTool(),
      fetch_doc_page: createFetchDocPageTool(fetchedUrls),
    },
  });
}

// ── Agent entry point ───────────────────────────────────────────────

/**
 * Run the docs tailoring agent for a (libs, features) combo.
 *
 * Returns a single Markdown string the codemod-planner can consume.
 *
 * Step-budget protection:
 * - `prepareStep` forces `toolChoice: 'none'` on the last step so the
 *   model is guaranteed to produce a text response even if it would
 *   otherwise have called another tool.
 * - If `result.text` still comes back empty (rare — e.g. model refused),
 *   a fallback `generateText` call without tools is run with the prior
 *   message history to coerce a final synthesis from the accumulated
 *   tool-call context.
 */
export async function runTailorAgent(
  apiKey: string | undefined,
  libs: string[],
  features: string[],
  stackSummary?: string,
): Promise<string> {
  return await Sentry.startSpan(
    {
      op: "docs.agent.tailor",
      name: "tailorAgent",
      attributes: {
        "agent.libs": libs.join(","),
        "agent.features": features.join(","),
        "agent.model": PRIMARY_MODEL,
        "agent.max_steps": MAX_STEPS,
      },
    },
    async (span) => {
      const fetchedUrls: string[] = [];
      const seedPaths = findPagesForLibsFeatures(libs, features);
      span.setAttribute("agent.seed_paths_count", seedPaths.length);

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

      const seedSection =
        seedPaths.length > 0
          ? `Seed paths (start by fetching these — call fetch_doc_page for all of them in parallel within a single step):\n${seedPaths.map((p) => `- ${p}`).join("\n")}`
          : "No seed paths matched. Use search_docs to find the right pages.";

      const stackLine = stackSummary ? `\nProject stack: ${stackSummary}` : "";

      const userPrompt = `Libraries: ${libs.join(", ")}
Selected features: ${features.join(", ") || "(none — produce the base getting-started guide only)"}${stackLine}

${seedSection}

Produce the tailored integration guide.`;

      try {
        const agent = createTailorAgent(apiKey, fetchedUrls);
        const result = await agent.generate(userPrompt, {
          maxSteps: MAX_STEPS,
          // Force a tool-free synthesis on the final step so the loop
          // never terminates with tool-calls and no text.
          prepareStep: ({ stepNumber }) => {
            if (stepNumber === MAX_STEPS - 1) {
              return { toolChoice: "none" };
            }
            return {};
          },
        });

        const inputTokens = result.totalUsage?.inputTokens ?? 0;
        const outputTokens = result.totalUsage?.outputTokens ?? 0;
        const stepCount = result.steps?.length ?? 0;
        const usedModelId = getUsedModelId(result);

        span.setAttribute("agent.model", usedModelId);
        span.setAttribute("agent.tokens.input", inputTokens);
        span.setAttribute("agent.tokens.output", outputTokens);
        span.setAttribute("agent.steps", stepCount);
        span.setAttribute("agent.output_chars", result.text.length);

        trackAgentTokens(inputTokens, outputTokens);
        trackAgentSteps(stepCount);

        // Primary path produced text — short-circuit and return.
        if (result.text && result.text.trim().length > 0) {
          trackAgentCall(true);
          setSynthesizedMarkdownAttributes(span, result.text);
          setUrlAttrs();
          return result.text;
        }

        // Fallback synthesis pass: the primary call exited without text
        // (e.g. step limit hit despite prepareStep, or model refusal).
        // Replay the accumulated tool-call history with no tools and a
        // direct instruction to produce the final guide.
        Sentry.addBreadcrumb({
          category: "docs.agent.tailor",
          message:
            "Primary call produced empty text — running fallback synthesis pass",
          level: "warning",
        });
        trackAgentFallbackSynthesis();
        span.setAttribute("agent.fallback_synthesis", true);

        const fallback = await agent.generate(
          [
            ...(result.response.messages ?? []),
            { role: "user", content: FALLBACK_SYNTHESIS_INSTRUCTION },
          ],
          {
            maxSteps: 1,
            toolChoice: "none",
          },
        );

        const fbInputTokens = fallback.totalUsage?.inputTokens ?? 0;
        const fbOutputTokens = fallback.totalUsage?.outputTokens ?? 0;
        const fallbackModelId = getUsedModelId(fallback);

        span.setAttribute("agent.model", fallbackModelId);
        span.setAttribute("agent.fallback.tokens.input", fbInputTokens);
        span.setAttribute("agent.fallback.tokens.output", fbOutputTokens);
        trackAgentTokens(fbInputTokens, fbOutputTokens);

        if (!fallback.text || fallback.text.trim().length === 0) {
          throw new Error(
            "Agent returned empty output even after fallback synthesis pass.",
          );
        }

        trackAgentCall(true);
        setSynthesizedMarkdownAttributes(span, fallback.text);
        setUrlAttrs();
        return fallback.text;
      } catch (err) {
        span.setStatus({ code: 2, message: "error" });
        Sentry.captureException(err);
        trackAgentCall(false);
        setUrlAttrs();
        throw err;
      }
    },
  );
}
