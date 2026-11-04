/**
 * Session constraints (`sentry mcp <org>/[<project>]`, hosted URL
 * constraints) applied to command calls.
 *
 * The runner passes the constrained organization and project to the SDK as
 * the default target (`SENTRY_ORG`/`SENTRY_PROJECT`), which every command
 * uses when a call names no target. This module checks the targets a call
 * does name and refuses one outside the session, or rewrites a bare project
 * into the session's organization. Opaque identifiers (numeric issue IDs,
 * short IDs) carry no organization to check here.
 */

import { UserInputError } from "../errors";
import type { CommandCatalogEntry, JsonSchema } from "../command-catalog";
import type { Constraints } from "../types";
import { commandName } from "./commands";

/** Completion kinds whose positional names a target. */
const TARGET_KINDS = new Set(["org", "org/project", "dashboard", "issue"]);

const URL_PATTERN = /^https?:\/\//i;

type Session = { org: string; project: string | null };

function outside(
  entry: CommandCatalogEntry,
  value: string,
  session: Session,
): UserInputError {
  const scope = session.project
    ? `${session.org}/${session.project}`
    : `${session.org}/`;
  return new UserInputError(
    `\`${commandName(entry)}\` was called with ${JSON.stringify(value)}, which is outside this session's scope (${scope}). Name a target in ${scope}, or leave the target out to use it.`,
  );
}

/** The organization a Sentry URL names: its subdomain or `/organizations/<org>/`. */
function urlOrganization(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const fromPath = /\/organizations\/([^/]+)/.exec(url.pathname)?.[1];
  if (fromPath) {
    return fromPath;
  }
  const [subdomain, ...rest] = url.hostname.split(".");
  // `acme.sentry.io`, but not `sentry.io`, `us.sentry.io`, or a self-hosted host.
  return rest.join(".") === "sentry.io" &&
    subdomain &&
    !/^(?:us|de)$/.test(subdomain)
    ? subdomain
    : undefined;
}

/**
 * Refuse a Sentry URL for another organization.
 *
 * @returns Whether `value` is a URL
 */
function checkUrl(
  entry: CommandCatalogEntry,
  value: string,
  session: Session,
): boolean {
  if (!URL_PATTERN.test(value)) {
    return false;
  }
  const urlOrg = urlOrganization(value);
  if (urlOrg && urlOrg !== session.org) {
    throw outside(entry, value, session);
  }
  return true;
}

/** The title of positional `index`, such as `org/project/trace-id`. */
function positionalTitle(
  positional: JsonSchema | undefined,
  index: number,
): string | undefined {
  const prefix = positional?.prefixItems ?? [];
  const item = index < prefix.length ? prefix[index] : positional?.items;
  return item ? item.title : undefined;
}

/**
 * The completion kind of positional `index`. A variadic positional has one
 * kind; only its first word names a target (`[<org/project>] <title>`),
 * except for issues and `[<org>/]<id>` lists, where every word can.
 */
function positionalKind(
  entry: CommandCatalogEntry,
  index: number,
): string | undefined {
  const kinds = entry.completions?.positional ?? [];
  if (entry.parameters.properties?.positional?.prefixItems) {
    return kinds[index] ?? undefined;
  }
  const kind = kinds[0] ?? undefined;
  return index === 0 || kind === "issue" || kind === "org" ? kind : undefined;
}

/**
 * Check one positional that names a target, and rewrite a bare project
 * (`web`, a project search across organizations) to `<org>/web`.
 *
 * @param leading - The first of several words, which the CLI reads as the
 *   organization in `<org> <id>`
 */
function pinTarget(
  entry: CommandCatalogEntry,
  value: string,
  kind: string,
  catalogTitle: string,
  leading: boolean,
  session: Session,
): string {
  if (URL_PATTERN.test(value)) {
    return value;
  }
  // `target` is `<org>/`, `<org>/<project>`, or `<project>`.
  const title = catalogTitle === "target" ? "org/project" : catalogTitle;
  const segments = value.split("/");
  const titleSegments = title.split("/");
  if (segments.length === 1) {
    const orgWord = title === "org" || (leading && titleSegments[0] === "org");
    if (kind === "org" && orgWord && value !== session.org) {
      throw outside(entry, value, session);
    }
    if (kind === "org/project" && title === "org/project") {
      if (session.project && value !== session.project) {
        throw outside(entry, value, session);
      }
      return `${session.org}/${value}`;
    }
    return value;
  }
  // `<org>/...`: a target whose first segment is the organization. A
  // one-word title (`feedback`, `replay-id-or-url`) takes `<org>/...` too;
  // a slashed title not led by `org` (`trace-id/span-id`) doesn't.
  if (
    titleSegments[0] === "org" ||
    titleSegments.length === 1 ||
    kind === "issue" ||
    kind === "dashboard"
  ) {
    if (segments[0] !== session.org) {
      throw outside(entry, value, session);
    }
    const project = segments[1];
    if (
      session.project &&
      titleSegments[1] === "project" &&
      segments.length >= titleSegments.length &&
      project &&
      project !== session.project
    ) {
      throw outside(entry, value, session);
    }
  }
  return value;
}

/**
 * The organization and project a `sentry api` endpoint names, or `undefined`
 * for an endpoint not scoped to one (`issues/1/`, `organizations/`).
 */
function apiEndpointTarget(
  endpoint: string,
): { org: string; project?: string } | undefined {
  let path = endpoint;
  if (URL_PATTERN.test(endpoint)) {
    try {
      path = new URL(endpoint).pathname;
    } catch {
      return;
    }
  }
  path = path.replace(/^\/+/, "").replace(/^api\/0\//, "");
  const orgPath = /^organizations\/([^/?]+)(?:\/projects\/([^/?]+))?/.exec(
    path,
  );
  if (orgPath?.[1]) {
    return orgPath[2]
      ? { org: orgPath[1], project: orgPath[2] }
      : { org: orgPath[1] };
  }
  const project = /^projects\/([^/?]+)\/([^/?]+)/.exec(path);
  return project?.[1] && project[2]
    ? { org: project[1], project: project[2] }
    : undefined;
}

function pinApiEndpoint(
  entry: CommandCatalogEntry,
  endpoint: string,
  session: Session,
): void {
  const target = apiEndpointTarget(endpoint);
  if (!target) {
    throw new UserInputError(
      `\`${commandName(entry)}\` was called with ${JSON.stringify(endpoint)}, which is not scoped to an organization. In this session, use an endpoint under organizations/${session.org}/${session.project ? ` or projects/${session.org}/${session.project}/` : ""}.`,
    );
  }
  if (
    target.org !== session.org ||
    (session.project && target.project && target.project !== session.project)
  ) {
    throw outside(entry, endpoint, session);
  }
}

/**
 * Apply the session's constraints to a validated call. Returns the
 * positional arguments to run, rewritten where a bare project needed the
 * session's organization.
 *
 * @throws {UserInputError} When the call names a target outside the session
 */
export function pinConstraints(
  entry: CommandCatalogEntry,
  positional: string[],
  flags: Record<string, unknown>,
  constraints: Constraints,
): string[] {
  const org = constraints.organizationSlug;
  if (!org) {
    return positional;
  }
  const session: Session = { org, project: constraints.projectSlug ?? null };

  // `--project` (`release create`, `alert metrics create`)
  const { project } = flags;
  if (
    session.project &&
    typeof project === "string" &&
    project !== session.project
  ) {
    throw outside(entry, project, session);
  }
  for (const value of Object.values(flags)) {
    for (const item of [value].flat()) {
      if (typeof item === "string") {
        checkUrl(entry, item, session);
      }
    }
  }

  if (entry.permission === "method") {
    const [endpoint] = positional;
    if (endpoint !== undefined) {
      pinApiEndpoint(entry, endpoint, session);
    }
    return positional;
  }

  const schema = entry.parameters.properties?.positional;
  return positional.map((value, index) => {
    if (checkUrl(entry, value, session)) {
      return value;
    }
    const kind = positionalKind(entry, index);
    const title = positionalTitle(schema, index);
    return kind && title && TARGET_KINDS.has(kind)
      ? pinTarget(
          entry,
          value,
          kind,
          title,
          index === 0 && positional.length > 1,
          session,
        )
      : value;
  });
}
