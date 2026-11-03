/** CLI conventions for the SDK's build-time API usage analyzer. */

import { readFile } from "node:fs/promises";
import {
  analyzeSourceApiUsage as analyze,
  type SourceApiOperation,
} from "@sentry/api/source-analysis";
import { glob } from "tinyglobby";
import { getAllEndpoints } from "../../src/lib/api-schema.js";

export type { SourceApiOperation } from "@sentry/api/source-analysis";

/** Discover command API usage, HTTP methods, and DELETE declarations without executing commands. */
export function analyzeSourceApiUsage(
  sources: ReadonlyMap<string, string>,
  operations: readonly SourceApiOperation[],
) {
  const result = analyze(sources, operations, {
    boundaries: [
      "buildCommand",
      "buildListCommand",
      "buildOrgListCommand",
      "buildDeleteCommand",
    ],
    requests: [
      {
        functionName: "apiRequest",
        pathArgument: 0,
        optionsArgument: 1,
        queryProperty: "params",
      },
      {
        functionName: "apiRequestToRegion",
        pathArgument: 1,
        optionsArgument: 2,
        queryProperty: "params",
      },
      {
        functionName: "apiRequestToRegionNoContent",
        pathArgument: 1,
        optionsArgument: 2,
        queryProperty: "params",
      },
    ],
    queryParameters: ["dataset", "query"],
    declarationFlags: ["destructive"],
  });

  return {
    exports: new Map(
      [...result.exports].map(([file, exports]) => [
        file,
        new Map(
          [...exports].map(([name, usage]) => [
            name,
            {
              operations: usage.operations,
              unresolvedRequests: usage.unresolvedRequests,
              deletes: usage.methods.includes("DELETE"),
              /** Every request method found, including requests outside the Sentry API. */
              methods: usage.methods,
              /** Methods of the Sentry API requests; `undefined` when unknown. */
              apiMethods: [
                ...usage.operations.map(({ method }) => method),
                ...usage.unresolvedRequests.map(({ method }) => method),
              ],
            },
          ]),
        ),
      ]),
    ),
    commands: result.boundaries.map(({ file, name, factories, flags }) => ({
      file,
      name,
      destructive:
        flags.includes("destructive") ||
        factories.includes("buildDeleteCommand"),
    })),
  };
}

/** Analyze the CLI's own sources (`src/`, without tests or generated files) against the API catalog. */
export async function analyzeCliSources() {
  const files = await glob("src/**/*.{ts,tsx}", {
    ignore: ["src/generated/**", "**/*.test.ts"],
  });
  const sources = new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf-8")] as const),
    ),
  );
  const operations = getAllEndpoints().flatMap((endpoint) =>
    endpoint.fn
      ? [
          {
            functionName: endpoint.fn,
            method: endpoint.method,
            path: endpoint.path,
          },
        ]
      : [],
  );
  return { operations, analysis: analyzeSourceApiUsage(sources, operations) };
}
