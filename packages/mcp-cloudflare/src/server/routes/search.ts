import { Hono } from "hono";
import type { Env } from "../types";
import { logIssue } from "@sentry/mcp-core/telem/logging";
import { SENTRY_GUIDES } from "@sentry/mcp-core/constants";
import { z } from "zod";
import type { RateLimitResult } from "../types/chat";
import type {
  AutoRagSearchResponse,
  ComparisonFilter,
  CompoundFilter,
  AutoRagSearchRequest,
} from "@cloudflare/workers-types";
import { logger } from "@sentry/cloudflare";
import { getClientIp } from "../utils/client-ip";
import { annotateResponseMetric } from "../metrics";

// Request schema matching the MCP tool parameters
const SearchRequestSchema = z.object({
  query: z.string().trim().min(1, "Query is required"),
  maxResults: z.number().int().min(1).max(10).default(10).optional(),
  guide: z.enum(SENTRY_GUIDES).optional(),
});

export default new Hono<{ Bindings: Env }>().post("/", async (c) => {
  try {
    // Get client IP address
    const clientIP = getClientIp(c.req.raw);

    // Rate limiting check - use client IP as the key
    // In local development or when IP can't be extracted, skip rate limiting
    // Rate limiter is optional and primarily for production abuse prevention
    // Note: Rate limiting bindings are "unsafe" (beta) and may not be available in development
    // so we check if the binding exists before using it
    // https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
    if (c.env.SEARCH_RATE_LIMITER && clientIP) {
      try {
        // Hash the IP for privacy and consistent key format
        const encoder = new TextEncoder();
        const data = encoder.encode(clientIP);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = [...new Uint8Array(hashBuffer)];
        const hashHex = hashArray
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const rateLimitKey = `search:ip:${hashHex.substring(0, 16)}`; // Use first 16 chars of hash

        const { success }: RateLimitResult =
          await c.env.SEARCH_RATE_LIMITER.limit({
            key: rateLimitKey,
          });
        if (!success) {
          return annotateResponseMetric(
            c.json(
              {
                error:
                  "Rate limit exceeded. You can perform up to 20 documentation searches per minute. Please wait before searching again.",
                name: "RATE_LIMIT_EXCEEDED",
              },
              429,
            ),
            {
              responseReason: "local_rate_limit",
              rateLimitScope: "ip",
            },
          );
        }
      } catch (error) {
        const eventId = logIssue(error);
        return c.json(
          {
            error: "There was an error communicating with the rate limiter.",
            name: "RATE_LIMITER_ERROR",
            eventId,
          },
          500,
        );
      }
    }

    // Parse and validate request body
    const body = await c.req.json();
    const validationResult = SearchRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request",
          details: validationResult.error.issues,
        },
        400,
      );
    }

    const { query, maxResults = 10, guide } = validationResult.data;

    // Check if AI binding is available
    if (!c.env.AI) {
      return c.json(
        {
          error: "AI service not available",
          name: "AI_SERVICE_UNAVAILABLE",
        },
        503,
      );
    }

    try {
      const autoragId = c.env.AUTORAG_INDEX_NAME || "sentry-docs";

      // Construct AutoRAG search parameters
      const searchParams: AutoRagSearchRequest = {
        query,
        max_num_results: maxResults,
        ranking_options: {
          score_threshold: 0.2,
        },
      };

      // Add filename filters based on guide parameter
      // TODO: This is a hack to get the guide to work. Currently 'filename' is not working
      // with folder matching which means we're lacking guideName.md in the search results.
      if (guide) {
        let filter: ComparisonFilter | CompoundFilter;

        if (guide.includes("/")) {
          // Platform/guide combination: platforms/[platform]/guides/[guide]
          const [platformName, guideName] = guide.split("/", 2);

          filter = {
            type: "and",
            filters: [
              {
                type: "gte",
                key: "folder",
                value: `platforms/${platformName}/guides/${guideName}/`,
              },
              {
                type: "lte",
                key: "folder",
                value: `platforms/${platformName}/guides/${guideName}/z`,
              },
            ],
          };
        } else {
          // Just platform: platforms/[platform]/ - use range filter
          filter = {
            type: "and",
            filters: [
              {
                type: "gte",
                key: "folder",
                value: `platforms/${guide}/`,
              },
              {
                type: "lte",
                key: "folder",
                value: `platforms/${guide}/z`,
              },
            ],
          };
        }

        searchParams.filters = filter;
      }

      const searchResult =
        await c.env.AI.autorag(autoragId).search(searchParams);

      // Process search results - handle the actual response format from Cloudflare AI
      const searchData = searchResult as AutoRagSearchResponse;

      if (searchData.data?.length === 0) {
        logger.warn(
          logger.fmt`No results found for query: ${query} with guide: ${guide}`,
          {
            result_query: searchData.search_query,
            guide,
            searchParams: JSON.stringify(searchParams),
          },
        );
      }

      return c.json({
        query,
        results:
          searchData.data?.map((result) => {
            // Extract text from content array
            const text = result.content?.[0]?.text || "";

            // Get filename from result - ensure it's a string
            const rawFilename =
              result.filename || result.attributes?.filename || "";
            const filename =
              typeof rawFilename === "string"
                ? rawFilename
                : String(rawFilename);

            // Build URL from filename - remove .md extension
            const urlPath = filename.replace(/\.md$/, "");
            const url = urlPath ? `https://docs.sentry.io/${urlPath}` : "";

            return {
              id: filename,
              url: url,
              snippet: text,
              relevance: result.score || 0,
            };
          }) || [],
      });
    } catch (error) {
      const eventId = logIssue(error);
      return c.json(
        {
          error: "Failed to search documentation. Please try again later.",
          name: "SEARCH_FAILED",
          eventId,
        },
        500,
      );
    }
  } catch (error) {
    const eventId = logIssue(error);
    return c.json(
      {
        error: "Internal server error",
        name: "INTERNAL_ERROR",
        eventId,
      },
      500,
    );
  }
});
