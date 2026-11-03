/** CLI conventions for the SDK's build-time API usage analyzer. */

import {
  analyzeSourceApiUsage as analyze,
  type SourceApiOperation,
} from "@sentry/api/source-analysis";

export type { SourceApiOperation } from "@sentry/api/source-analysis";

/** Discover command API usage and DELETE declarations without executing commands. */
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
