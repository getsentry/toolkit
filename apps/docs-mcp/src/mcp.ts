import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Sentry from "@sentry/cloudflare";
import { type ZodRawShape, z } from "zod";
import { runFeaturesAgent } from "./agent/features-agent";
import { runTailorAgent } from "./agent/tailor-agent";
import {
  executeDocsQuery,
  executeDocsSearch,
  type QueryDocsInput,
  queryDocsInputSchema,
  searchDocsInputSchema,
} from "./internal-api";
import { trackToolCall, trackToolDuration } from "./metrics";
import { getDoctree } from "./sentry-docs/doctree";

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a JSON error envelope in the MCP `text` content shape. */
function errorEnvelope(message: string) {
  return {
    content: [
      {
        text: JSON.stringify({ error: message }),
        type: "text" as const,
      },
    ],
    isError: true,
  };
}

/** Wrap an error into a human-readable single-line message. */
function errorMessage(prefix: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${detail}`;
}

/** Span attribute values are restricted to primitives. */
type SpanAttrs = Record<string, string | number | boolean>;

interface AgentToolConfig<TInput, TAgentResult> {
  /** Long-form description shown to MCP clients. */
  description: string;
  /** Prefix used in user-facing error messages, e.g. "Failed to list features". */
  errorPrefix: string;
  /** Zod input shape passed straight to MCP. */
  inputSchema: ZodRawShape;
  /** MCP tool name, also used as the metric label. */
  name: string;
  /**
   * Run the agent. Receives the validated input and the worker's OpenRouter
   * API key. Returns whatever native shape the agent produces (string, array, etc.).
   */
  run: (input: TInput, apiKey: string | undefined) => Promise<TAgentResult>;
  /**
   * Convert the agent's native result into the MCP text payload.
   * Public MCP input/output recording is handled by Sentry's MCP wrapper.
   */
  serializeOutput: (result: TAgentResult) => string;
  /** Non-overlapping custom span attributes not captured by MCP input/output recording. */
  spanAttributes?: (result: TAgentResult) => SpanAttrs;
  /** Human-readable title shown to MCP clients. */
  title: string;
}

/**
 * Register an MCP tool that delegates to a Mastra-backed agent.
 *
 * Relies on `wrapMcpServerWithSentry` for MCP input/output spans, then
 * handles shared app concerns: wall-clock duration metrics, exception
 * capture, and the standard MCP `{ content: [{ type: "text", text }] }`
 * shape on success or a JSON error envelope on failure.
 *
 * The closure captures the OpenRouter API key so each tool registration
 * can short-circuit with a clear error message when it is missing instead
 * of letting the agent fail downstream.
 */
function registerAgentTool<TInput, TAgentResult>(
  mcp: McpServer,
  apiKey: string | undefined,
  config: AgentToolConfig<TInput, TAgentResult>,
): void {
  mcp.registerTool(
    config.name,
    {
      description: config.description,
      inputSchema: config.inputSchema,
      title: config.title,
    },
    async (input: unknown) => {
      const typedInput = input as TInput;
      const start = Date.now();

      // Eagerly warm the doctree cache so it's likely ready when the agent
      // calls search_docs. Errors are swallowed — the agent will retry.
      getDoctree().catch(() => {
        // swallow
      });

      try {
        if (!apiKey) {
          throw new Error("Set OPENROUTER_API_KEY on the docs-mcp worker");
        }

        const result = await config.run(typedInput, apiKey);
        const text = config.serializeOutput(result);
        const durationMs = Date.now() - start;
        const span = Sentry.getActiveSpan();

        for (const [k, v] of Object.entries(
          config.spanAttributes?.(result) ?? {},
        )) {
          span?.setAttribute(k, v);
        }
        trackToolCall(config.name, true);
        trackToolDuration(config.name, durationMs);

        return {
          content: [
            {
              text,
              type: "text" as const,
            },
          ],
        };
      } catch (err) {
        Sentry.getActiveSpan()?.setStatus({ code: 2, message: "error" });
        Sentry.captureException(err);
        const durationMs = Date.now() - start;
        const message = errorMessage(config.errorPrefix, err);
        trackToolCall(config.name, false);
        trackToolDuration(config.name, durationMs);
        return errorEnvelope(message);
      }
    },
  );
}

// ── MCP Server ──────────────────────────────────────────────────────

/**
 * Build the MCP server.
 *
 * An OpenRouter API key is required at call time — each tool invocation
 * throws a clear error if it is missing. The Mastra-backed tools route both
 * their primary and fallback models through OpenRouter.
 */
export function createMcpServer(
  apiKey: string | undefined,
  docsVersion?: string,
) {
  const mcp = Sentry.wrapMcpServerWithSentry(
    new McpServer({
      description:
        "Generates tailored Sentry integration docs by reading docs.sentry.io.",
      name: "sentry-docs",
      version: "1.0.0",
    }),
    {
      recordInputs: true,
      recordOutputs: true,
    },
  );

  // ── get-available-features ───────────────────────────────────────

  registerAgentTool<{ libs: string[] }, string[]>(mcp, apiKey, {
    description:
      "Given the libraries/frameworks in the user's codebase, returns the canonical Sentry feature slugs available for that platform. " +
      "Pass library slugs like 'nextjs', 'django', 'go', 'react', 'ruby', 'flutter', etc. " +
      "Runs an LLM agent on each call to inspect docs.sentry.io.",
    errorPrefix: "Failed to list features",
    inputSchema: {
      libs: z
        .array(z.string())
        .describe("Library/framework slugs from the user's codebase"),
    },
    name: "get-available-features",
    run: ({ libs }, key) => runFeaturesAgent(key, libs),
    serializeOutput: (features) => JSON.stringify({ features }),
    spanAttributes: (features) => ({ "agent.feature_count": features.length }),
    title: "Get Available Features",
  });

  // ── search-docs ─────────────────────────────────────────────────

  mcp.registerTool(
    "search-docs",
    {
      description:
        "Search the public Sentry docs index. Returns deterministic ranked page titles, descriptions, and canonical URLs without invoking an LLM.",
      inputSchema: searchDocsInputSchema.shape,
      title: "Search Sentry Docs",
    },
    async ({ limit, query }) => {
      const start = Date.now();
      try {
        const result = await executeDocsSearch({ limit, query });
        trackToolCall("search-docs", true);
        trackToolDuration("search-docs", Date.now() - start);
        return {
          content: [
            {
              text: JSON.stringify(result),
              type: "text" as const,
            },
          ],
        };
      } catch (error) {
        Sentry.captureException(error);
        trackToolCall("search-docs", false);
        trackToolDuration("search-docs", Date.now() - start);
        return errorEnvelope(errorMessage("Failed to search docs", error));
      }
    },
  );

  // ── query-docs ──────────────────────────────────────────────────

  registerAgentTool<QueryDocsInput, { answer: string; sources: string[] }>(
    mcp,
    apiKey,
    {
      description:
        "Answer a free-form Sentry documentation question using fetched docs.sentry.io pages. The result contains a cited Markdown answer and its validated source URLs.",
      errorPrefix: "Failed to answer docs question",
      inputSchema: queryDocsInputSchema.shape,
      name: "query-docs",
      run: (input, key) => executeDocsQuery(key, input, docsVersion),
      serializeOutput: (result) => JSON.stringify(result),
      spanAttributes: (result) => ({
        "docs.source_count": result.sources.length,
      }),
      title: "Query Sentry Docs",
    },
  );

  // ── get-docs ─────────────────────────────────────────────────────

  registerAgentTool<
    { features: string[]; libs: string[]; stackSummary?: string },
    string
  >(mcp, apiKey, {
    description:
      "Returns a tailored Sentry integration guide synthesized by an LLM agent " +
      "from the live docs.sentry.io content. The output is a single coherent " +
      "Markdown guide that integrates the user's selected features into one setup.",
    errorPrefix: "Failed to tailor docs",
    inputSchema: {
      features: z
        .array(z.string())
        .describe("Feature slugs to include (from get-available-features)"),
      libs: z
        .array(z.string())
        .describe("Library/framework slugs from the user's codebase"),
      stackSummary: z
        .string()
        .optional()
        .describe(
          "Natural-language description of the project's tech stack for this context. Used to discover relevant integration docs beyond the base platform guide.",
        ),
    },
    name: "get-docs",
    run: ({ features, libs, stackSummary }, key) =>
      runTailorAgent(key, libs, features, stackSummary),
    serializeOutput: (docs) => docs,
    spanAttributes: (docs) => ({ "docs.output_chars": docs.length }),
    title: "Get Sentry Integration Docs",
  });

  return mcp;
}
