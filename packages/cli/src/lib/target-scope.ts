/**
 * The organization and project an SDK invocation is limited to: the `org`
 * and `project` of `createSentrySDK()`, unless `limitToTarget` is `false`.
 *
 * The limit is enforced in one place, the API transport: every request the
 * CLI sends with a credential goes through {@link scopeRequest}, so no
 * command or API function checks it on its own. A scoped invocation fails
 * closed: a request is sent only when a rule below says how it stays in
 * scope, and any other request, such as one to an endpoint added later, is
 * refused before it is sent.
 *
 * How a request stays in scope:
 *
 * - Its path names the scope's organization (`organizations/<org>/...`,
 *   `projects/<org>/...`) and, in a project scope, its project
 *   (`projects/<org>/<project>/...`).
 * - In a project scope, an organization endpoint that returns data of every
 *   project (issue, event, replay and release lists) is filtered to the
 *   scope's project: a request without a `project` filter gets one, and a
 *   request with another project is refused.
 * - In a project scope, a lookup by an ID alone (an issue, event, trace,
 *   replay, monitor or alert ID, a short ID, a share link) is checked
 *   against the project of what it finds, before the command sees it. A
 *   request that reads or changes something an ID names first looks it up.
 * - A few account reads every invocation may need ({@link ACCOUNT_READS})
 *   and organization settings with no project data ({@link ORG_SETTINGS}).
 */

import type { ScopeRule } from "./target-scope-rules.js";
import { sentry } from "./app-identity.js";
import { getEnv, SCOPE_ORG_ENV_VAR, SCOPE_PROJECT_ENV_VAR } from "./env.js";
import { ResolutionError } from "./errors.js";
import { extractInputUrl } from "./fetch-input.js";
import { logger } from "./logger.js";
import {
  ACCOUNT_READS,
  matchScopeRule,
  ORG_PATH_PREFIXES,
  ORG_SETTINGS,
  PROJECT_SCOPE_RULES,
  record,
} from "./target-scope-rules.js";

const log = logger.withTag("target-scope");

/** The organization, and project if any, an invocation is limited to. */
type TargetScope = { org: string; project?: string };

/** The current invocation's limit, or `undefined` when it has none. */
export function getTargetScope(): TargetScope | undefined {
  const env = getEnv();
  const org = env[SCOPE_ORG_ENV_VAR];
  if (!org) {
    return;
  }
  const project = env[SCOPE_PROJECT_ENV_VAR];
  return project ? { org, project } : { org };
}

/**
 * The command that lists what the scope allows, for a refused subject
 * (`Replay abc`): `replay list`, `trace list` in a project scope (traces
 * need a project), or `issue list`. `event list` takes an issue, not a
 * project, so events get `issue list` too.
 */
function listCommand(subject: string, scope: TargetScope, target: string) {
  const kind = subject.split(" ", 1)[0];
  const listTarget = scope.project ? target : `${target}/`;
  if (kind === "Replay") {
    return sentry`replay list ${listTarget}`;
  }
  if (kind === "Trace" && scope.project) {
    return sentry`trace list ${listTarget}`;
  }
  return sentry`issue list ${listTarget}`;
}

function scopeLabel(scope: TargetScope): string {
  return scope.project ? `${scope.org}/${scope.project}` : scope.org;
}

function outsideScope(subject: string, scope: TargetScope): ResolutionError {
  const target = scopeLabel(scope);
  return new ResolutionError(
    subject,
    `is outside this session's scope (${target})`,
    listCommand(subject, scope, target),
    [`This session can only read or change data in ${target}.`],
  );
}

/** Refuse an organization outside the scope, before a request to it. */
function assertOrgInScope(
  org: string,
  subject: string,
  scope: TargetScope,
): void {
  if (org !== scope.org) {
    throw outsideScope(subject, scope);
  }
}

/** A fetch that sends a request the scope already allows. */
type Send = (input: string) => Promise<Response>;

/** What the transport sends for a request, and the check of its response. */
type ScopedRequest = {
  /** The request to send: the caller's, or one with a `project` filter. */
  input: Request | string | URL;
  /** A response to return instead of sending it (a failed lookup). */
  response?: Response;
  /**
   * Refuse a response outside the scope.
   * @throws {ResolutionError} When it is outside the scope
   */
  verify: (response: Response) => Promise<void>;
};

const NOTHING_TO_VERIFY = async (): Promise<void> => {
  // The request alone keeps it in scope.
};

/** The scope projects' IDs this process looked up, by scope and host. */
const projectIds = new Map<string, Promise<string>>();

/** Paths a `response` rule found in scope, by scope and host. */
const foundInScope = new Set<string>();

/** @internal Test-only: forget the lookups of earlier invocations. */
export function __resetScopeLookupsForTests(): void {
  projectIds.clear();
  foundInScope.clear();
}

/** The parts of a request a rule reads. */
type RequestContext = {
  scope: TargetScope & { project: string };
  url: URL;
  method: string;
  send: Send;
};

function lookupKey({ scope, url }: RequestContext, path: string): string {
  return `${scopeLabel(scope)}|${url.origin}/api/0/${path}`;
}

/** The numeric ID of the scope's project, looked up once per process. */
function scopeProjectId(context: RequestContext): Promise<string> {
  const { scope, url, send } = context;
  const path = `projects/${encodeURIComponent(scope.org)}/${encodeURIComponent(scope.project)}/`;
  const key = lookupKey(context, path);
  let pending = projectIds.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await send(`${url.origin}/api/0/${path}`);
      const id = response.ok ? record(await readJson(response)).id : undefined;
      if (typeof id !== "string" && typeof id !== "number") {
        throw new ResolutionError(
          `Project ${scopeLabel(scope)}`,
          `could not be looked up (HTTP ${response.status})`,
          sentry`project view ${scopeLabel(scope)}`,
          ["This session filters its requests by the project's ID."],
        );
      }
      return String(id);
    })();
    projectIds.set(key, pending);
    pending.catch(() => projectIds.delete(key));
  }
  return pending;
}

/** Project slugs are never entirely numeric, so digits are a project ID. */
const NUMERIC_ID = /^\d+$/;

/**
 * Whether one of `refs`, project slugs or numeric IDs, is the scope's
 * project. The scope project's ID is looked up only when `refs` has no slug.
 */
async function anyScopeProject(
  context: RequestContext,
  refs: readonly (string | undefined)[],
): Promise<boolean> {
  const known = refs.filter((ref) => ref !== undefined);
  const ids = known.filter((ref) => NUMERIC_ID.test(ref));
  if (ids.length < known.length) {
    return known.includes(context.scope.project);
  }
  return ids.length > 0 && ids.includes(await scopeProjectId(context));
}

/** The `project` filter that asks for every project. */
const ALL_PROJECTS = "-1";

/**
 * Filter an organization endpoint to the scope's project: a request with
 * no filter, or one for every project (`-1`), gets the scope's; a request
 * for another project is refused.
 */
async function filterToProject(
  context: RequestContext,
  input: Request | string | URL,
  subject: string,
): Promise<Request | string | URL> {
  const { url, scope } = context;
  const requested = [
    ...url.searchParams.getAll("project"),
    ...url.searchParams.getAll("projectSlug"),
  ].filter((project) => project !== ALL_PROJECTS);
  if (requested.length > 0) {
    for (const project of requested) {
      if (!(await anyScopeProject(context, [project]))) {
        throw outsideScope(subject, scope);
      }
    }
    if (!url.searchParams.getAll("project").includes(ALL_PROJECTS)) {
      return input;
    }
  }
  const filtered = new URL(url);
  const kept = filtered.searchParams
    .getAll("project")
    .filter((project) => project !== ALL_PROJECTS);
  filtered.searchParams.delete("project");
  for (const project of kept) {
    filtered.searchParams.append("project", project);
  }
  if (requested.length === 0) {
    filtered.searchParams.append("project", await scopeProjectId(context));
  }
  return input instanceof Request
    ? new Request(filtered, input)
    : filtered.toString();
}

/** A response body as JSON, or `undefined` when it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch (error) {
    // Not JSON, so it names no project: a `response` rule refuses it.
    log.debug(`Response of ${response.url} is not JSON`, error);
    return;
  }
}

/**
 * Look up what a request names before it reads or changes it, unless an
 * earlier lookup found it in scope. The lookup goes through `send`, so its
 * `response` rule refuses it when it is outside the scope.
 *
 * @returns The failed lookup's response, to return instead, or `undefined`
 */
async function lookUpFirst(
  context: RequestContext,
  { path, query }: { path: string; query?: string },
): Promise<Response | undefined> {
  if (foundInScope.has(lookupKey(context, path))) {
    return;
  }
  const response = await context.send(
    `${context.url.origin}/api/0/${path}${query ? `?${query}` : ""}`,
  );
  if (!response.ok) {
    return response;
  }
  if (!foundInScope.has(lookupKey(context, path))) {
    // The lookup named no project (an empty trace): nothing to read.
    throw outsideScope(
      `${context.method} ${context.url.pathname}`,
      context.scope,
    );
  }
  return;
}

/** Remember that `path` is in scope, so later requests skip the lookup. */
function rememberInScope(context: RequestContext, path: string): void {
  foundInScope.add(lookupKey(context, path));
}

/** Apply a project-scope rule: the request to send, and its check. */
async function applyRule(
  rule: ScopeRule,
  params: Record<string, string>,
  context: RequestContext,
  input: Request | string | URL,
): Promise<ScopedRequest> {
  const { scope } = context;
  const subject =
    rule.subject?.(params) ?? `${context.method} ${context.url.pathname}`;
  switch (rule.enforce.kind) {
    case "project-path":
      if (!(await anyScopeProject(context, [params.project]))) {
        throw outsideScope(subject, scope);
      }
      return { input, verify: NOTHING_TO_VERIFY };
    case "project-filter":
      return {
        input: await filterToProject(context, input, subject),
        verify: NOTHING_TO_VERIFY,
      };
    case "response": {
      const { projects, path, emptyIsInScope } = rule.enforce;
      return {
        input,
        verify: async (response) => {
          if (!response.ok) {
            return;
          }
          const refs = projects(await readJson(response));
          // An empty result (`[]` for a trace) names no project's data.
          if (refs.length === 0 && emptyIsInScope) {
            return;
          }
          if (!(await anyScopeProject(context, refs))) {
            throw outsideScope(subject, scope);
          }
          if (path) {
            rememberInScope(context, path(params));
          }
        },
      };
    }
    case "look-up-first": {
      const targets = rule.enforce.lookups(params, context.url);
      if (targets.length === 0) {
        throw outsideScope(subject, scope);
      }
      for (const target of targets) {
        const failed = await lookUpFirst(context, target);
        if (failed) {
          return { input, response: failed, verify: NOTHING_TO_VERIFY };
        }
      }
      return { input, verify: NOTHING_TO_VERIFY };
    }
    default:
      throw outsideScope(subject, scope);
  }
}

/**
 * Decide how a request stays in the invocation's scope. Every request the
 * transport sends with a credential goes through here.
 *
 * @param input - The request
 * @param init - Its options, for the method
 * @param send - Sends a lookup the scope needs (the scope project's ID, or
 *   what an ID names); its requests come through here too
 * @returns The request to send and the check of its response
 * @throws {ResolutionError} When the request is outside the scope
 */
export async function scopeRequest(
  input: Request | string | URL,
  init: RequestInit | undefined,
  send: Send,
): Promise<ScopedRequest> {
  const scope = getTargetScope();
  if (!scope) {
    return { input, verify: NOTHING_TO_VERIFY };
  }
  const url = new URL(extractInputUrl(input));
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const subject = `${method} ${url.pathname}`;
  const path = url.pathname.startsWith("/api/0/")
    ? url.pathname.slice("/api/0/".length)
    : undefined;
  if (path === undefined) {
    throw outsideScope(subject, scope);
  }
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

  // Every organization path names the scope's organization.
  const [prefix, org] = segments;
  const namesOrg = prefix !== undefined && ORG_PATH_PREFIXES.has(prefix);
  if (namesOrg && org !== undefined) {
    assertOrgInScope(org, subject, scope);
  }
  if (matchScopeRule(ACCOUNT_READS, method, segments)) {
    return { input, verify: NOTHING_TO_VERIFY };
  }
  if (!scope.project) {
    if (namesOrg && org !== undefined) {
      return { input, verify: NOTHING_TO_VERIFY };
    }
    throw outsideScope(subject, scope);
  }
  if (matchScopeRule(ORG_SETTINGS, method, segments)) {
    return { input, verify: NOTHING_TO_VERIFY };
  }
  const match = matchScopeRule(PROJECT_SCOPE_RULES, method, segments);
  if (!match) {
    throw outsideScope(subject, scope);
  }
  return await applyRule(
    match.rule,
    match.params,
    { scope: { ...scope, project: scope.project }, url, method, send },
    input,
  );
}

/**
 * Wrap a fetch that sends requests outside the authenticated transport
 * (a share link's) so the invocation's scope applies to it too.
 */
export function withTargetScope(
  fetchFn: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): (input: Request | string | URL, init?: RequestInit) => Promise<Response> {
  const scoped = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = await scopeRequest(input, init, (lookup) => scoped(lookup));
    if (request.response) {
      return request.response;
    }
    const response = await fetchFn(request.input, init);
    await request.verify(response);
    return response;
  };
  return scoped;
}
