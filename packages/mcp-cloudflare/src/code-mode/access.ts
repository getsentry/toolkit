import type { ApiOperation } from "@sentry/api/operations";

export type CatalogOperation = Pick<ApiOperation, "method" | "path">;

export interface CodeModeAccess {
  organizationSlug?: string | null;
}

interface MatchedPath {
  pathTemplate: string;
  parameters: Record<string, string>;
  literalSegments: number;
}

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

/** The most literal published path template matching the URL. */
function findPath(url: URL, pathTemplates: Iterable<string>): MatchedPath {
  const segments = url.pathname.split("/").map(decodePathSegment);
  const matches: MatchedPath[] = [];
  for (const pathTemplate of pathTemplates) {
    const templateSegments = pathTemplate.split("/");
    if (templateSegments.length !== segments.length) continue;
    const parameters: Record<string, string> = {};
    let literalSegments = 0;
    const matchesPath = templateSegments.every((segment, index) => {
      const parameter = /^\{([^{}]+)\}$/.exec(segment);
      if (parameter) {
        if (!segments[index] || Object.hasOwn(parameters, parameter[1])) {
          return false;
        }
        parameters[parameter[1]] = segments[index];
        return true;
      }
      literalSegments++;
      return segment === segments[index];
    });
    if (matchesPath) {
      matches.push({ pathTemplate, parameters, literalSegments });
    }
  }
  matches.sort((a, b) => b.literalSegments - a.literalSegments);
  const match = matches[0];
  if (!match) {
    throw new Error(
      "This API path is not available in the published API schema.",
    );
  }
  if (matches[1]?.literalSegments === match.literalSegments) {
    throw new Error(
      "This API path matches multiple operations in the API schema.",
    );
  }
  return match;
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
): { pathTemplate: string; organizationSlug?: string } {
  const { pathTemplate, parameters } = findPath(
    url,
    new Set(catalog.map(({ path }) => path)),
  );
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

  return { pathTemplate, ...(organizationSlug ? { organizationSlug } : {}) };
}
