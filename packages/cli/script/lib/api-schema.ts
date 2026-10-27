/** Project SDK operation metadata into the CLI's bundled discovery index. */

import type {
  ApiEndpoint,
  ApiQueryParameter,
} from "../../src/lib/api-schema.js";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;
const PATH_PARAM_PATTERN = /\{(\w+)\}/g;

/**
 * Structural subset of the forthcoming @sentry/api/operations contract. Import
 * its public type directly once the pinned SDK includes that entry point.
 */
type SdkOperation = Pick<
  ApiEndpoint,
  "method" | "path" | "operationId" | "summary" | "description" | "deprecated"
> & {
  /** Actual exported SDK function name after normalization. */
  functionName: string;
  /** Categories assigned by the OpenAPI specification. */
  tags?: readonly string[];
  /** Parameter names present in the canonical path template. */
  pathParameters: readonly string[];
  /** Resolved query metadata; inherited parameters are already merged. */
  queryParameters: readonly (Omit<ApiQueryParameter, "enum"> & {
    /** Allowed scalar values, or allowed item values for an array parameter. */
    enum?: readonly (string | number | boolean | null)[];
  })[];
};

/** Keep CLI grouping, output names and legacy deprecation detection local. */
export function projectApiOperations(
  operations: readonly SdkOperation[],
): ApiEndpoint[] {
  return operations
    .map((operation) => ({
      fn: operation.functionName,
      method: operation.method,
      path: operation.path,
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

/** An older SDK may lack the entry point; a broken exported catalog must fail. */
export async function loadSdkApiEndpoints(
  resolveModule: (specifier: string) => string = (specifier) =>
    import.meta.resolve(specifier),
): Promise<ApiEndpoint[] | undefined> {
  let entry: string;
  try {
    entry = resolveModule("@sentry/api/operations");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ) {
      return;
    }
    throw error;
  }

  const { operations } = (await import(entry)) as {
    operations: readonly SdkOperation[];
  };
  return projectApiOperations(operations);
}

/**
 * OpenAPI fields used by SDK versions without /operations. Remove this
 * compatibility extraction when the pinned dependency includes the catalog.
 */
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
  const operations: SdkOperation[] = [];

  for (const [urlPath, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      const methodUpper = method.toUpperCase();
      const fn = sdkMap.get(`${methodUpper}:${urlPath}`) ?? "";
      const queryParameters = extractQueryParameters(pathItem, operation);

      operations.push({
        functionName: fn,
        method: methodUpper,
        path: urlPath,
        summary: operation.summary?.trim(),
        description: (operation.description ?? "").trim(),
        tags: operation.tags,
        pathParameters: [...urlPath.matchAll(PATH_PARAM_PATTERN)].map((match) =>
          match[0].slice(1, -1),
        ),
        queryParameters,
        deprecated: operation.deprecated === true,
        operationId: operation.operationId ?? "",
      });
    }
  }

  return projectApiOperations(operations);
}
