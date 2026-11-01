/**
 * Warm the shell-completion cache with trace item attribute keys.
 *
 * Field completion (`explore --field`, `dashboard widget --query`,
 * `alert metrics --aggregate`, …) reads the `span-attribute`,
 * `log-attribute` and `metric-attribute` kinds of `completion_cache`. Only
 * a `GET /organizations/{org}/trace-items/attributes/` response seeds them
 * (see `api/completion-seed.ts`), so without a warm-up field completion
 * offers nothing until the user runs `sentry attribute list`.
 *
 * `auth login` and `cli setup` (which `cli upgrade` runs) call
 * {@link warmAttributeCompletions}. It requests each dataset of a few orgs in
 * parallel and lets the fetch layer store the keys. It is best-effort: it
 * never throws or prompts, logs only at debug level, and gives up after
 * {@link WARMUP_TIMEOUT_MS} so the command never looks stuck.
 */

import { ATTRIBUTE_KINDS } from "./api/completion-seed.js";
import { listTraceItemAttributes } from "./api/traces.js";
import { hasStoredAuthCredentials } from "./db/auth.js";
import {
  getLatestCompletionSeen,
  getRecentlyUsedOrgs,
} from "./db/completion-cache.js";
import { getDefaultOrganization } from "./db/defaults.js";
import { getAllOrgRegions } from "./db/regions.js";
import { logger } from "./logger.js";

const log = logger.withTag("completion-warmup");

/** How long the warm-up may take before its requests are aborted. */
export const WARMUP_TIMEOUT_MS = 1000;

/** Orgs warmed besides the default org, picked by recent use. */
export const MAX_RECENT_ORGS = 3;

/** Orgs not used for this long are not warmed (matches the cache TTL). */
export const RECENT_ORG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** `cli setup` re-warms a dataset of an org only when it is older than this. */
export const SETUP_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** A trace item dataset whose attribute keys completion offers. */
type AttributeDataset = keyof typeof ATTRIBUTE_KINDS;

const ATTRIBUTE_DATASETS = Object.keys(ATTRIBUTE_KINDS) as AttributeDataset[];

/**
 * The orgs to warm: the default org, then up to {@link MAX_RECENT_ORGS}
 * orgs used within {@link RECENT_ORG_WINDOW_MS}, or the only org of an
 * account that has one and no history.
 *
 * Only orgs whose region the active account has cached qualify. That keeps
 * the warm-up from switching accounts or looking up a region over the
 * network, a request it could not abort.
 */
export function pickWarmupOrgs(now = Date.now()): string[] {
  const known = [...getAllOrgRegions().keys()];
  const knownSet = new Set(known);
  const picked: string[] = [];
  const defaultOrg = getDefaultOrganization();
  if (defaultOrg && knownSet.has(defaultOrg)) {
    picked.push(defaultOrg);
  }
  const recent = getRecentlyUsedOrgs(
    now - RECENT_ORG_WINDOW_MS,
    Object.values(ATTRIBUTE_KINDS),
  ).filter((org) => knownSet.has(org) && org !== defaultOrg);
  picked.push(...recent.slice(0, MAX_RECENT_ORGS));
  if (picked.length === 0 && known.length === 1) {
    picked.push(...known);
  }
  return picked;
}

/** Options for {@link warmAttributeCompletions}. */
type WarmAttributeCompletionsOptions = {
  /**
   * Skip a dataset of an org whose keys were stored more recently than
   * this many milliseconds ago. Omit to warm every dataset.
   */
  refreshAfterMs?: number;
};

/** One attributes request of the warm-up. */
type WarmupRequest = { org: string; dataset: AttributeDataset };

/** The datasets of `orgs` to request, leaving out fresh ones. */
function planRequests(
  orgs: readonly string[],
  refreshAfterMs: number | undefined,
  now: number,
): WarmupRequest[] {
  return orgs.flatMap((org) =>
    ATTRIBUTE_DATASETS.filter((dataset) => {
      if (refreshAfterMs === undefined) {
        return true;
      }
      const latest = getLatestCompletionSeen(ATTRIBUTE_KINDS[dataset], org);
      return latest === undefined || now - latest >= refreshAfterMs;
    }).map((dataset) => ({ org, dataset })),
  );
}

/**
 * Fetch the attribute keys of each dataset of the orgs from
 * {@link pickWarmupOrgs}, so field completion works before the user runs
 * `sentry attribute list`. All requests run in parallel and are aborted
 * after {@link WARMUP_TIMEOUT_MS}. Does nothing without a stored login, so
 * an environment token (as in CI) never triggers it.
 *
 * Never throws. A missing feature, a rejected token, being offline or a
 * timeout leaves the cache as it was; failures are only logged at debug
 * level.
 */
export async function warmAttributeCompletions(
  options: WarmAttributeCompletionsOptions = {},
): Promise<void> {
  let requests: WarmupRequest[];
  try {
    if (!hasStoredAuthCredentials()) {
      return;
    }
    const now = Date.now();
    requests = planRequests(pickWarmupOrgs(now), options.refreshAfterMs, now);
  } catch (error) {
    log.debug("Not warming attribute completions", error);
    return;
  }
  if (requests.length === 0) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Attribute completion warm-up timed out"));
  }, WARMUP_TIMEOUT_MS);
  try {
    await Promise.all(
      requests.map(({ org, dataset }) =>
        listTraceItemAttributes(org, {
          dataset,
          signal: controller.signal,
        }).catch((error: unknown) => {
          log.debug(`Not warming ${dataset} attributes of '${org}'`, error);
        }),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}
