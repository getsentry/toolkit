import { resolveCachedRegion } from "@sentry/toolkit-core/region-cache";
import { apiServiceFromContext } from "./api";
import type { ServerContext } from "../../types";

type ContextRegionCache = {
  accessToken: string;
  sentryHost: ServerContext["sentryHost"];
  sentryProtocol: ServerContext["sentryProtocol"];
  lookups: Map<string, Promise<string | null>>;
};

const regionUrlCache = new WeakMap<ServerContext, ContextRegionCache>();

function matchesContext(
  cache: ContextRegionCache,
  context: ServerContext,
): boolean {
  return (
    cache.accessToken === context.accessToken &&
    cache.sentryHost === context.sentryHost &&
    cache.sentryProtocol === context.sentryProtocol
  );
}

function getRegionUrlCache(context: ServerContext): ContextRegionCache {
  let cache = regionUrlCache.get(context);

  if (!cache || !matchesContext(cache, context)) {
    cache = {
      accessToken: context.accessToken,
      sentryHost: context.sentryHost,
      sentryProtocol: context.sentryProtocol,
      lookups: new Map<string, Promise<string | null>>(),
    };
    regionUrlCache.set(context, cache);
  }

  return cache;
}

/**
 * Resolves which regional Sentry API host to use for organization-scoped calls.
 * Uses the explicit `regionUrl` argument when set; otherwise prefers the
 * scoped value already present on `context.constraints`, then lazily fetches
 * and caches the org metadata for repeated lookups within the same context.
 */
export async function resolveRegionUrlForOrganization({
  context,
  organizationSlug,
  regionUrl,
}: {
  context: ServerContext;
  organizationSlug: string;
  regionUrl?: string | null;
}): Promise<string | null> {
  if (typeof regionUrl === "string") {
    const trimmed = regionUrl.trim();
    return trimmed || null;
  }

  if (context.constraints.organizationSlug === organizationSlug) {
    const scopedRegionUrl = context.constraints.regionUrl?.trim();
    if (scopedRegionUrl) {
      return scopedRegionUrl;
    }
  }

  const normalizedOrganizationSlug = organizationSlug.trim();
  const cache = getRegionUrlCache(context);

  try {
    const resolved = await resolveCachedRegion(
      cache.lookups,
      normalizedOrganizationSlug,
      async () => {
        const organization = await apiServiceFromContext(
          context,
        ).getOrganization(normalizedOrganizationSlug);
        return organization.links?.regionUrl?.trim() || null;
      },
    );
    // A credential or source-host change while the lookup was pending must
    // never route the new credential using the previous lookup's region.
    return matchesContext(cache, context) ? resolved : null;
  } catch {
    return null;
  }
}
