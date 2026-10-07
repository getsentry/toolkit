import { Hono } from "hono";
import { z } from "zod";
import { logWarn } from "@sentry/mcp-core/telem/logging";
import type { Env } from "../types";
import type { RateLimitResult } from "../types/chat";
import { getClientIp } from "../utils/client-ip";
import { annotateResponseMetric } from "../metrics";

export const SNAKE_HANDLE_REGEX = /^[a-z]{2,12}-[a-z]{2,12}-\d{2}$/;
export const MAX_SNAKE_SCORE = 10000;

const SENTRY_HOST = "https://us.sentry.io";
const SENTRY_ORG_SLUG = "sentry";
const SNAKE_PROJECT_ID = "4510776311808000";
const SCORE_FIELD = "max(value,snake.score,distribution,-)";
const HANDLE_FIELD = "tags[handle,string]";
const LEADERBOARD_PERIOD = "30d";
const LEADERBOARD_SIZE = 10;
const UPSTREAM_TIMEOUT_MS = 5000;
const CACHE_KEY = "games:snake:leaderboard:v1";
const CACHE_TTL_SECONDS = 300;

const LeaderboardSchema = z.object({
  period: z.literal(LEADERBOARD_PERIOD),
  entries: z
    .array(
      z.object({
        rank: z.number().int().min(1),
        handle: z.string().regex(SNAKE_HANDLE_REGEX),
        score: z.number().int().min(1).max(MAX_SNAKE_SCORE),
      }),
    )
    .max(LEADERBOARD_SIZE),
});

type Leaderboard = z.infer<typeof LeaderboardSchema>;

const UpstreamSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});

class UpstreamError extends Error {
  constructor(readonly status?: number) {
    super("Snake leaderboard upstream failed");
  }
}

// Failure details are deliberately dropped: errors may carry the upstream
// URL, headers or body.
function logUpstreamFailure(status?: number) {
  logWarn("Snake leaderboard upstream failed", {
    loggerScope: ["cloudflare", "games"],
    extra: { status: status ?? null },
  });
}

function buildUpstreamUrl(): string {
  const params = new URLSearchParams();
  params.set("dataset", "tracemetrics");
  params.set("project", SNAKE_PROJECT_ID);
  params.append("field", HANDLE_FIELD);
  params.append("field", SCORE_FIELD);
  params.set(
    "query",
    `metric.name:snake.score metric.type:distribution value:<=${MAX_SNAKE_SCORE}`,
  );
  params.set("statsPeriod", LEADERBOARD_PERIOD);
  params.set("sort", `-${SCORE_FIELD}`);
  params.set("per_page", "50");
  return `${SENTRY_HOST}/api/0/organizations/${SENTRY_ORG_SLUG}/events/?${params.toString()}`;
}

async function fetchLeaderboard(token: string): Promise<Leaderboard> {
  let response: Response;
  try {
    response = await fetch(buildUpstreamUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamError();
  }
  if (!response.ok) {
    throw new UpstreamError(response.status);
  }

  let parsed: z.infer<typeof UpstreamSchema>;
  try {
    const result = UpstreamSchema.safeParse(await response.json());
    if (!result.success) throw new UpstreamError(response.status);
    parsed = result.data;
  } catch {
    throw new UpstreamError(response.status);
  }

  const seen = new Set<string>();
  const entries: Leaderboard["entries"] = [];
  for (const row of parsed.data) {
    const handle = row[HANDLE_FIELD];
    const rawScore = row[SCORE_FIELD];
    if (typeof handle !== "string" || !SNAKE_HANDLE_REGEX.test(handle)) {
      continue;
    }
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) continue;
    const score = Math.floor(rawScore);
    if (score < 1 || score > MAX_SNAKE_SCORE) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    entries.push({ rank: entries.length + 1, handle, score });
    if (entries.length === LEADERBOARD_SIZE) break;
  }

  return { period: LEADERBOARD_PERIOD, entries };
}

async function readCache(kv: KVNamespace): Promise<Leaderboard | null> {
  try {
    const cached = await kv.get(CACHE_KEY, "json");
    if (cached === null) return null;
    const result = LeaderboardSchema.safeParse(cached);
    return result.success ? result.data : null;
  } catch {
    logWarn("Snake leaderboard cache read failed", {
      loggerScope: ["cloudflare", "games"],
    });
    return null;
  }
}

async function writeCache(kv: KVNamespace, value: Leaderboard) {
  try {
    await kv.put(CACHE_KEY, JSON.stringify(value), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch {
    logWarn("Snake leaderboard cache write failed", {
      loggerScope: ["cloudflare", "games"],
    });
  }
}

const CACHE_CONTROL = "public, max-age=60";

export default new Hono<{ Bindings: Env }>().get(
  "/snake/leaderboard",
  async (c) => {
    const clientIP = getClientIp(c.req.raw);

    // The rate limiter binding is optional; it is absent in local development.
    if (c.env.GAMES_RATE_LIMITER && clientIP) {
      try {
        const hashBuffer = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(clientIP),
        );
        const hashHex = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const { success }: RateLimitResult =
          await c.env.GAMES_RATE_LIMITER.limit({
            key: `games:ip:${hashHex.substring(0, 16)}`,
          });
        if (!success) {
          return annotateResponseMetric(
            c.json({ error: "Too many requests" }, 429),
            { responseReason: "local_rate_limit", rateLimitScope: "ip" },
          );
        }
      } catch {
        logWarn("Snake leaderboard rate limiter failed", {
          loggerScope: ["cloudflare", "games"],
        });
        return c.json({ error: "Leaderboard unavailable" }, 503);
      }
    }

    const token = c.env.SENTRY_GAMES_READ_TOKEN;
    if (!token) {
      return c.json({ error: "Leaderboard unavailable" }, 503);
    }

    const cached = c.env.MCP_CACHE ? await readCache(c.env.MCP_CACHE) : null;
    if (cached) {
      return c.json(cached, 200, { "Cache-Control": CACHE_CONTROL });
    }

    let leaderboard: Leaderboard;
    try {
      leaderboard = await fetchLeaderboard(token);
    } catch (error) {
      logUpstreamFailure(
        error instanceof UpstreamError ? error.status : undefined,
      );
      return c.json({ error: "Leaderboard unavailable" }, 502);
    }

    if (c.env.MCP_CACHE) await writeCache(c.env.MCP_CACHE, leaderboard);
    return c.json(leaderboard, 200, { "Cache-Control": CACHE_CONTROL });
  },
);
