/**
 * Repository endpoints: the organization's connected repositories and
 * linking one to a project with a code mapping. Each wrapper validates the
 * response with the schema the host passes, so the host's schema decides the
 * result type.
 */

import { apiPath } from "../api-path.js";
import { type ApiTarget, nextPageCursor } from "../core.js";
import { readJsonResponse } from "../response.js";
import { type ResponseSchema, validateResponse } from "../validate.js";

export type ListRepositoriesParams = {
  organizationSlug: string;
  /** Filters by repository name. */
  query?: string;
};

/** Every repository connected to the organization, across all pages. */
export async function listRepositories<T>(
  { core, origin }: ApiTarget,
  { organizationSlug, query }: ListRepositoriesParams,
  schema: ResponseSchema<T[]>,
): Promise<T[]> {
  const repos: T[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams();
    params.set("per_page", "100");
    if (query) {
      params.set("query", query);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await core.request(
      origin,
      `${apiPath`/organizations/${organizationSlug}/repos/`}?${params.toString()}`,
      { method: "GET" },
    );
    repos.push(...validateResponse(schema, await readJsonResponse(response)));
    cursor = nextPageCursor(response);
  } while (cursor);
  return repos;
}

export type LinkProjectRepositoryParams = {
  organizationSlug: string;
  projectSlug: string;
  /** The repository's full name, such as `getsentry/sentry`. */
  repository: string;
  provider?: string | null;
};

/**
 * Link a repository to a project with one code mapping whose stack and
 * source roots are both the repository root.
 */
export async function linkProjectRepository<T>(
  { core, origin }: ApiTarget,
  {
    organizationSlug,
    projectSlug,
    repository,
    provider,
  }: LinkProjectRepositoryParams,
  schema: ResponseSchema<T>,
): Promise<T> {
  const body = await core.requestJson(
    origin,
    apiPath`/organizations/${organizationSlug}/code-mappings/bulk/`,
    {
      method: "POST",
      body: JSON.stringify({
        project: projectSlug,
        repository,
        provider,
        mappings: [{ stackRoot: "", sourceRoot: "" }],
      }),
    },
  );
  return validateResponse(schema, body);
}
