#!/usr/bin/env tsx
/**
 * Generate API Schema Index from the installed Sentry SDK's operation catalog.
 *
 * Bundled into the CLI for runtime introspection via `sentry schema`.
 * Older SDKs without @sentry/api/operations temporarily use their versioned
 * OpenAPI spec and bundled function names. Remove that compatibility path
 * after the pinned SDK dependency includes the operation catalog.
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
import {
  extractApiEndpoints,
  loadSdkApiEndpoints,
  type OpenApiSpec,
} from "./lib/api-schema.js";

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

  // Optional options use a rest tuple in newer generated SDKs.
  const funcPattern =
    /var (\w+) = \((?:\.\.\.\[)?options\S*\) => \(options\S*client \?\? client\)\.(\w+)\(/g;
  // Match: url: "..."
  const urlPattern = /url: "([^"]+)"/g;

  // Extract all function declarations with their positions
  const funcs: { name: string; method: string; index: number }[] = [];
  let match = funcPattern.exec(js);
  while (match !== null) {
    funcs.push({
      name: match[1]!,
      method: match[2]!.toUpperCase(),
      index: match.index,
    });
    match = funcPattern.exec(js);
  }

  // Extract all URLs with their positions
  const urls: { url: string; index: number }[] = [];
  match = urlPattern.exec(js);
  while (match !== null) {
    urls.push({ url: match[1]!, index: match.index });
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
// Main
// ---------------------------------------------------------------------------

let endpoints = await loadSdkApiEndpoints();
if (endpoints) {
  console.log("Using operation catalog from @sentry/api/operations...");
} else {
  const openApiUrl = await getOpenApiUrl();
  console.log(`SDK catalog not yet available; fetching ${openApiUrl}...`);
  const response = await fetch(openApiUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`,
    );
  }
  const spec = (await response.json()) as OpenApiSpec;
  const sdkMap = await buildSdkFunctionMap();
  endpoints = extractApiEndpoints(spec, sdkMap);
}

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(endpoints, null, 2));

console.log(
  `Generated ${OUTPUT_PATH} (${endpoints.length} endpoints, ${Math.round(JSON.stringify(endpoints).length / 1024)}KB)`,
);
