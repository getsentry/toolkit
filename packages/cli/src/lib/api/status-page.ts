/**
 * Statuspage.io API client for Sentry's public status page.
 *
 * Sentry's status page (https://status.sentry.io) is hosted on Statuspage.io,
 * which exposes a stable JSON summary at `/api/v2/summary.json`. This module
 * fetches and shapes that payload for the `sentry status` command.
 *
 * The request is bounded by an explicit timeout so a status check never hangs,
 * which is the whole point of the command — it is meant to work even while the
 * Sentry API itself is degraded.
 */

import { customFetch } from "../custom-ca.js";
import { logger } from "../logger.js";

const log = logger.withTag("status-page");

/** Default Sentry status page base URL. */
export const SENTRY_STATUS_PAGE_URL = "https://status.sentry.io";

/** Bound the request so a status check never hangs, even during an outage. */
const STATUS_REQUEST_TIMEOUT_MS = 10_000;

/** Shorter timeout for the lightweight /_health/ probe (self-hosted or sentry.io). */
const HEALTH_REQUEST_TIMEOUT_MS = 5000;

/** Matches one or more trailing slashes so base URLs normalize cleanly. */
const TRAILING_SLASHES = /\/+$/;

/** Overall indicator reported by Statuspage. */
export type StatusIndicator =
  | "none"
  | "minor"
  | "major"
  | "critical"
  | "maintenance";

/** Per-component operational status reported by Statuspage. */
export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance";

/** A single service component on the status page. */
export type StatusComponent = {
  readonly name: string;
  readonly status: ComponentStatus;
};

/** An ongoing or recent incident. */
export type StatusIncident = {
  readonly name: string;
  readonly status: string;
  readonly impact: string;
  readonly shortlink: string;
};

/** Structured status data: JSON output shape and human-formatter input. */
export type SentryStatus = {
  /** Overall indicator and human-readable description. */
  readonly indicator: StatusIndicator;
  readonly description: string;
  /** Status page URL the data was fetched from. */
  readonly url: string;
  /** All service components with their current status. */
  readonly components: readonly StatusComponent[];
  /** Unresolved incidents currently shown on the status page. */
  readonly incidents: readonly StatusIncident[];
};

/** Shape of the Statuspage `/api/v2/summary.json` response we consume. */
type SummaryResponse = {
  page?: { url?: string };
  status?: { indicator?: string; description?: string };
  components?: Array<{ name?: string; status?: string; group?: boolean }>;
  incidents?: Array<{
    name?: string;
    status?: string;
    impact?: string;
    shortlink?: string;
  }>;
};

/**
 * Fetch the current Sentry service status.
 *
 * Rather than guessing from the host name whether a URL is a Statuspage
 * instance, we probe the target directly: request `/api/v2/summary.json` and,
 * if it comes back as a valid Statuspage summary, use it. Any clear
 * non-Statuspage response (non-2xx, non-JSON, or a body missing the summary
 * shape) or a network error falls back to the self-hosted `/_health/?full=1`
 * probe. This makes the command reliable for arbitrary self-hosted or regional
 * deployments without domain-name inference.
 *
 * @param baseUrl - Status page base URL (defaults to status.sentry.io). Pass a
 *   custom URL to point at a self-hosted or regional Statuspage instance.
 */
export async function fetchSentryStatus(
  baseUrl: string = SENTRY_STATUS_PAGE_URL
): Promise<SentryStatus> {
  const normalized = baseUrl.replace(TRAILING_SLASHES, "");

  const summary = await tryFetchStatuspageSummary(normalized);
  return summary ?? probeSelfHostedHealth(normalized);
}

/**
 * Probe `<baseUrl>/api/v2/summary.json` and shape it into a {@link SentryStatus}.
 *
 * Returns `undefined` when the target does not look like a Statuspage instance
 * — a non-2xx response, a body that isn't JSON, or JSON that lacks the summary
 * shape — so the caller can fall back to the self-hosted health probe. Never
 * throws.
 */
async function tryFetchStatuspageSummary(
  normalized: string
): Promise<SentryStatus | undefined> {
  const endpoint = `${normalized}/api/v2/summary.json`;

  let response: Response;
  try {
    response = await customFetch(endpoint, {
      signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    log.debug(`Statuspage summary fetch failed for ${endpoint}`, err);
    return;
  }

  if (!response.ok) {
    return;
  }

  let summary: SummaryResponse;
  try {
    summary = (await response.json()) as SummaryResponse;
  } catch (err) {
    log.debug(`Statuspage summary parse failed for ${endpoint}`, err);
    return;
  }

  // A genuine Statuspage summary always carries a `status` object with an
  // `indicator`. Anything else is some other JSON endpoint, not Statuspage.
  if (!summary || typeof summary.status?.indicator !== "string") {
    return;
  }

  const components: StatusComponent[] = (summary.components ?? [])
    // Group headers carry no operational status of their own.
    .filter((c) => !c.group && typeof c.name === "string")
    .map((c) => ({
      name: c.name as string,
      status: (c.status as ComponentStatus) ?? "operational",
    }));

  const incidents: StatusIncident[] = (summary.incidents ?? []).map((i) => ({
    name: i.name ?? "Unnamed incident",
    status: i.status ?? "unknown",
    impact: i.impact ?? "none",
    shortlink: i.shortlink ?? normalized,
  }));

  return {
    indicator: (summary.status?.indicator as StatusIndicator) ?? "none",
    description: summary.status?.description ?? "Unknown",
    url: summary.page?.url ?? normalized,
    components,
    incidents,
  };
}

/**
 * Probe a self-hosted Sentry's `/_health/` endpoint. Never throws — network or
 * HTTP failures are reported as a synthetic "major" status so the command can
 * still render something useful when the instance is down.
 *
 * Uses `?full=1` so the check exercises every subsystem (Postgres, Redis,
 * Celery, …) rather than the bare liveness probe: without it Sentry returns
 * HTTP 200 whenever the web process is up, masking real backend outages.
 */
async function probeSelfHostedHealth(
  normalized: string
): Promise<SentryStatus> {
  const healthEndpoint = `${normalized}/_health/?full=1`;
  try {
    const resp = await customFetch(healthEndpoint, {
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });

    return {
      indicator: resp.ok ? "none" : "major",
      description: resp.statusText || (resp.ok ? "OK" : `HTTP ${resp.status}`),
      url: normalized,
      components: [],
      incidents: [],
    };
  } catch (err) {
    return {
      indicator: "major",
      description: err instanceof Error ? err.message : String(err),
      url: normalized,
      components: [],
      incidents: [],
    };
  }
}
