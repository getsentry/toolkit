import * as Sentry from "@sentry/cloudflare";

async function hashValue(value: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
}

/**
 * Return false when `identifier` is over its limit. Fails open, like
 * `checkRateLimit` in mcp-cloudflare: a missing or broken limiter must not
 * take the leaderboard down.
 */
export async function isWithinRateLimit(
  identifier: string,
  rateLimiter: RateLimit | undefined,
  keyPrefix: string,
): Promise<boolean> {
  if (!rateLimiter) return true;
  try {
    const key = `${keyPrefix}:${await hashValue(identifier)}`;
    const { success } = await rateLimiter.limit({ key });
    return success;
  } catch (error) {
    Sentry.captureException(error);
    return true;
  }
}
