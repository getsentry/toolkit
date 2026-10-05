#!/usr/bin/env tsx
/**
 * Generate API Schema Index from Sentry's OpenAPI Specification
 *
 * Fetches the dereferenced OpenAPI spec from the sentry-api-schema repository
 * and extracts a lightweight JSON index of all API endpoints. This index is
 * bundled into the CLI for runtime introspection via `sentry schema`.
 *
 * Data source: https://github.com/getsentry/sentry-api-schema
 *   - openapi-derefed.json — full dereferenced OpenAPI 3.0 spec
 *
 * Also reads SDK function names from the installed @sentry/api package to
 * map operationIds to their TypeScript SDK function names.
 *
 * Usage:
 *   tsx script/generate-api-schema.ts
 *
 * Output:
 *   src/generated/api-schema.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the root directory of @sentry/api by finding its main entry point. */
function sentryApiDir(): string {
  // import.meta.resolve returns a file:// URL for the exported entry point
  const entryUrl = import.meta.resolve("@sentry/api");
  // Entry is at dist/index.js → go up two levels to get the package root
  return resolve(dirname(fileURLToPath(entryUrl)), "..");
}

const OUTPUT_PATH = "src/generated/api-schema.json";

/**
 * Build the OpenAPI spec URL from the installed @sentry/api version.
 * The sentry-api-schema repo tags match the @sentry/api npm version.
 */
async function getOpenApiUrl(): Promise<string> {
  const pkgPath = resolve(sentryApiDir(), "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
    version: string;
  };
  return `https://raw.githubusercontent.com/getsentry/sentry-api-schema/${pkg.version}/openapi-derefed.json`;
}

/** Regex to extract path parameters from URL templates */
const PATH_PARAM_PATTERN = /\{(\w+)\}/g;

// Single source of truth for the ApiEndpoint type lives in src/lib/api-schema.ts.
// Re-export so this file remains a module (required for top-level await).
export type { ApiEndpoint } from "../src/lib/api-schema.js";

import type { ApiEndpoint } from "../src/lib/api-schema.js";

// ---------------------------------------------------------------------------
// OpenAPI Types (minimal subset we need)
// ---------------------------------------------------------------------------

type OpenApiSpec = {
  paths: Record<string, Record<string, OpenApiOperation>>;
};

type OpenApiOperation = {
  operationId?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
};

type OpenApiParameter = {
  in: "path" | "query" | "header" | "cookie";
  name: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string };
};

// ---------------------------------------------------------------------------
// SDK Function Name Mapping
// ---------------------------------------------------------------------------

/**
 * Build a map from URL+method to SDK function name by parsing
 * the @sentry/api index.js bundle.
 */
async function buildSdkFunctionMap(): Promise<Map<string, string>> {
  const pkgDir = resolve(sentryApiDir(), "dist");
  const js = await readFile(`${pkgDir}/index.js`, "utf-8");
  const results = new Map<string, string>();

  // Match: var NAME = (options...) => (options...client ?? client).METHOD({
  const funcPattern =
    /var (\w+) = \(options\S*\) => \(options\S*client \?\? client\)\.(\w+)\(/g;
  // Match: url: "..."
  const urlPattern = /url: "([^"]+)"/g;

  // Extract all function declarations with their positions
  const funcs: { name: string; method: string; index: number }[] = [];
  let match = funcPattern.exec(js);
  while (match !== null) {
    funcs.push({
      name: match[1],
      method: match[2].toUpperCase(),
      index: match.index,
    });
    match = funcPattern.exec(js);
  }

  // Extract all URLs with their positions
  const urls: { url: string; index: number }[] = [];
  match = urlPattern.exec(js);
  while (match !== null) {
    urls.push({ url: match[1], index: match.index });
    match = urlPattern.exec(js);
  }

  // Match each function to its nearest following URL
  for (const func of funcs) {
    const nextUrl = urls.find((u) => u.index > func.index);
    if (nextUrl) {
      const key = `${func.method}:${nextUrl.url}`;
      results.set(key, func.name);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Resource Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the resource name from a URL template.
 * Uses the last non-parameter path segment.
 *
 * @example "/api/0/organizations/{org}/issues/" → "issues"
 * @example "/api/0/issues/{issue_id}/" → "issues"
 */
function deriveResource(url: string): string {
  const segments = url
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith("{"));
  const meaningful = segments.filter((s) => s !== "api" && s !== "0");
  return meaningful.at(-1) ?? "unknown";
}

/**
 * Extract path parameter names from a URL template.
 */
function extractPathParams(url: string): string[] {
  const params: string[] = [];
  const pattern = new RegExp(
    PATH_PARAM_PATTERN.source,
    PATH_PARAM_PATTERN.flags
  );
  let match = pattern.exec(url);
  while (match !== null) {
    params.push(match[1]);
    match = pattern.exec(url);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const openApiUrl = await getOpenApiUrl();
console.log(`Fetching OpenAPI spec from ${openApiUrl}...`);
const response = await fetch(openApiUrl);
if (!response.ok) {
  throw new Error(
    `Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`
  );
}
const spec = (await response.json()) as OpenApiSpec;

console.log("Building SDK function name map from @sentry/api...");
const sdkMap = await buildSdkFunctionMap();

const endpoints: ApiEndpoint[] = [];
const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

for (const [urlPath, pathItem] of Object.entries(spec.paths)) {
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method] as OpenApiOperation | undefined;
    if (!operation) {
      continue;
    }

    const methodUpper = method.toUpperCase();
    const sdkKey = `${methodUpper}:${urlPath}`;
    const fn = sdkMap.get(sdkKey) ?? "";

    const queryParams = (operation.parameters ?? [])
      .filter((p) => p.in === "query")
      .map((p) => p.name);

    endpoints.push({
      fn,
      method: methodUpper,
      path: urlPath,
      description: (operation.description ?? "").trim(),
      pathParams: extractPathParams(urlPath),
      queryParams,
      deprecated:
        operation.deprecated === true ||
        fn.startsWith("deprecated") ||
        (operation.operationId ?? "").toLowerCase().includes("deprecated"),
      resource: deriveResource(urlPath),
      operationId: operation.operationId ?? "",
    });
  }
}

// Sort by resource, then method for stable output
endpoints.sort((a, b) => {
  const resourceCmp = a.resource.localeCompare(b.resource);
  if (resourceCmp !== 0) {
    return resourceCmp;
  }
  return a.operationId.localeCompare(b.operationId);
});

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(endpoints, null, 2));

console.log(
  `Generated ${OUTPUT_PATH} (${endpoints.length} endpoints, ${Math.round(JSON.stringify(endpoints).length / 1024)}KB)`
);
