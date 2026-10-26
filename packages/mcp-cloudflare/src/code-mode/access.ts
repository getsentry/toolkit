export interface CodeModeAccess {
  organizationSlug?: string | null;
}

interface MatchedOperation {
  pathTemplate: string;
  pathItem: Record<string, unknown>;
  parameters: Record<string, string>;
  literalSegments: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function findOperation(
  url: URL,
  spec: Record<string, unknown>,
): MatchedOperation {
  if (!isRecord(spec.paths)) {
    throw new Error("The API schema does not contain an operation catalog.");
  }
  const segments = url.pathname.split("/").map(decodePathSegment);
  const matches: MatchedOperation[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
    if (!pathTemplate.startsWith("/") || !isRecord(pathItem)) continue;
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
      matches.push({ pathTemplate, pathItem, parameters, literalSegments });
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

/** Enforce the published API surface and connection constraint before calling Sentry. */
export function authorizeApiRequest(
  url: URL,
  method: string,
  spec: object,
  access: CodeModeAccess,
): { pathTemplate: string; organizationSlug?: string } {
  if (!isRecord(spec)) {
    throw new Error("The API schema does not contain an operation catalog.");
  }
  const { pathTemplate, pathItem, parameters } = findOperation(url, spec);
  const normalizedMethod = method.toLowerCase();
  const operationMethod =
    normalizedMethod === "head" && !Object.hasOwn(pathItem, "head")
      ? "get"
      : normalizedMethod;
  const operation = Object.hasOwn(pathItem, operationMethod)
    ? pathItem[operationMethod]
    : undefined;
  if (!isRecord(operation)) {
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
