import type { Constraints } from "@sentry/mcp-core/types";
import { SentryApiService, ApiError } from "@sentry/mcp-core/api-client";
import {
  ConstraintLookupTimeoutError,
  lookupConstraints,
} from "@sentry/mcp-core/constraint-lookup";
import { logIssue, logWarn } from "@sentry/mcp-core/telem/logging";

// Timeout for fetching project capabilities (5 seconds)
const CAPABILITIES_TIMEOUT_MS = 5000;

// Cache configuration
const CACHE_TTL_SECONDS = 900; // 15 minutes
const PROJECT_TIMEOUT_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_VERSION = "v1";

/**
 * `ProjectCapabilities | null`, derived from `Constraints` instead of written
 * as a union: root lint runs before `@sentry/mcp-core` is built, and an
 * unresolved type in a union trips `no-redundant-type-constituents`.
 */
type NullableProjectCapabilities = Exclude<
  Constraints["projectCapabilities"],
  undefined
>;

/**
 * Cached constraints data stored in KV.
 */
export type CachedConstraints = {
  regionUrl: string | null;
  /** Null for org-only entries or a project verification timeout. */
  projectCapabilities: NullableProjectCapabilities;
  cachedAt: number;
};

/**
 * Options for caching constraints verification results.
 */
export type CacheOptions = {
  kv: KVNamespace;
  userId: string;
  waitUntil: (promise: Promise<void>) => void;
};

/**
 * Build a cache key for constraints verification.
 * Format: caps:v1:{userId}:{sentryHost}:{organizationSlug}:{scopeKey}
 * scopeKey is "org" for org-only entries or "project:{slug}" for project-scoped entries.
 * Timeouts use a separate timeout:{cacheKey} so late writes cannot overwrite verified data.
 */
function buildCacheKey(
  userId: string,
  sentryHost: string,
  organizationSlug: string,
  projectSlug: string | null | undefined,
): string {
  const normalizedProjectSlug = projectSlug?.trim();
  const scopeKey = normalizedProjectSlug
    ? `project:${normalizedProjectSlug}`
    : "org";
  return `caps:${CACHE_KEY_VERSION}:${userId}:${sentryHost}:${organizationSlug}:${scopeKey}`;
}

/**
 * Attempt to retrieve cached constraints from KV.
 * Returns null on cache miss or any error (fail-open).
 */
async function getCachedConstraints(
  kv: KVNamespace,
  key: string,
): Promise<CachedConstraints | null> {
  try {
    return await kv.get<CachedConstraints>(key, "json");
  } catch (error) {
    logWarn("Failed to read constraints cache", {
      loggerScope: ["cloudflare", "constraint-utils"],
      extra: { key, error: String(error) },
    });
    return null;
  }
}

/**
 * Store constraints in KV cache.
 * Registered with waitUntil by the caller; write errors do not fail requests.
 */
async function setCachedConstraints(
  kv: KVNamespace,
  key: string,
  data: CachedConstraints,
  ttlSeconds: number,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(data), {
      expirationTtl: ttlSeconds,
    });
  } catch (error) {
    logWarn("Failed to write constraints cache", {
      loggerScope: ["cloudflare", "constraint-utils"],
      extra: { key, error: String(error) },
    });
  }
}

/**
 * Verify that provided org/project constraints exist and the user has access
 * by querying Sentry's API using the provided OAuth access token.
 *
 * Cache verified constraints for 15 minutes and project timeouts for 60 seconds
 * to reduce repeated request delays while periodically retrying verification.
 */
export async function verifyConstraintsAccess(
  { organizationSlug, projectSlug }: Constraints,
  {
    accessToken,
    sentryHost = "sentry.io",
    cache,
  }: {
    accessToken: string | undefined | null;
    sentryHost?: string;
    cache?: CacheOptions;
  },
): Promise<
  | {
      ok: true;
      constraints: Constraints;
    }
  | { ok: false; status?: number; message: string; eventId?: string }
> {
  if (!organizationSlug) {
    // No constraints specified, nothing to verify
    return {
      ok: true,
      constraints: {
        organizationSlug: null,
        projectSlug: null,
        regionUrl: null,
      },
    };
  }

  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      message: "Missing access token for constraint verification",
    };
  }

  // Check KV cache when available (org-only and org+project keys).
  // Cache key includes userId to ensure per-user isolation.
  let cacheKey: string | null = null;
  if (cache) {
    cacheKey = buildCacheKey(
      cache.userId,
      sentryHost,
      organizationSlug,
      projectSlug,
    );
    const cached =
      (await getCachedConstraints(cache.kv, cacheKey)) ??
      (projectSlug
        ? await getCachedConstraints(cache.kv, `timeout:${cacheKey}`)
        : null);
    if (cached) {
      return {
        ok: true,
        constraints: {
          organizationSlug,
          projectSlug: projectSlug || null,
          regionUrl: cached.regionUrl,
          projectCapabilities: cached.projectCapabilities,
        },
      };
    }
  }

  // Use shared API client for consistent behavior and error handling
  const api = new SentryApiService({ accessToken, host: sentryHost });

  const { organization, regionUrl, project } = await lookupConstraints(
    api,
    { organizationSlug, projectSlug },
    {
      // The region URL's host as given; an invalid URL fails as a 502.
      projectHost: (regionUrl) =>
        regionUrl ? new URL(regionUrl).host : undefined,
      // Only the project lookup has a time limit, to avoid blocking on slow
      // API responses.
      projectTimeoutMs: CAPABILITIES_TIMEOUT_MS,
    },
  );

  if (organization.status !== "ok") {
    const { error } = organization;
    if (error instanceof ApiError) {
      const message =
        error.status === 404
          ? `Organization '${organizationSlug}' not found`
          : error.message;
      return { ok: false, status: error.status, message };
    }
    const eventId = logIssue(error);
    return {
      ok: false,
      status: 502,
      message: "Failed to verify organization",
      eventId,
    };
  }

  // Verify project access if specified
  let projectCapabilities: NullableProjectCapabilities = null;
  if (project?.status === "ok") {
    // Extract capability flags from project response
    // If fields are missing, === true comparison safely defaults to false
    projectCapabilities = {
      profiles: project.value.hasProfiles === true,
      replays: project.value.hasReplays === true,
      logs: project.value.hasLogs === true,
      traces: project.value.firstTransactionEvent === true,
    };
  } else if (project) {
    const { error } = project;
    if (error instanceof ConstraintLookupTimeoutError) {
      // Timeout - log and proceed with null capabilities (fail-open for tool filtering)
      // Note: We couldn't verify project access in time, but we allow through
      // to avoid blocking users due to slow API responses. Tools will still
      // require valid auth tokens to actually execute.
      logIssue(
        new Error(
          `Project verification timed out after ${CAPABILITIES_TIMEOUT_MS}ms for ${projectSlug}`,
        ),
      );
    } else if (error instanceof ApiError) {
      // API errors (404, 401, 403, etc.) should fail verification
      const message =
        error.status === 404
          ? `Project '${projectSlug}' not found in organization '${organizationSlug}'`
          : error.message;
      return { ok: false, status: error.status, message };
    } else {
      const eventId = logIssue(error);
      return {
        ok: false,
        status: 502,
        message: "Failed to verify project",
        eventId,
      };
    }
  }

  if (cache && cacheKey) {
    const isProjectTimeout =
      Boolean(projectSlug) && projectCapabilities === null;
    cache.waitUntil(
      setCachedConstraints(
        cache.kv,
        isProjectTimeout ? `timeout:${cacheKey}` : cacheKey,
        {
          regionUrl: regionUrl || null,
          projectCapabilities,
          cachedAt: Date.now(),
        },
        isProjectTimeout
          ? PROJECT_TIMEOUT_CACHE_TTL_SECONDS
          : CACHE_TTL_SECONDS,
      ),
    );
  }

  return {
    ok: true,
    constraints: {
      organizationSlug,
      projectSlug: projectSlug || null,
      regionUrl: regionUrl || null,
      projectCapabilities,
    },
  };
}
