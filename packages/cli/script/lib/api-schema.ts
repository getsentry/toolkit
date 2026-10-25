/** Extract the bundled discovery index from a dereferenced OpenAPI document. */

import type {
  ApiEndpoint,
  ApiQueryParameter,
} from "../../src/lib/api-schema.js";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;
const PATH_PARAM_PATTERN = /\{(\w+)\}/g;

/** Only the OpenAPI fields used by the discovery index. */
export type OpenApiSpec = {
  paths: Record<string, OpenApiPathItem>;
};

type OpenApiPathItem = Partial<
  Record<(typeof HTTP_METHODS)[number], OpenApiOperation>
> & {
  parameters?: OpenApiParameter[];
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
};

type OpenApiParameter = {
  in: "path" | "query" | "header" | "cookie";
  name: string;
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    enum?: unknown[];
    items?: { enum?: unknown[] };
  };
};

/** Keep the existing resource grouping: the last literal URL segment. */
function deriveResource(url: string): string {
  const segments = url
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith("{"));
  const meaningful = segments.filter((s) => s !== "api" && s !== "0");
  return meaningful.at(-1) ?? "unknown";
}

function isEnumValue(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Operation parameters override inherited parameters with the same name/in. */
function extractQueryParameters(
  pathItem: OpenApiPathItem,
  operation: OpenApiOperation,
): ApiQueryParameter[] {
  const parameters = new Map<string, OpenApiParameter>();
  for (const parameter of [
    ...(pathItem.parameters ?? []),
    ...(operation.parameters ?? []),
  ]) {
    if (parameter.in === "query") {
      parameters.set(parameter.name, parameter);
    }
  }

  return [...parameters.values()].map((parameter) => {
    const schema = parameter.schema;
    const values = schema?.type === "array" ? schema.items?.enum : schema?.enum;
    return {
      name: parameter.name,
      description: parameter.description?.trim(),
      type: schema?.type,
      required: parameter.required === true,
      enum: values?.filter(isEnumValue),
    };
  });
}

/**
 * Generate entries directly from API metadata so new operations and enum values
 * become discoverable on the next schema generation, without a vocabulary map.
 */
export function extractApiEndpoints(
  spec: OpenApiSpec,
  sdkMap: ReadonlyMap<string, string>,
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  for (const [urlPath, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      const methodUpper = method.toUpperCase();
      const fn = sdkMap.get(`${methodUpper}:${urlPath}`) ?? "";
      const queryParameters = extractQueryParameters(pathItem, operation);

      endpoints.push({
        fn,
        method: methodUpper,
        path: urlPath,
        summary: operation.summary?.trim(),
        description: (operation.description ?? "").trim(),
        tags: operation.tags,
        pathParams: [...urlPath.matchAll(PATH_PARAM_PATTERN)].map((match) =>
          match[0].slice(1, -1),
        ),
        queryParams: queryParameters.map((parameter) => parameter.name),
        queryParameters,
        deprecated:
          operation.deprecated === true ||
          fn.startsWith("deprecated") ||
          (operation.operationId ?? "").toLowerCase().includes("deprecated"),
        resource: deriveResource(urlPath),
        operationId: operation.operationId ?? "",
      });
    }
  }

  // Keep stable ordering and the existing resource/operation ID contract.
  return endpoints.sort((a, b) => {
    const resourceCmp = a.resource.localeCompare(b.resource);
    return resourceCmp || a.operationId.localeCompare(b.operationId);
  });
}
