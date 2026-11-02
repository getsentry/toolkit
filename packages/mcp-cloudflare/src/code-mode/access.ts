import type { ApiOperation } from "@sentry/api/operations";
import {
  type ApiPathTemplateMatch,
  matchApiPathTemplate,
} from "@sentry/toolkit-core/api-path-template";

export type CatalogOperation = Pick<ApiOperation, "method" | "path">;

export interface CodeModeAccess {
  organizationSlug?: string | null;
}

type MatchedPath = ApiPathTemplateMatch & { pathTemplate: string };

function decodePathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error("The API path contains invalid percent encoding.");
  }
  if (decoded === "." || decoded === ".." || /[/\\]|%2f|%5c/i.test(decoded)) {
    throw new Error(
      "The API path cannot contain encoded path separators or traversal segments.",
    );
  }
  return decoded;
}

/** The most literal published path template matching a decoded path. */
function findPath(
  path: string,
  pathTemplates: Iterable<string>,
): MatchedPath | undefined {
  const matches: MatchedPath[] = [];
  for (const pathTemplate of pathTemplates) {
    const match = matchApiPathTemplate(pathTemplate, path);
    if (match) matches.push({ pathTemplate, ...match });
  }
  matches.sort((a, b) => b.literalSegments - a.literalSegments);
  if (matches[1] && matches[1].literalSegments === matches[0].literalSegments) {
    throw new Error(
      "This API path matches multiple operations in the API schema.",
    );
  }
  return matches[0];
}

/**
 * Enforce the published API surface and connection constraint before calling
 * Sentry. `catalog` lists the operations of the `@sentry/api` release the
 * search schema comes from.
 */
export function authorizeApiRequest(
  url: URL,
  method: string,
  catalog: readonly CatalogOperation[],
  access: CodeModeAccess,
): { pathTemplate: string; pathname: string; organizationSlug?: string } {
  const templates = new Set(catalog.map(({ path }) => path));
  const decoded = url.pathname.split("/").map(decodePathSegment).join("/");
  let pathname = url.pathname;
  let match = findPath(decoded, templates);
  // Most routes end with a slash. Send the canonical path rather than fail.
  if (!match && !pathname.endsWith("/")) {
    match = findPath(`${decoded}/`, templates);
    pathname = `${pathname}/`;
  }
  if (!match) {
    throw new Error(
      "This API path is not available in the published API schema.",
    );
  }
  const { pathTemplate, parameters } = match;
  const methods = new Set<string>(
    catalog.filter(({ path }) => path === pathTemplate).map((op) => op.method),
  );
  const requested = method.toUpperCase();
  if (
    !methods.has(requested) &&
    !(requested === "HEAD" && methods.has("GET"))
  ) {
    throw new Error(
      "This HTTP method is not available for the published API path.",
    );
  }

  const organizationSlug =
    parameters.organization_id_or_slug ?? parameters.organization_slug;
  if (access.organizationSlug && organizationSlug !== access.organizationSlug) {
    throw new Error(
      "This API operation is outside the active organization constraint. Use an organization-scoped API path with the authorized organization slug.",
    );
  }

  return {
    pathTemplate,
    pathname,
    ...(organizationSlug ? { organizationSlug } : {}),
  };
}
