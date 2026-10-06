/**
 * Release argument parsing helpers
 *
 * Release versions can contain special characters (`@`, `+`, `.`, `-`)
 * that are valid in version strings but could be confused with org/project
 * slug separators. This module provides version-aware parsing.
 */

import { ContextError, ValidationError } from "../../lib/errors.js";
import { resolveOrg } from "../../lib/resolve-target.js";

/** Slug pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Parse a release positional argument: `[<org>/]<version>`.
 *
 * Unlike `parseSlashSeparatedArg` (which splits on the last slash), release
 * versions can contain slashes themselves, so we split on the FIRST slash
 * only when the prefix looks like a valid org slug.
 *
 * Heuristic: if the part before the first `/` is a valid slug (lowercase
 * alphanumeric + hyphens, no special chars like `@`), treat it as an org.
 * Otherwise, the entire string is the version.
 *
 * @param arg - The raw positional argument (e.g., "my-org/1.0.0" or "sentry-cli@1.0.0")
 * @param usageHint - Usage example for error messages
 * @returns Parsed org slug (optional) and version string
 * @throws {ValidationError} If the version is empty
 */
export function parseReleaseArg(
  arg: string,
  usageHint: string
): { version: string; orgSlug?: string } {
  const firstSlash = arg.indexOf("/");

  if (firstSlash > 0) {
    const prefix = arg.slice(0, firstSlash);
    const rest = arg.slice(firstSlash + 1);

    // Only treat as org/version if the prefix is a valid slug
    // (no @, +, or other special chars that appear in version strings)
    if (SLUG_RE.test(prefix) && rest.length > 0) {
      return { orgSlug: prefix, version: rest };
    }
  }

  if (!arg) {
    throw new ValidationError(
      `Release version is required.\n\n  Usage: ${usageHint}`,
      "version"
    );
  }

  return { version: arg };
}

/** A fully-resolved release target: a concrete org plus the release version. */
export type ResolvedReleaseTarget = {
  /** The release version (never empty). */
  version: string;
  /** The resolved organization slug. */
  org: string;
  /** Source description when the org was auto-detected (e.g. from a DSN). */
  detectedFrom?: string;
};

/**
 * Resolve a single release positional argument into a concrete `{ version, org }`.
 *
 * Centralizes the version-only release-command boilerplate: it parses the
 * `[<org>/]<version>` target, resolves the organization (from the parsed prefix
 * or the surrounding project context), and raises consistent {@link ContextError}s
 * when the version is missing or no organization can be determined.
 *
 * Commands pass a single required positional (Stricli `kind: "tuple"`), so callers
 * never need to join variadic args — preventing the silent
 * `args.join(" ")` defect where extra positionals were swallowed into the version.
 *
 * @param target - The raw positional argument (e.g. `1.0.0` or `my-org/1.0.0`)
 * @param usageHint - Single-line usage example for error messages
 * @param cwd - Current working directory, used for context-based org detection
 * @returns The resolved version and organization
 * @throws {ContextError} If the version is empty or the org cannot be resolved
 */
export async function resolveReleaseTarget(
  target: string | undefined,
  usageHint: string,
  cwd: string
): Promise<ResolvedReleaseTarget> {
  const trimmed = target?.trim();
  if (!trimmed) {
    throw new ContextError("Release version", usageHint, []);
  }

  const { version, orgSlug } = parseReleaseArg(trimmed, usageHint);
  const resolved = await resolveOrg({ org: orgSlug, cwd });
  if (!resolved) {
    throw new ContextError("Organization", usageHint);
  }

  return { version, org: resolved.org, detectedFrom: resolved.detectedFrom };
}
