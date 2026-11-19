/** Project SDK operation metadata into the CLI's bundled discovery index. */

import { API_BASE_PATH } from "@sentry/api/client";
import type { ApiOperation } from "@sentry/api/operations";
import type { ApiEndpoint } from "../../src/lib/api-schema.js";

/**
 * Keep CLI grouping, output names and legacy deprecation detection local.
 * Paths are full request paths, as users type and see them.
 */
export function projectApiOperations(
  operations: readonly ApiOperation[],
): ApiEndpoint[] {
  return operations
    .map((operation) => ({
      fn: operation.functionName,
      method: operation.method,
      path: `${API_BASE_PATH}${operation.path}`,
      summary: operation.summary,
      description: operation.description,
      tags: operation.tags ? [...operation.tags] : undefined,
      pathParams: [...operation.pathParameters],
      queryParams: operation.queryParameters.map((parameter) => parameter.name),
      queryParameters: operation.queryParameters.map((parameter) => ({
        ...parameter,
        enum: parameter.enum ? [...parameter.enum] : undefined,
      })),
      deprecated:
        operation.deprecated ||
        operation.functionName.startsWith("deprecated") ||
        operation.operationId.toLowerCase().includes("deprecated"),
      resource: deriveResource(operation.path),
      operationId: operation.operationId,
    }))
    .sort((a, b) => {
      const resourceCmp = a.resource.localeCompare(b.resource);
      return resourceCmp || a.operationId.localeCompare(b.operationId);
    });
}

/** Keep the existing resource grouping: the last literal URL segment. */
function deriveResource(url: string): string {
  const segments = url
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith("{"));
  return segments.at(-1) ?? "unknown";
}
