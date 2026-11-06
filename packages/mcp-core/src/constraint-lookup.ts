/**
 * Look up an `<org>/[<project>]` constraint and classify each lookup.
 *
 * Shared by the hosted server's constraint verification and the stdio
 * server's startup scope check. Each caller decides what an outcome means
 * (fail, serve, cache); this module only fetches and classifies.
 *
 * The project lives on the organization's region, not the control silo
 * (multi-region SaaS), so it is fetched on the org's `links.regionUrl` when
 * that passes `validateRegionUrl`, else on the configured host.
 */

import {
  ApiNotFoundError,
  type Organization,
  type Project,
  type SentryApiService,
} from "./api-client/index";
import { validateRegionUrl } from "./internal/tool-helpers/validate-region-url";

/** Rejects a lookup that took longer than its time limit. */
export class ConstraintLookupTimeoutError extends Error {
  constructor(
    readonly resource: "organization" | "project",
    readonly timeoutMs: number,
  ) {
    super(`The ${resource} lookup timed out after ${timeoutMs}ms`);
    this.name = "ConstraintLookupTimeoutError";
  }
}

/**
 * - `ok`: the resource exists.
 * - `not-found`: Sentry answered 404.
 * - `unknown`: any other failure, including a timeout
 *   ({@link ConstraintLookupTimeoutError}); `error` says which.
 */
export type ConstraintLookup<T> =
  | { status: "ok"; value: T }
  | { status: "not-found"; error: ApiNotFoundError }
  | { status: "unknown"; error: unknown };

export type ConstraintLookupResult = {
  organization: ConstraintLookup<Organization>;
  /** The org's `links.regionUrl`, when the org was found. */
  regionUrl: string | null;
  /** Null without a project, or when the org was not found. */
  project: ConstraintLookup<Project> | null;
};

async function classify<T>(
  request: () => Promise<T>,
  resource: "organization" | "project",
  timeoutMs: number | undefined,
): Promise<ConstraintLookup<T>> {
  const outcome = request().then(
    (value): ConstraintLookup<T> => ({ status: "ok", value }),
    (error: unknown): ConstraintLookup<T> =>
      error instanceof ApiNotFoundError
        ? { status: "not-found", error }
        : { status: "unknown", error },
  );
  if (timeoutMs === undefined) {
    return await outcome;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConstraintLookup<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "unknown",
          error: new ConstraintLookupTimeoutError(resource, timeoutMs),
        }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The org's region host when `validateRegionUrl` accepts it. */
function projectHost(
  regionUrl: string | null,
  sentryHost: string,
): string | undefined {
  if (!regionUrl) {
    return undefined;
  }
  try {
    return validateRegionUrl(regionUrl, sentryHost);
  } catch {
    return undefined;
  }
}

/**
 * Fetch the organization, then the project on the organization's region.
 * The project is fetched only when the organization was found, as its
 * region is otherwise unknown.
 */
export async function lookupConstraints(
  api: SentryApiService,
  {
    organizationSlug,
    projectSlug,
    sentryHost,
  }: {
    organizationSlug: string;
    projectSlug?: string | null;
    sentryHost: string;
  },
  {
    organizationTimeoutMs,
    projectTimeoutMs,
    detailed,
  }: {
    organizationTimeoutMs?: number;
    projectTimeoutMs?: number;
    /** Passed to the organization request; `false` skips projects and teams. */
    detailed?: boolean;
  } = {},
): Promise<ConstraintLookupResult> {
  const organization = await classify(
    () =>
      api.getOrganization(
        organizationSlug,
        detailed === undefined ? undefined : { detailed },
      ),
    "organization",
    organizationTimeoutMs,
  );
  if (organization.status !== "ok") {
    return { organization, regionUrl: null, project: null };
  }
  const regionUrl = organization.value.links?.regionUrl?.trim() || null;
  if (!projectSlug) {
    return { organization, regionUrl, project: null };
  }
  const host = projectHost(regionUrl, sentryHost);
  const project = await classify(
    () =>
      api.getProject(
        {
          organizationSlug,
          projectSlugOrId: projectSlug,
          collapse: "organization",
        },
        host ? { host } : undefined,
      ),
    "project",
    projectTimeoutMs,
  );
  return { organization, regionUrl, project };
}
