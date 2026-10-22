import { Agent } from "@mastra/core/agent";
import * as Sentry from "@sentry/cloudflare";
import { searchPages } from "../sentry-docs/doctree";
import {
  buildDocsUrl,
  fetchDocPage,
  normalizeDocPath,
} from "../sentry-docs/fetcher";
import {
  cacheGetDocsQuery,
  cachePutDocsQuery,
  type DocsQueryContext,
} from "./cache";
import { createNativeModelFallbacks, PRIMARY_MODEL } from "./model-fallback";
import { createFetchDocPageTool, createSearchDocsTool } from "./tools";

export interface DocsQueryResult {
  answer: string;
  sources: string[];
}

export type { DocsQueryContext } from "./cache";

const QUERY_MAX_OUTPUT_TOKENS = 700;
export const QUERY_MODEL_SETTINGS = {
  maxOutputTokens: QUERY_MAX_OUTPUT_TOKENS,
  maxRetries: 0,
  temperature: 0,
};

const MARKDOWN_LINK_URL_RE = /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g;
// Ignore URL-like values in quoted code strings; only prose URLs need citation
// validation. Markdown link destinations are separately validated above.
const URL_RE = /(?<!['"])https?:\/\/[^\s<>()[\]"']+/g;
const TRAILING_MD_RE = /\.md$/;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?]+$/;
const TRAILING_SLASHES_RE = /\/+$/;
const SOURCES_SECTION_RE = /\n{0,2}## Sources[ \t]*\r?\n[\s\S]*$/i;
const MAX_QUERY_STEPS = 6;

export const QUERY_SYSTEM_PROMPT = `You answer Sentry documentation questions using only current docs.sentry.io pages.

First use search_docs to find relevant pages, then fetch_doc_page for every page you rely on. A successful fetch response includes the canonical URL that you may cite. Give a concise Markdown answer that directly addresses the question: use at most 6 short bullet points and include at most one essential code snippet. Every factual claim must have an inline Markdown citation to a successful fetch response URL, such as [Configure tracing](https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/).

Do not cite URLs you did not fetch. Do not cite non-docs.sentry.io URLs. Do not include a Sources section; the server adds it after validating the fetched URLs.`;

function canonicalizeDocsUrl(value: string): string {
  const url = new URL(value.replace(TRAILING_URL_PUNCTUATION_RE, ""));
  if (url.protocol !== "https:" || url.hostname !== "docs.sentry.io") {
    throw new Error(`Citation URL is not an allowed Sentry docs URL: ${value}`);
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname
    .replace(TRAILING_MD_RE, "")
    .replace(TRAILING_SLASHES_RE, "")
    .concat("/");
  return url.toString();
}

function uniqueCanonicalDocsUrls(urls: readonly string[]): string[] {
  return [...new Set(urls.map(canonicalizeDocsUrl))];
}

/**
 * Enforce the public query contract after an LLM has synthesized an answer.
 *
 * The model may only cite docs pages that its fetch tool actually read. The
 * Sources section is rendered here rather than trusting a model-produced list
 * so human and JSON output always agree on the provenance of the answer.
 */
export function finalizeDocsAnswer(
  answer: string,
  fetchedUrls: readonly string[],
): DocsQueryResult {
  const sources = uniqueCanonicalDocsUrls(fetchedUrls);
  if (sources.length === 0) {
    throw new Error("Docs query returned no fetched sources to cite.");
  }

  const body = answer.replace(SOURCES_SECTION_RE, "").trim();
  const citations = uniqueCanonicalDocsUrls(
    [...body.matchAll(MARKDOWN_LINK_URL_RE)].map((match) => match[1]),
  );
  if (citations.length === 0) {
    throw new Error("Docs query answer must include an inline citation.");
  }

  const emittedUrls = uniqueCanonicalDocsUrls(
    [...body.matchAll(URL_RE)].map((match) => match[0]),
  );
  const fetched = new Set(sources);
  for (const citation of emittedUrls) {
    if (!fetched.has(citation)) {
      throw new Error(`Docs citation was not fetched: ${citation}`);
    }
  }

  return {
    answer: `${body}\n\n## Sources\n\n${sources.map((url) => `- <${url}>`).join("\n")}`,
    sources,
  };
}

function createQueryAgent(
  apiKey: string | undefined,
  fetchedUrls: string[],
): Agent {
  return new Agent({
    defaultOptions: {
      modelSettings: QUERY_MODEL_SETTINGS,
    },
    id: "docs-query-agent",
    instructions: QUERY_SYSTEM_PROMPT,
    model: createNativeModelFallbacks(PRIMARY_MODEL, apiKey),
    name: "Docs Query Agent",
    tools: {
      fetch_doc_page: createFetchDocPageTool(fetchedUrls),
      search_docs: createSearchDocsTool(),
    },
  });
}

function contextPrompt(context: DocsQueryContext | undefined): string {
  const frameworks = context?.frameworks?.join(", ") || "none detected";
  const languages = context?.languages?.join(", ") || "none detected";
  const sentryConfigured = context?.sentryConfigured ? "yes" : "no";
  return `\n\nSafe local project context (metadata only):\n- Frameworks: ${frameworks}\n- Languages: ${languages}\n- Sentry configuration detected: ${sentryConfigured}`;
}

function citationRecoveryPrompt(): string {
  return "\n\nCitation validation rejected the previous draft. Start over: search the docs and fetch every page you cite in this new answer. Do not rely on URLs from the rejected draft.";
}

interface GeneratedDocsAnswer {
  cacheable: boolean;
  citationFallback: boolean;
  citationFallbackReason:
    | "external_host"
    | "no_fetched_sources"
    | "validation_failed"
    | null;
  citationRetries: number;
  finalized: DocsQueryResult;
}

export interface DocsAnswerAttempt {
  fetchedUrls: readonly string[];
  text: string;
}

type FallbackSourceResolver = () => Promise<readonly string[]>;

function noFallbackSources(): Promise<readonly string[]> {
  return Promise.resolve([]);
}

/**
 * Retrieve one current docs page as a last-resort citation source.
 *
 * The source is returned only after a successful fetch, so the fallback
 * remains grounded even when both agent attempts skip or fail their tools.
 */
export async function recoverQueryFallbackSources(
  query: string,
): Promise<readonly string[]> {
  try {
    const [candidate] = await searchPages(query, 1);
    if (!candidate) {
      return [];
    }

    const path = normalizeDocPath(candidate.url);
    await fetchDocPage(path);
    return [buildDocsUrl(path)];
  } catch (error) {
    Sentry.addBreadcrumb({
      category: "docs.citation_recovery",
      level: "warning",
      message: `Failed to retrieve a docs fallback source: ${error instanceof Error ? error.name : "unknown"}`,
    });
    return [];
  }
}

function fallbackToFetchedDocs(
  fetchedUrls: readonly string[],
): DocsQueryResult {
  const [source] = uniqueCanonicalDocsUrls(fetchedUrls);
  if (!source) {
    throw new Error("Docs query returned no fetched sources to cite.");
  }

  return finalizeDocsAnswer(
    "I couldn't produce a fully cited answer for that question. Please refer to " +
      `[the Sentry documentation](${source}).`,
    [source],
  );
}

function fallbackReason(
  error: unknown,
): Exclude<GeneratedDocsAnswer["citationFallbackReason"], null> {
  if (!(error instanceof Error)) {
    return "validation_failed";
  }
  if (
    error.message.startsWith("Citation URL is not an allowed Sentry docs URL")
  ) {
    return "external_host";
  }
  return error.message === "Docs query returned no fetched sources to cite."
    ? "no_fetched_sources"
    : "validation_failed";
}

export async function finalizeCitedAttempts(
  generateAttempt: (retry: boolean) => Promise<DocsAnswerAttempt>,
  resolveFallbackSources: FallbackSourceResolver = noFallbackSources,
): Promise<GeneratedDocsAnswer> {
  const firstAttempt = await generateAttempt(false);
  try {
    return {
      cacheable: true,
      citationFallback: false,
      citationFallbackReason: null,
      citationRetries: 0,
      finalized: finalizeDocsAnswer(
        firstAttempt.text,
        firstAttempt.fetchedUrls,
      ),
    };
  } catch {
    const retryAttempt = await generateAttempt(true);
    try {
      return {
        cacheable: true,
        citationFallback: false,
        citationFallbackReason: null,
        citationRetries: 1,
        finalized: finalizeDocsAnswer(
          retryAttempt.text,
          retryAttempt.fetchedUrls,
        ),
      };
    } catch (retryError) {
      const fallbackSources =
        retryAttempt.fetchedUrls.length > 0
          ? retryAttempt.fetchedUrls
          : await resolveFallbackSources();
      return {
        cacheable: false,
        citationFallback: true,
        citationFallbackReason: fallbackReason(retryError),
        citationRetries: 1,
        finalized: fallbackToFetchedDocs(fallbackSources),
      };
    }
  }
}

function generateCitedAnswer(
  apiKey: string | undefined,
  query: string,
  context: DocsQueryContext | undefined,
): Promise<GeneratedDocsAnswer> {
  return finalizeCitedAttempts(
    async (retry) => {
      const fetchedUrls: string[] = [];
      const result = await createQueryAgent(apiKey, fetchedUrls).generate(
        `Question: ${query.trim()}${contextPrompt(context)}${retry ? citationRecoveryPrompt() : ""}`,
        {
          maxSteps: MAX_QUERY_STEPS,
          prepareStep: ({ stepNumber }) =>
            stepNumber === MAX_QUERY_STEPS - 1 ? { toolChoice: "none" } : {},
        },
      );
      return { fetchedUrls, text: result.text };
    },
    () => recoverQueryFallbackSources(query),
  );
}

/** Run the free-form docs agent and return an answer grounded in fetched pages. */
export async function runQueryAgent(
  apiKey: string | undefined,
  query: string,
  context?: DocsQueryContext,
  docsVersion?: string,
): Promise<DocsQueryResult> {
  const cached = await cacheGetDocsQuery(query, context, docsVersion);
  if (cached) {
    return cached;
  }

  return await Sentry.startSpan(
    {
      attributes: {
        "agent.framework_count": context?.frameworks?.length ?? 0,
        "agent.language_count": context?.languages?.length ?? 0,
        "agent.max_steps": MAX_QUERY_STEPS,
        "agent.model": PRIMARY_MODEL,
      },
      name: "queryAgent",
      op: "docs.agent.query",
    },
    async (span) => {
      try {
        const {
          cacheable,
          citationFallback,
          citationFallbackReason,
          citationRetries,
          finalized,
        } = await generateCitedAnswer(apiKey, query, context);
        span.setAttribute("docs.citation_fallback", citationFallback);
        if (citationFallbackReason) {
          span.setAttribute(
            "docs.citation_fallback_reason",
            citationFallbackReason,
          );
        }
        span.setAttribute("docs.citation_retries", citationRetries);
        span.setAttribute("docs.source_count", finalized.sources.length);
        span.setAttribute("agent.output_chars", finalized.answer.length);
        if (cacheable) {
          try {
            await cachePutDocsQuery(query, context, finalized, docsVersion);
          } catch (error) {
            Sentry.addBreadcrumb({
              category: "docs.cache",
              level: "warning",
              message: `Failed to cache docs query: ${error instanceof Error ? error.name : "unknown"}`,
            });
          }
        }
        return finalized;
      } catch (error) {
        span.setStatus({ code: 2, message: "error" });
        Sentry.captureException(error);
        throw error;
      }
    },
  );
}
