/**
 * `[<org>/][<project>]` target positionals.
 *
 * Each parser here hands `func` an {@link OrgProjectTarget}: the
 * {@link ParsedOrgProject} (parsed on first property access) plus a
 * `resolved` promise bound to the resolver the positional declares. A
 * command reads `target.type` when it needs the parsed form and awaits
 * `target.resolved` for the org and project, without choosing or calling a
 * parser or resolver itself. An omitted target arrives as auto-detect. See
 * `positional-parse.ts` for when parsing and resolution run.
 */

import { type ParsedOrgProject, parseOrgProjectArg } from "./arg-parsing.js";
import { ORG_PROJECT_TARGET } from "./completion-target.js";
import { type LazyPositional, lazyPositional } from "./positional-parse.js";
import {
  type ResolvedOrgOptionalTarget,
  type ResolvedProjectBoundTarget,
  resolveOrgOptionalTarget,
  resolveProjectBoundTarget,
} from "./resolve-target.js";

/** A parsed `[<org>/][<project>]` target that resolves to `R`. */
export type OrgProjectTarget<R> = LazyPositional<ParsedOrgProject, R>;

/** What a target resolver gets from the command context. */
export type TargetContext = { readonly cwd: string };

/**
 * Positional parser for an `[<org>/][<project>]` target with its own
 * resolver. Completes like `parseOrgProjectTarget`.
 *
 * @param resolve - Turns the parsed target into what `target.resolved`
 *   yields
 */
export function orgProjectTarget<R>(
  resolve: (parsed: ParsedOrgProject, context: TargetContext) => Promise<R>,
): (this: TargetContext, input?: string) => OrgProjectTarget<R> {
  return lazyPositional(
    ORG_PROJECT_TARGET,
    (raw) => parseOrgProjectArg(raw),
    resolve,
  );
}

/** A target resolved with {@link resolveOrgOptionalTarget}. */
export type OrgOptionalTarget = OrgProjectTarget<ResolvedOrgOptionalTarget>;

/**
 * Target for commands that need an org and take an optional project.
 *
 * @param commandName - Command path for usage hints, e.g. `"feedback list"`
 */
export function orgOptionalTarget(commandName: string) {
  return orgProjectTarget((parsed, { cwd }) =>
    resolveOrgOptionalTarget(parsed, cwd, commandName),
  );
}

/** A target resolved with {@link resolveProjectBoundTarget}. */
export type ProjectBoundTarget = OrgProjectTarget<ResolvedProjectBoundTarget>;

/**
 * Target for commands that need a single org and project.
 *
 * @param commandName - Command path for usage hints, e.g. `"trace list"`
 */
export function projectBoundTarget(commandName: string) {
  return orgProjectTarget((parsed, { cwd }) =>
    resolveProjectBoundTarget(parsed, cwd, commandName),
  );
}
