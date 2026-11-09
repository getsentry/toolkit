import type { RateLimit } from "@cloudflare/workers-types";
import { logError } from "@sentry/mcp-core/telem/logging";

export const MCP_RATE_LIMIT_EXCEEDED_MESSAGE =
  "Rate limit exceeded. Please wait before trying again.";

/**
 * Result from rate limit check
 */
export interface RateLimitCheckResult {
  /**
   * Whether the request is allowed
   */
  allowed: boolean;

  /**
   * Error message if rate limited (only present when allowed=false)
   */
  errorMessage?: string;
}

/**
 * Hash a string using SHA-256 for privacy-preserving rate limit keys
 *
 * @param value - The value to hash (e.g., IP address, access token)
 * @returns Hex-encoded SHA-256 hash (first 16 characters)
 */
async function hashValue(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = [...new Uint8Array(hashBuffer)];
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.substring(0, 16); // Use first 16 chars of hash
}

/**
 * Check rate limit for a given identifier
 *
 * @param identifier - The identifier to rate limit (e.g., IP address, user ID)
 * @param rateLimiter - The Cloudflare rate limiter binding
 * @param options - Configuration options
 * @returns Result indicating whether the request is allowed
 *
 * @example
 * ```typescript
 * const result = await checkRateLimit(
 *   clientIP,
 *   env.MCP_IP_RATE_LIMITER,
 *   {
 *     keyPrefix: "mcp:ip",
 *     errorMessage: MCP_RATE_LIMIT_EXCEEDED_MESSAGE
 *   }
 * );
 *
 * if (!result.allowed) {
 *   return new Response(result.errorMessage, { status: 429 });
 * }
 * ```
 */
export async function checkRateLimit(
  identifier: string,
  rateLimiter: RateLimit | undefined,
  options: {
    /**
     * Prefix for the rate limit key (e.g., "mcp:ip", "chat:user")
     */
    keyPrefix: string;

    /**
     * Error message to return when rate limited
     */
    errorMessage: string;
  },
): Promise<RateLimitCheckResult> {
  // If rate limiter binding is not available (e.g., in development),
  // allow the request to proceed
  if (!rateLimiter) {
    return { allowed: true };
  }

  try {
    // Hash the identifier for privacy
    const hashedIdentifier = await hashValue(identifier);
    const rateLimitKey = `${options.keyPrefix}:${hashedIdentifier}`;

    // Check rate limit
    const { success } = await rateLimiter.limit({ key: rateLimitKey });

    if (!success) {
      return {
        allowed: false,
        errorMessage: options.errorMessage,
      };
    }

    return { allowed: true };
  } catch (error) {
    // If rate limiter fails, log error but allow request to proceed
    // This prevents rate limiter issues from breaking the service
    logError(error, {
      loggerScope: ["cloudflare", "rate-limiter"],
      extra: {
        message: "Rate limiter error",
        keyPrefix: options.keyPrefix,
      },
    });
    return { allowed: true };
  }
}
