/**
 * The endpoint rules of a target-scoped invocation (`limitToTarget`), read
 * by `scopeRequest` in `target-scope.ts`. Paths are relative to `/api/0/`:
 * `:name` is one segment, `**` is any number of them.
 *
 * Most rules come from Sentry's schema: endpoints declare how they stay in
 * a project with the `x-sentry-project-scope` OpenAPI extension, which the
 * `@sentry/api` catalog carries as `projectScope`, and
 * `script/generate-api-schema.ts` extracts at build time (see
 * {@link catalogRules}). The rest are written here ({@link OVERRIDES}).
 *
 * In a project scope, a request no rule matches is refused. When a command
 * needs a new endpoint, declare its scope in Sentry; write a rule here only
 * when the schema can't say it.
 */

import generatedProjectScopes from "../generated/project-scope-operations.json" with { type: "json" };

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
  | LookUpFirst
  /** Refused even though a broader rule would cover it. */
  | { kind: "refused" };

/**
 * A request that reads or changes something an ID names, without saying
 * its project: what it names is looked up first, through a `response`
 * rule. A request that names nothing to look up is refused.
 */
type LookUpFirst = {
  kind: "look-up-first";
  lookups: (
    params: Record<string, string>,
    url: URL,
  ) => { path: string; query?: string }[];
};

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
 * An operation of the `@sentry/api` catalog with an `x-sentry-project-scope`
 * other than `path`, as `script/generate-api-schema.ts` extracts it.
 */
export type ProjectScopeOperation = {
  /** Uppercase HTTP method */
  method: string;
  /** OpenAPI path template, such as `/api/0/organizations/{org}/issues/` */
  path: string;
  /** `filter`, `org-metadata` or `response:<pointer>` */
  scope: string;
};

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
 * The values at a JSON pointer (RFC 6901), where a `*` segment is every
 * element of an array, such as each of a release's `projects`.
 */
function valuesAt(body: unknown, pointer: string): unknown[] {
  let values = [body];
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    values = values.flatMap((value) => {
      if (segment === "*") {
        return Array.isArray(value) ? value : [];
      }
      return Array.isArray(value)
        ? [value[Number(segment)]]
        : [record(value)[segment]];
    });
  }
  return values;
}

/** The rule pattern of a catalog path: `{name}` becomes `:name`. */
function patternOf(path: string): string {
  return path.replace(/^\/api\/0\//, "").replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * What a lookup's last path param names, for errors: `Issue 200` for
 * `organizations/:org/issues/:issue_id/`.
 */
function subjectOf(pattern: string) {
  const parts = pattern.split("/").filter(Boolean);
  const param = parts.at(-1)?.slice(1) ?? "";
  const kind = (parts.at(-2) ?? "").replace(/s$/, "").replaceAll("-", " ");
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return (params: Record<string, string>): string =>
    `${label} ${params[param] ?? ""}`;
}

/** The concrete path a pattern names, from a rule's params. */
function pathFrom(pattern: string) {
  return (params: Record<string, string>): string =>
    pattern.replace(/:([^/]+)/g, (_, name: string) =>
      encodeURIComponent(params[name] ?? ""),
    );
}

const RESPONSE_PREFIX = "response:";

/**
 * The rules Sentry declares for its endpoints with `x-sentry-project-scope`:
 *
 * - `org-metadata`: an organization read with no project's data in it.
 * - `filter`: an organization endpoint filtered to the scope's project.
 * - `response:<pointer>`: a lookup by an ID alone, checked by the project
 *   IDs at the pointer of its response. A request under its path (`PUT`
 *   of the same path, or any sub-resource) looks it up first.
 */
export function catalogRules(entries: unknown): {
  orgReads: SimpleRule[];
  rules: ScopeRule[];
} {
  const orgReads: SimpleRule[] = [];
  const checked: ScopeRule[] = [];
  const lookedUpFirst: ScopeRule[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const { method, path, scope } = record(entry);
    if (
      typeof method !== "string" ||
      typeof path !== "string" ||
      typeof scope !== "string"
    ) {
      continue;
    }
    const pattern = patternOf(path);
    const methods = method === "GET" ? READS : [method];
    if (scope === "org-metadata" && method === "GET") {
      orgReads.push({ pattern, methods });
    } else if (scope === "filter") {
      checked.push({ pattern, methods, enforce: { kind: "project-filter" } });
    } else if (scope.startsWith(RESPONSE_PREFIX) && method === "GET") {
      const pointer = scope.slice(RESPONSE_PREFIX.length);
      const own = pathFrom(pattern);
      const subject = subjectOf(pattern);
      checked.push({
        pattern,
        subject,
        enforce: {
          kind: "response",
          projects: (body) => {
            const refs = valuesAt(body, pointer).map(ref);
            return refs.length > 0 ? refs : [undefined];
          },
          path: own,
        },
      });
      lookedUpFirst.push({
        pattern: `${pattern}**`,
        methods: ANY_METHOD,
        subject,
        enforce: {
          kind: "look-up-first",
          lookups: (params) => [{ path: own(params) }],
        },
      });
    }
  }
  return { orgReads, rules: [...checked, ...lookedUpFirst] };
}

const CATALOG = catalogRules(generatedProjectScopes);

/**
 * Read-only organization metadata a project scope may read: what Sentry
 * declares `org-metadata`, and the reads its schema doesn't publish.
 */
export const ORG_READS: readonly SimpleRule[] = [
  // getsentry's subscription details, outside Sentry's schema.
  { pattern: "customers/:org/" },
  ...CATALOG.orgReads,
];

/**
 * One project's ref: its slug when it has one, which the scope can check
 * without looking up its own project's ID.
 */
function refOf(slug: unknown, id: unknown): string | undefined {
  return ref(slug) ?? ref(id);
}

/** `{ project: { slug, id } }`, as an issue carries it. */
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
      ...(Array.isArray(fields["children"]) ? traceProjects(fields["children"]) : []),
    ];
  });
}

const tracePath = pathFrom("organizations/:org/trace/:trace/");

/** A trace lookup for `trace-meta` and `trace-logs`, over the same period. */
function traceLookup(
  params: Record<string, string>,
  url: URL,
): { path: string; query: string } {
  const query = new URLSearchParams();
  for (const name of ["statsPeriod", "start", "end"]) {
    const value = url.searchParams.get(name);
    if (value) {
      query.set(name, value);
    }
  }
  if (!query.has("statsPeriod") && !query.has("start")) {
    query.set("statsPeriod", "14d");
  }
  return { path: tracePath(params), query: query.toString() };
}

/**
 * Rules the catalog can't give: endpoints Sentry's schema doesn't publish
 * (short IDs, event IDs, share links, traces), endpoints that don't do what
 * their schema says (`trace-logs` ignores `project`), and release writes.
 */
const OVERRIDES: readonly ScopeRule[] = [
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
    // A release can span projects, so changing one reaches past the scope.
    pattern: "organizations/:org/releases/:version/**",
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    subject: ({ version }) => `Release ${version}`,
    enforce: { kind: "refused" },
  },
];

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
  ...OVERRIDES,
  ...CATALOG.rules,
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
