/**
 * `[<org>/][<project>]` target positionals.
 *
 * Each parser here hands `func` an {@link OrgProjectTarget}: the
 * {@link ParsedOrgProject} as `target.parsed` plus a `resolved` promise bound
 * to the resolver the positional declares. A
 * command reads `target.parsed.type` when it needs the parsed form and awaits
 * `target.resolved` for the org and project, without choosing or calling a
 * parser or resolver itself. An omitted target arrives as auto-detect. See
 * `positional-parse.ts` for when parsing and resolution run.
 *
 * Commands that take an org and nothing else use {@link orgTarget}, or read
 * one in their own `boundArguments` parser with {@link parseOrgInput}.
 *
 * List commands use {@link listTarget} instead: `dispatchOrgScopedList`
 * resolves each target mode its own way, so `target.resolved` only applies a
 * pasted URL's server and yields the parsed target.
 *
 * Resolution gets the command path from `commandPrefix`, which Stricli's
 * `forCommand` (and the SDK invoker) set on the context, so usage hints need
 * no hand-written command name. Destructive commands (`destructive: true`,
 * which `buildDeleteCommand` sets) refuse an auto-detected target before
 * `func` runs.
 */

import {
  firstNonBlankLine,
  type ListTarget,
  type ListTargetOptions,
  type ParsedOrgProject,
  parseListTargetInput,
  parseOrgProjectInput,
} from "./arg-parsing.js";
import { ORG_PROJECT_TARGET, ORG_TARGET } from "./completion-target.js";
import { ContextError, ValidationError } from "./errors.js";
import { validateResourceId } from "./input-validation.js";
import { requireExplicitTarget } from "./mutate-command.js";
import { type BoundPositional, boundPositional } from "./positional-parse.js";
import {
  type ResolvedOrg,
  type ResolvedOrgOptionalTarget,
  type ResolvedProjectBoundTarget,
  resolveOrg,
  resolveOrgOptionalTarget,
  resolveProjectBoundTarget,
} from "./resolve-target.js";
import { applySentryUrlContext, parseSentryUrl } from "./sentry-url-parser.js";

/** A parsed `[<org>/][<project>]` target that resolves to `R`. */
export type OrgProjectTarget<R> = BoundPositional<ParsedOrgProject, R>;

/** What a target resolver gets from the command context. */
export type TargetContext = {
  readonly cwd: string;
  /** Command path with the program name, e.g. `["sentry", "trace", "list"]` */
  readonly commandPrefix?: readonly string[];
};

/** What a target resolver gets: the context plus the running command's name. */
export type TargetResolveContext = TargetContext & {
  /** Command path for usage hints, e.g. `"trace list"` */
  readonly commandName: string;
};

/**
 * The running command's path without the program name.
 *
 * @throws {Error} When the context has no `commandPrefix`; every caller that
 *   runs a command (Stricli, the SDK invoker) sets it
 */
function commandNameOf(context: TargetContext): string {
  const prefix = context.commandPrefix;
  if (!prefix || prefix.length < 2) {
    throw new Error(
      "Target resolution needs context.commandPrefix (set by Stricli's forCommand)",
    );
  }
  return prefix.slice(1).join(" ");
}

/**
 * Positional parser for an `[<org>/][<project>]` target with its own
 * resolver. Completes `ORG_PROJECT_TARGET`. In a destructive command
 * an auto-detected target fails `requireExplicitTarget` before `func` runs.
 *
 * The parse has no side effects; the server of a pasted Sentry URL is
 * applied when the target resolves, after the auth guard and rc URL check.
 *
 * @param resolve - Turns the parsed target into what `target.resolved`
 *   yields
 */
export function orgProjectTarget<R>(
  resolve: (
    parsed: ParsedOrgProject,
    context: TargetResolveContext,
  ) => Promise<R>,
): (this: TargetContext, input?: string) => OrgProjectTarget<R> {
  return boundPositional(
    ORG_PROJECT_TARGET,
    (raw) => parseOrgProjectInput(raw).parsed,
    async (parsed, context: TargetContext, raw) => {
      const commandName = commandNameOf(context);
      // Parsing again is cheap and pure; it recovers the URL's server
      const { baseUrl } = parseOrgProjectInput(raw);
      if (baseUrl) {
        applySentryUrlContext(baseUrl);
      }
      return await resolve(parsed, { ...context, commandName });
    },
    (parsed, context: TargetContext) =>
      requireExplicitTarget(
        parsed,
        "Project target",
        `sentry ${commandNameOf(context)} <org>/<project>`,
      ),
  );
}

/** A target resolved with {@link resolveOrgOptionalTarget}. */
export type OrgOptionalTarget = OrgProjectTarget<ResolvedOrgOptionalTarget>;

/** Target for commands that need an org and take an optional project. */
export const orgOptionalTarget = orgProjectTarget((parsed, context) =>
  resolveOrgOptionalTarget(parsed, context.cwd, context.commandName),
);

/** A target resolved with {@link resolveProjectBoundTarget}. */
export type ProjectBoundTarget = OrgProjectTarget<ResolvedProjectBoundTarget>;

/** Target for commands that need a single org and project. */
export const projectBoundTarget = orgProjectTarget((parsed, context) =>
  resolveProjectBoundTarget(parsed, context.cwd, context.commandName),
);

/** An org argument, parsed: `org` is `undefined` to auto-detect. */
export type OrgInput = {
  readonly org?: string;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
};

/**
 * Parse an argument that names an org and nothing else, without side
 * effects: `<org>`, `<org>/`, or a Sentry URL with an org in it. Empty or
 * omitted means auto-detect. Also reads the target of an org-scoped ID
 * (`parseIdArguments` with an `orgScoped` kind), which gives `<org>/`.
 *
 * @param usageHint - Usage shown when the argument names a project too
 * @throws {ValidationError} When the argument names a project, a URL has no
 *   org, or the slug has characters no slug has
 */
export function parseOrgInput(
  raw: string | undefined,
  usageHint?: string,
): OrgInput {
  // Like other targets, only the first non-blank line counts (CLI-1RA)
  const text = raw ? firstNonBlankLine(raw) : "";
  if (!text) {
    return {};
  }
  const url = parseSentryUrl(text);
  if (url) {
    if (!url.org) {
      throw new ValidationError(
        `No organization in URL: ${text}`,
        "organization",
      );
    }
    return { org: url.org, baseUrl: url.baseUrl };
  }
  const org = text.endsWith("/") ? text.slice(0, -1) : text;
  if (!org || org.includes("/")) {
    const usage = usageHint ? `\n\nUsage: ${usageHint}` : "";
    throw new ValidationError(
      `Expected an organization, not '${text}': this takes no project.${usage}`,
      "organization",
    );
  }
  validateResourceId(org, "organization slug");
  return { org };
}

/**
 * Resolve a parsed org argument: apply a pasted URL's server, then use the
 * org, or detect one like {@link resolveOrg}.
 *
 * @throws {ContextError} When no org is given and none is detected
 */
export async function resolveOrgInput(
  input: OrgInput,
  cwd: string,
  usageHint: string,
): Promise<ResolvedOrg> {
  if (input.baseUrl) {
    applySentryUrlContext(input.baseUrl);
  }
  const resolved = await resolveOrg({ org: input.org, cwd });
  if (!resolved) {
    throw new ContextError("Organization", usageHint);
  }
  return resolved;
}

/** An org positional ({@link orgTarget}). */
export type OrgTarget = BoundPositional<OrgInput, ResolvedOrg>;

/**
 * Positional parser for an org and nothing else (`sentry org view [<org>]`),
 * parsed with {@link parseOrgInput}; `target.resolved` yields the org and
 * where it was detected from. Completes org slugs.
 */
export const orgTarget = boundPositional(
  ORG_TARGET,
  (raw) => parseOrgInput(raw),
  (input, context: TargetContext) =>
    resolveOrgInput(
      input,
      context.cwd,
      `sentry ${commandNameOf(context)} <org>`,
    ),
);

/**
 * The target of a list command. `target.parsed` is what to list and the name
 * filter, if any; `await target.resolved` yields the same once a pasted
 * Sentry URL's server is applied. List commands hand it to
 * `dispatchOrgScopedList`, which resolves each target mode its own way.
 */
export type ListCommandTarget = BoundPositional<ListTarget, ListTarget>;

/**
 * Positional parser for a list command's `[<org>/][<project>]` target.
 *
 * @param kind - What shell completion suggests: org slugs only for
 *   org-scoped resources, else orgs, projects, and aliases
 */
export function listTarget(
  kind: typeof ORG_TARGET | typeof ORG_PROJECT_TARGET,
  options: ListTargetOptions = {},
): (this: unknown, input?: string) => ListCommandTarget {
  return boundPositional(
    kind,
    (raw) => parseListTargetInput(raw, options).target,
    async (target, _context: unknown, raw) => {
      // Parsing again is cheap and pure; it recovers the URL's server
      const { baseUrl } = parseListTargetInput(raw, options);
      if (baseUrl) {
        applySentryUrlContext(baseUrl);
      }
      return target;
    },
  );
}
