/**
 * The endpoint rules of a target-scoped invocation (`limitToTarget`), read
 * by `scopeRequest` in `target-scope.ts`. Paths are relative to `/api/0/`:
 * `:name` is one segment, `**` is any number of them.
 *
 * In a project scope, a request no rule matches is refused. Add a rule when
 * a command needs a new endpoint, and pick how it stays in the project.
 */

/** How a matched request stays in the scope's project. */
type ScopeEnforcement =
  /** The path names the scope's project, as `:project`. */
  | { kind: "project-path" }
  /**
   * An organization endpoint that takes a `project` filter: one is added
   * when the request has none, and another project is refused.
   */
  | { kind: "project-filter" }
  /**
   * A lookup by an ID alone: the response's projects (slugs or numeric IDs)
   * must include the scope's.
   */
  | {
      kind: "response";
      projects: (body: unknown) => (string | undefined)[];
      /** A response that names no project (an empty trace) is let through. */
      emptyIsInScope?: boolean;
      /** The path the response proves in scope, for {@link LookUpFirst}. */
      path?: (params: Record<string, string>) => string;
    }
  | LookUpFirst;

/**
 * A request that reads or changes something an ID names, without saying
 * its project: what it names is looked up first, through a `response`
 * rule. A request that names nothing to look up is refused.
 */
type LookUpFirst = {
  kind: "look-up-first";
  lookups: (params: Record<string, string>, url: URL) => ScopeLookup[];
};

/**
 * A lookup to send, with its query; `widerQuery` is tried when the first
 * names no project (an empty trace).
 */
export type ScopeLookup = { path: string; query?: string; widerQuery?: string };

export type ScopeRule = {
  pattern: string;
  /** Methods the rule covers; reads (`GET`, `HEAD`) when omitted. */
  methods?: readonly string[];
  /** What the request names, for the error (`Issue 123`). */
  subject?: (params: Record<string, string>) => string;
  enforce: ScopeEnforcement;
};

type SimpleRule = Pick<ScopeRule, "pattern" | "methods">;

const READS = ["GET", "HEAD"] as const;
const ANY_METHOD = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Path prefixes whose next segment is an organization. */
export const ORG_PATH_PREFIXES: ReadonlySet<string> = new Set([
  "organizations",
  "projects",
  "teams",
  "customers",
]);

/** Account reads that name no organization, allowed in any scope. */
export const ACCOUNT_READS: readonly SimpleRule[] = [
  // The API index: the token's user and scopes.
  { pattern: "" },
  { pattern: "auth/" },
  { pattern: "users/:user/" },
  // The user's organizations, which DSN detection and organization
  // resolution read. Requests to any but the scope's are still refused.
  { pattern: "organizations/" },
  { pattern: "seer/models/" },
];

/**
 * Read-only organization metadata a project scope may read: settings,
 * members, integrations and saved views, with no project's issues, events
 * or other data in them.
 */
export const ORG_READS: readonly SimpleRule[] = [
  { pattern: "organizations/:org/" },
  { pattern: "organizations/:org/projects/" },
  { pattern: "organizations/:org/teams/" },
  { pattern: "organizations/:org/user-teams/" },
  { pattern: "organizations/:org/members/" },
  { pattern: "organizations/:org/members/:member/" },
  { pattern: "organizations/:org/environments/" },
  // The project a DSN belongs to: its ID, slug and name.
  { pattern: "organizations/:org/dsn-lookup/" },
  { pattern: "organizations/:org/chunk-upload/" },
  { pattern: "organizations/:org/integrations/" },
  { pattern: "organizations/:org/integrations/:integration/**" },
  { pattern: "organizations/:org/config/integrations/" },
  { pattern: "organizations/:org/available-actions/" },
  { pattern: "organizations/:org/sentry-apps/" },
  { pattern: "organizations/:org/sentry-app-installations/" },
  { pattern: "organizations/:org/sentry-app-components/" },
  { pattern: "organizations/:org/repos/" },
  { pattern: "organizations/:org/repos/:repo/commits/" },
  { pattern: "organizations/:org/code-mappings/" },
  { pattern: "organizations/:org/dashboards/" },
  { pattern: "organizations/:org/dashboards/:dashboard/" },
  { pattern: "organizations/:org/dashboards/:dashboard/revisions/" },
  { pattern: "organizations/:org/discover/saved/" },
  { pattern: "organizations/:org/discover/saved/:query/" },
  { pattern: "organizations/:org/group-search-views/" },
  { pattern: "organizations/:org/workflows/:workflow/" },
  { pattern: "teams/:org/:team/**" },
  { pattern: "customers/:org/" },
];

/** `value` as an object, or `{}` when it is not one. */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function ref(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

/**
 * One project's ref: its slug when it has one, which the scope can check
 * without looking up its own project's ID.
 */
function refOf(slug: unknown, id: unknown): string | undefined {
  return ref(slug) ?? ref(id);
}

/** `{ project: { slug, id } }`, as issues and monitors carry it. */
function projectOf(body: unknown): (string | undefined)[] {
  const project = record(record(body)["project"]);
  return [refOf(project["slug"], project["id"])];
}

/** Each span's `project_slug` or `project_id` in a trace's span tree. */
function traceProjects(spans: unknown): (string | undefined)[] {
  if (!Array.isArray(spans)) {
    return [undefined];
  }
  return spans.flatMap((span) => {
    const fields = record(span);
    return [
      refOf(fields["project_slug"], fields["project_id"]),
      ...(Array.isArray(fields["children"])
        ? traceProjects(fields["children"])
        : []),
    ];
  });
}

/** `organizations/<org>/<kind>/<id>/`, from a rule's params. */
function orgPath(kind: string, param: string) {
  return (params: Record<string, string>): string =>
    `organizations/${encodeURIComponent(params["org"] ?? "")}/${kind}/${encodeURIComponent(params[param] ?? "")}/`;
}

const issuePath = orgPath("issues", "issue");
const tracePath = orgPath("trace", "trace");
const monitorPath = orgPath("monitors", "monitor");
const detectorPath = orgPath("detectors", "detector");
const releasePath = orgPath("releases", "version");

/** The widest relative window a trace lookup tries, as `trace view` does. */
const WIDEST_TRACE_PERIOD = "90d";

/**
 * A trace lookup for `trace-meta` and `trace-logs`, over the same period.
 * A relative period is widened to {@link WIDEST_TRACE_PERIOD} when the trace
 * is empty in it, so a trace whose spans are older still proves in scope.
 */
function traceLookup(params: Record<string, string>, url: URL): ScopeLookup {
  const query = new URLSearchParams();
  for (const name of ["statsPeriod", "start", "end"]) {
    const value = url.searchParams.get(name);
    if (value) {
      query.set(name, value);
    }
  }
  if (query.has("start")) {
    return { path: tracePath(params), query: query.toString() };
  }
  const period = query.get("statsPeriod") ?? "14d";
  return {
    path: tracePath(params),
    query: `statsPeriod=${period}`,
    ...(period === WIDEST_TRACE_PERIOD
      ? {}
      : { widerQuery: `statsPeriod=${WIDEST_TRACE_PERIOD}` }),
  };
}

const PROJECT_FILTERED = [
  "issues/",
  "events/",
  "events-timeseries/",
  "events-dropped/",
  "trace-items/attributes/",
  "replays/",
  "replay-count/",
  "monitors/",
  "detectors/",
  "workflows/",
  "releases/",
  "agents/conversations/",
].map((path): ScopeRule => ({
  pattern: `organizations/:org/${path}`,
  // Bulk issue changes (`PUT issues/?id=...`) are filtered the same way.
  methods: path === "issues/" ? ["GET", "HEAD", "PUT", "DELETE"] : READS,
  enforce: { kind: "project-filter" },
}));

/** The rules of a project scope, first match wins. */
export const PROJECT_SCOPE_RULES: readonly ScopeRule[] = [
  {
    pattern: "projects/:org/:project/**",
    methods: ANY_METHOD,
    subject: ({ org, project }) => `Project ${org}/${project}`,
    enforce: { kind: "project-path" },
  },
  {
    pattern: "organizations/:org/projects/:project/**",
    methods: ANY_METHOD,
    subject: ({ org, project }) => `Project ${org}/${project}`,
    enforce: { kind: "project-path" },
  },
  {
    pattern: "organizations/:org/issues/:issue/",
    subject: ({ issue }) => `Issue ${issue}`,
    enforce: { kind: "response", projects: projectOf, path: issuePath },
  },
  {
    pattern: "organizations/:org/issues/:issue/**",
    methods: ANY_METHOD,
    subject: ({ issue }) => `Issue ${issue}`,
    enforce: {
      kind: "look-up-first",
      lookups: (params) => [{ path: issuePath(params) }],
    },
  },
  {
    pattern: "organizations/:org/shortids/:issue/",
    subject: ({ issue }) => `Issue ${issue?.toUpperCase()}`,
    enforce: {
      kind: "response",
      projects: (body) => [
        ref(record(body)["projectSlug"]),
        ...projectOf(record(body)["group"]),
      ],
    },
  },
  {
    pattern: "organizations/:org/shared/issues/:share/",
    subject: ({ share }) => `Shared issue ${share}`,
    enforce: { kind: "response", projects: projectOf },
  },
  {
    pattern: "organizations/:org/eventids/:event/",
    subject: ({ event }) => `Event ${event}`,
    enforce: {
      kind: "response",
      projects: (body) => [ref(record(body)["projectSlug"])],
    },
  },
  {
    // The trace endpoints read every project of the trace, whatever
    // `project` filter they get: a trace is in scope when one of its
    // spans is in the scope's project.
    pattern: "organizations/:org/trace/:trace/",
    subject: ({ trace }) => `Trace ${trace}`,
    enforce: {
      kind: "response",
      projects: traceProjects,
      emptyIsInScope: true,
      path: tracePath,
    },
  },
  {
    pattern: "organizations/:org/trace-meta/:trace/",
    subject: ({ trace }) => `Trace ${trace}`,
    enforce: {
      kind: "look-up-first",
      lookups: (params, url) => [traceLookup(params, url)],
    },
  },
  {
    pattern: "organizations/:org/trace-logs/",
    subject: () => "Trace logs",
    enforce: {
      kind: "look-up-first",
      lookups: (params, url) =>
        url.searchParams
          .getAll("traceId")
          .map((trace) => traceLookup({ ...params, trace }, url)),
    },
  },
  {
    pattern: "organizations/:org/replays/:replay/",
    subject: ({ replay }) => `Replay ${replay}`,
    enforce: {
      kind: "response",
      projects: (body) => [ref(record(record(body)["data"])["project_id"])],
    },
  },
  {
    pattern: "organizations/:org/monitors/:monitor/",
    subject: ({ monitor }) => `Monitor ${monitor}`,
    enforce: { kind: "response", projects: projectOf, path: monitorPath },
  },
  {
    pattern: "organizations/:org/monitors/:monitor/**",
    methods: ANY_METHOD,
    subject: ({ monitor }) => `Monitor ${monitor}`,
    enforce: {
      kind: "look-up-first",
      lookups: (params) => [{ path: monitorPath(params) }],
    },
  },
  {
    pattern: "organizations/:org/detectors/:detector/",
    subject: ({ detector }) => `Alert ${detector}`,
    enforce: {
      kind: "response",
      projects: (body) => [ref(record(body)["projectId"])],
      path: detectorPath,
    },
  },
  {
    pattern: "organizations/:org/detectors/:detector/**",
    methods: ANY_METHOD,
    subject: ({ detector }) => `Alert ${detector}`,
    enforce: {
      kind: "look-up-first",
      lookups: (params) => [{ path: detectorPath(params) }],
    },
  },
  {
    // A release can span projects; one with the scope's project is in it.
    pattern: "organizations/:org/releases/:version/",
    subject: ({ version }) => `Release ${version}`,
    enforce: {
      kind: "response",
      projects: (body) => {
        const projects = record(body)["projects"];
        return Array.isArray(projects)
          ? projects.map((project) =>
              refOf(record(project)["slug"], record(project)["id"]),
            )
          : [undefined];
      },
      path: releasePath,
    },
  },
  {
    pattern: "organizations/:org/releases/:version/**",
    subject: ({ version }) => `Release ${version}`,
    enforce: {
      kind: "look-up-first",
      lookups: (params) => [{ path: releasePath(params) }],
    },
  },
  ...PROJECT_FILTERED,
];

type Match<T> = { rule: T; params: Record<string, string> };

/** Match path segments against a pattern; `undefined` when they differ. */
function matchPattern(
  pattern: string,
  segments: readonly string[],
): Record<string, string> | undefined {
  const parts = pattern.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (const [index, part] of parts.entries()) {
    if (part === "**") {
      return params;
    }
    const segment = segments[index];
    if (segment === undefined) {
      return;
    }
    if (part.startsWith(":")) {
      params[part.slice(1)] = segment;
    } else if (part !== segment) {
      return;
    }
  }
  return parts.length === segments.length ? params : undefined;
}

/** The first rule that covers `method` and `segments`. */
export function matchScopeRule<T extends SimpleRule>(
  rules: readonly T[],
  method: string,
  segments: readonly string[],
): Match<T> | undefined {
  for (const rule of rules) {
    if (!(rule.methods ?? READS).includes(method)) {
      continue;
    }
    const params = matchPattern(rule.pattern, segments);
    if (params) {
      return { rule, params };
    }
  }
  return;
}
