/**
 * sentry schema
 *
 * Browse and search the Sentry API schema. Shows available resources,
 * operations, and endpoint details from the generated API index.
 */

import type { SentryContext } from "../context.js";
import {
  type ApiEndpoint,
  type CommandApiReference,
  findEndpointsByIdentifier,
  findEndpointsByPath,
  getAllEndpoints,
  getEndpointsByResource,
  getResourceSummaries,
  parseEndpointQuery,
  type ResourceSummary,
  type SchemaEndpoint,
  searchEndpoints,
} from "../lib/api-schema.js";
import { buildCommand } from "../lib/command.js";
import { OutputError, ResolutionError } from "../lib/errors.js";
import { bold, cyan, muted, yellow } from "../lib/formatters/colors.js";
import { filterFields } from "../lib/formatters/json.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../lib/formatters/markdown.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { fuzzyMatch } from "../lib/fuzzy.js";
import { getCommandApiReferences, type RouteMap } from "../lib/introspect.js";
import { filterByName, isGlobFilter } from "../lib/list-filter.js";

// ---------------------------------------------------------------------------
// Output data types
// ---------------------------------------------------------------------------

/** Discriminated union of all possible schema command outputs */
type SchemaResult =
  | { kind: "resources"; resources: ResourceSummary[] }
  | { kind: "endpoints"; endpoints: readonly SchemaEndpoint[] }
  | { kind: "endpoint"; endpoint: ApiEndpoint };

// ---------------------------------------------------------------------------
// Human formatters
// ---------------------------------------------------------------------------

/** Format a method string with appropriate coloring */
function formatMethod(method: string): string {
  switch (method) {
    case "GET":
      return cyan(method);
    case "POST":
      return bold(method);
    case "PUT":
      return yellow(method);
    case "DELETE":
      return bold(method);
    default:
      return method;
  }
}

/** Format the resource summary table (default view) */
function formatResourceList(resources: ResourceSummary[]): string {
  if (resources.length === 0) {
    return muted("No resources found.");
  }

  const maxName = Math.max(...resources.map((r) => r.name.length));
  const maxCount = Math.max(
    ...resources.map((r) => String(r.endpointCount).length),
  );
  const padding = 4;

  const header = `${bold("RESOURCE".padEnd(maxName + padding))}${bold("COUNT".padEnd(maxCount + padding))}${bold("METHODS")}`;

  const rows = resources.map((r) => {
    const name = cyan(r.name.padEnd(maxName + padding));
    const count = String(r.endpointCount).padEnd(maxCount + padding);
    const methods = muted(r.methods.join(", "));
    return `${name}${count}${methods}`;
  });

  return [header, ...rows].join("\n");
}

/** Format a flat list of endpoints */
function formatEndpointList(endpoints: readonly SchemaEndpoint[]): string {
  if (endpoints.length === 0) {
    return muted("No endpoints found.");
  }

  const maxMethod = Math.max(...endpoints.map((e) => e.method.length));
  const padding = 2;

  return endpoints
    .map((e) => {
      const colored = formatMethod(e.method);
      const padded = `${colored}${" ".repeat(maxMethod + padding - e.method.length)}`;
      const path = e.path;
      const label = muted(e.summary || e.operationId || e.fn);
      const deprecated = e.deprecated ? yellow(" [deprecated]") : "";
      const evidence = e.match
        ? renderMarkdown(
            [
              ...e.match.reasons
                .slice(0, 2)
                .map((reason) => `- Matches: ${reason}`),
              ...e.match.relatedCommands.map(
                ({ command, note }) =>
                  `- Used by: \`${command}\`${note ? ` — ${note}` : ""}`,
              ),
            ].join("\n"),
          )
        : "";
      return `${padded}${path}  ${label}${deprecated}${evidence ? `\n${evidence}` : ""}`;
    })
    .join("\n");
}

/** Format a single endpoint in detail using mdKvTable + renderMarkdown */
function formatEndpointDetail(endpoint: ApiEndpoint): string {
  const kvRows: [string, string][] = [
    ...(endpoint.summary
      ? [["Summary", endpoint.summary] as [string, string]]
      : []),
    ["Resource", endpoint.resource],
    ["Operation", endpoint.operationId],
    ...(endpoint.fn
      ? [["Function", `\`${endpoint.fn}\``] as [string, string]]
      : []),
  ];

  if (endpoint.deprecated) {
    kvRows.push(["Status", colorTag("yellow", "deprecated")]);
  }

  if (endpoint.pathParams.length > 0) {
    kvRows.push(["Path Params", endpoint.pathParams.join(", ")]);
  }

  if (endpoint.queryParams.length > 0) {
    const parameters = endpoint.queryParameters?.map(
      (parameter) =>
        `${parameter.name}${parameter.required ? " (required)" : ""}` +
        (parameter.enum?.length ? `: ${parameter.enum.join(", ")}` : ""),
    );
    kvRows.push([
      "Query Params",
      (parameters ?? endpoint.queryParams).join("; "),
    ]);
  }

  const heading = `## ${endpoint.method} \`${endpoint.path}\``;
  const parts = [heading, "", mdKvTable(kvRows)];

  if (endpoint.description) {
    parts.push("", endpoint.description);
  }

  return renderMarkdown(parts.join("\n"));
}

/** Human renderer for all schema result variants */
function formatSchemaHuman(data: SchemaResult): string {
  switch (data.kind) {
    case "resources":
      return formatResourceList(data.resources);
    case "endpoints":
      return formatEndpointList(data.endpoints);
    case "endpoint":
      return formatEndpointDetail(data.endpoint);
    default: {
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// JSON transform — strip the internal `kind` discriminant
// ---------------------------------------------------------------------------

/**
 * Transform schema output for JSON serialization.
 * Strips the internal `kind` discriminant and applies `--fields` filtering.
 */
function jsonTransformSchema(data: SchemaResult, fields?: string[]): unknown {
  let result: unknown;
  switch (data.kind) {
    case "resources":
      result = data.resources;
      break;
    case "endpoints":
      result = data.endpoints;
      break;
    case "endpoint":
      result = data.endpoint;
      break;
    default: {
      const _exhaustive: never = data;
      result = _exhaustive;
    }
  }
  if (fields && fields.length > 0) {
    return filterFields(result, fields);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Query resolution
// ---------------------------------------------------------------------------

/**
 * Build the "no resource matches" error for a term that matched nothing.
 *
 * Previously these paths dumped the full resource list via `OutputError`,
 * which rendered byte-identical to a successful `sentry schema` browse and
 * gave no signal that the term matched nothing. A {@link ResolutionError}
 * reports the failure plainly, adds "did you mean" suggestions from a fuzzy
 * match, and exits non-zero so scripts can branch on it.
 */
function noResourceMatchError(resource: string): ResolutionError {
  const names = getResourceSummaries().map((r) => r.name);
  const [closest] = fuzzyMatch(resource, names, { maxResults: 1 });
  const browseHint = "sentry schema";
  const searchHint = `sentry schema --search ${resource}    Search endpoints by keyword`;
  // Lead with the closest resource name when a typo has an obvious fix
  // (e.g. "committers" → "commits"); otherwise point at the full browse.
  const primaryHint = closest ? `sentry schema ${closest}` : browseHint;
  const suggestions = closest
    ? ["sentry schema                    Browse all resources", searchHint]
    : [searchHint];
  return new ResolutionError(
    `Resource "${resource}"`,
    "does not exist in the schema",
    primaryHint,
    suggestions,
  );
}

function queryLabel(resource: string, operation?: string): string {
  return operation ? `${resource} ${operation}` : resource;
}

/** Detect `GET /api/0/...` (quoted or as two positionals) and bare `/api/...` paths. */
function resolvePathQuery(
  resource: string,
  operation?: string,
): { method?: string; path: string } | undefined {
  const raw = operation ? `${resource} ${operation}` : resource;
  const parsed = parseEndpointQuery(raw);
  if (parsed.path) {
    return { method: parsed.method, path: parsed.path };
  }
  return;
}

function lastConcreteSegment(path: string): string | undefined {
  const segs = path.split("/").filter((s) => s.length > 0);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (seg && !seg.startsWith("{")) {
      return seg;
    }
  }
  return;
}

function pathNotFoundError(
  label: string,
  query: { method?: string; path: string },
): never {
  const samePath = findEndpointsByPath(query.path);
  if (query.method && samePath.length > 0) {
    const methods = [...new Set(samePath.map((endpoint) => endpoint.method))]
      .sort()
      .join(", ");
    const example =
      samePath.find((endpoint) => endpoint.method === "GET") ?? samePath[0];
    throw new ResolutionError(
      `Endpoint '${label}'`,
      "does not exist in the schema",
      example
        ? `sentry schema "${example.method} ${example.path}"`
        : "sentry schema",
      [`Available methods at this path: ${methods}`],
    );
  }

  const segment = lastConcreteSegment(query.path);
  const resourceExists =
    segment !== undefined && getEndpointsByResource(segment).length > 0;
  let hint = "sentry schema";
  if (resourceExists) {
    hint = `sentry schema ${segment}`;
  } else if (segment) {
    hint = `sentry schema --search ${segment}`;
  }
  const suggestions = ["sentry schema                    Browse all resources"];
  if (resourceExists && segment) {
    suggestions.unshift(
      `sentry schema --search ${segment}    Search endpoints by keyword`,
    );
  }
  throw new ResolutionError(
    `Endpoint '${label}'`,
    "does not exist in the schema",
    hint,
    suggestions,
  );
}

function resolvePathLookup(
  query: { method?: string; path: string },
  resource: string,
  operation?: string,
): SchemaResult {
  const matches = findEndpointsByPath(query.path, query.method);
  const [single] = matches;
  if (matches.length === 1 && single) {
    return { kind: "endpoint", endpoint: single };
  }
  if (matches.length > 1) {
    return { kind: "endpoints", endpoints: matches };
  }
  throw pathNotFoundError(queryLabel(resource, operation), query);
}

/** Resolve one exact SDK function name or OpenAPI operation ID. */
function resolveIdentifierLookup(
  identifier: string,
  method?: string,
): SchemaResult | undefined {
  const matches = findEndpointsByIdentifier(identifier).filter(
    (endpoint) => !method || endpoint.method === method,
  );
  const [single] = matches;
  if (matches.length === 1 && single) {
    return { kind: "endpoint", endpoint: single };
  }
  if (matches.length > 1) {
    return { kind: "endpoints", endpoints: matches };
  }
  return;
}

const QUERY_WORD_SEPARATOR = /\s+/;

/** Explicit resource globs retain their resource-only behavior. */
function resolveGlobQuery(resource: string): SchemaResult {
  const matched = filterByName(getResourceSummaries(), resource, (entry) => [
    entry.name,
  ]);
  if (matched.length === 0) {
    throw new ResolutionError(
      `Pattern "${resource}"`,
      "matched no resources",
      "sentry schema",
      ["sentry schema --all    List every endpoint in a flat table"],
    );
  }
  const endpoints = matched.flatMap((r) => getEndpointsByResource(r.name));
  return { kind: "endpoints", endpoints };
}

/**
 * Resolve a resource + optional operation into a SchemaResult.
 * Throws ResolutionError for no-match cases; throws OutputError with the
 * resource's endpoints when the resource exists but the operation does not.
 * Path-shaped queries (`GET /api/0/...`) resolve by method+path first. A
 * single exact SDK function name or OpenAPI operation ID resolves directly.
 */
export function resolveResourceQuery(
  resource: string,
  operation?: string,
  references: readonly CommandApiReference[] = [],
): SchemaResult {
  const query = queryLabel(resource, operation);
  const pathQuery = resolvePathQuery(resource, operation);
  if (pathQuery) {
    return resolvePathLookup(pathQuery, resource, operation);
  }

  const parsed = parseEndpointQuery(query);
  const identifierResult = resolveIdentifierLookup(parsed.text, parsed.method);
  if (identifierResult) {
    return identifierResult;
  }

  // Globs remain an explicit resource filter, separate from concept discovery.
  if (!(operation || query.includes(" ")) && isGlobFilter(resource)) {
    return resolveGlobQuery(resource);
  }

  const [resourceName, ...operationWords] = query
    .trim()
    .split(QUERY_WORD_SEPARATOR);
  const resourceEndpoints = getEndpointsByResource(resourceName ?? "");
  const operationQuery = operationWords.join(" ");
  if (operationQuery) {
    const exact = findEndpointsByIdentifier(operationQuery).filter((endpoint) =>
      resourceEndpoints.includes(endpoint),
    );
    if (exact.length === 1 && exact[0]) {
      return { kind: "endpoint", endpoint: exact[0] };
    }
  }

  const matches = searchEndpoints(query, undefined, references);
  if (matches.length > 0) {
    return { kind: "endpoints", endpoints: matches };
  }
  if (operationQuery && resourceEndpoints.length > 0) {
    throw new OutputError({
      kind: "endpoints",
      endpoints: resourceEndpoints,
    } satisfies SchemaResult);
  }
  throw noResourceMatchError(query);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

type SchemaFlags = {
  readonly all: boolean;
  readonly search?: string;
};

export const schemaCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Browse the Sentry API schema",
    fullDescription:
      "Browse and search the Sentry API schema. Shows available resources, " +
      "operations, and endpoint details. Search by API concepts or CLI command paths; " +
      "discovery results explain matches and related commands. Use with --json for machine-readable output.",
    examples: [
      { description: "List all API resources", command: "sentry schema" },
      {
        description: "Browse issue endpoints",
        command: "sentry schema issues",
      },
      {
        description: "Find list operations (there may be multiple candidates)",
        command: "sentry schema issues list",
      },
      {
        description: "Find APIs used by log listing",
        command: "sentry schema log list",
      },
      {
        description:
          "Find APIs used by trace listing, including command aliases",
        command: "sentry schema trace ls",
      },
      {
        description: "Find APIs used by a command group",
        command: "sentry schema alert metrics",
      },
      {
        description: "Find APIs used by a nested command",
        command: "sentry schema alert metrics view",
      },
      {
        description: "Look up an endpoint by its exact operation ID",
        command: "sentry schema listOrganizationEvents",
      },
      {
        description: "Look up an endpoint by HTTP method and path",
        command:
          'sentry schema "GET /api/0/organizations/{organization_id_or_slug}/issues/"',
      },
      {
        description: "Search for monitoring-related endpoints",
        command: "sentry schema --search monitor",
      },
      {
        description: "Browse resources matching a glob",
        command: "sentry schema 'monitor*'",
      },
      {
        description: "Flat list of every endpoint",
        command: "sentry schema --all",
      },
    ],
  },
  output: {
    human: formatSchemaHuman,
    jsonTransform: jsonTransformSchema,
  },
  parameters: {
    flags: {
      all: {
        kind: "boolean",
        brief: "Show all endpoints in a flat list",
        default: false,
      },
      search: {
        kind: "parsed",
        parse: String,
        brief: "Search endpoints by keyword",
        optional: true,
      },
    },
    aliases: { q: "search" },
    positional: {
      kind: "array",
      parameter: {
        brief:
          "API concept, CLI command path, exact operation ID, or METHOD /path",
        parse: String,
        placeholder: "resource",
      },
    },
  },
  async *func(this: SentryContext, flags: SchemaFlags, ...args: string[]) {
    const query = flags.search
      ? [flags.search, ...args].join(" ")
      : args.join(" ");

    // --search takes priority over --all.
    if (flags.all && !flags.search) {
      return yield new CommandOutput<SchemaResult>({
        kind: "endpoints",
        endpoints: getAllEndpoints(),
      });
    }

    if (!query) {
      return yield new CommandOutput<SchemaResult>({
        kind: "resources",
        resources: getResourceSummaries(),
      });
    }

    const { routes } = await import("../app.js");
    const references = getCommandApiReferences(
      routes as unknown as RouteMap,
      parseEndpointQuery(query).text,
    );

    if (flags.search) {
      const results = searchEndpoints(query, undefined, references);
      if (results.length === 0) {
        throw new OutputError({
          kind: "endpoints",
          endpoints: [],
        } satisfies SchemaResult);
      }
      return yield new CommandOutput<SchemaResult>({
        kind: "endpoints",
        endpoints: results,
      });
    }

    return yield new CommandOutput(
      resolveResourceQuery(query, undefined, references),
    );
  },
});
