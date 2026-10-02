/**
 * Shell completion engine.
 *
 * Handles the `__complete` fast-path: parses completion context from
 * shell words, queries the SQLite cache, and outputs suggestions.
 *
 * Designed for minimal startup time — no Stricli boot, no telemetry,
 * no auth check, no API calls. Opens the SQLite cache directly for ~1ms
 * reads. All data comes from caches already populated by normal CLI
 * usage (org_regions, project_cache, project_aliases).
 *
 * Protocol:
 *   Input:  `sentry __complete <word1> <word2> ... <partial>`
 *   Output: One completion per line to stdout (`value\tdescription`)
 *   Exit:   0 on success (even if no completions)
 */

import { getConfiguredSentryUrl } from "./constants.js";
import { getCredentialContext } from "./db/auth.js";
import { queueCompletionTelemetry } from "./db/completion-telemetry.js";
import { getProjectAliases } from "./db/project-aliases.js";
import { getCachedProjectsForOrg } from "./db/project-cache.js";
import { getCachedOrganizations } from "./db/regions.js";
import { fuzzyMatch } from "./fuzzy.js";
import { COMMON_PLATFORMS, VALID_PLATFORMS } from "./platforms.js";

const WHITESPACE_RE = /\s/;

/** Never suggest organizations cached under another credential or lookup host. */
function getCompletionOrganizations() {
  const credential = getCredentialContext();
  return credential
    ? getCachedOrganizations(
        getConfiguredSentryUrl() ?? credential.host,
        credential.identity
      )
    : [];
}

/**
 * Completion result with optional description for rich shell display.
 * Shells that support descriptions (zsh, fish) use both fields.
 */
type Completion = {
  value: string;
  description?: string;
};

/**
 * Main entry point for `sentry __complete`.
 *
 * Called from the cli.ts fast-path. Parses the shell words to determine
 * what kind of completion is needed, queries the cache, and writes
 * results to stdout.
 *
 * @param args - The words after `__complete` (COMP_WORDS[1:] from the shell)
 */
export function handleComplete(args: string[]): void {
  const startMs = performance.now();

  // The last word is the partial being completed (may be empty)
  const partial = args.at(-1) ?? "";
  // All preceding words form the command path context
  const precedingWords = args.slice(0, -1);

  let completions: Completion[];

  try {
    completions = getCompletions(precedingWords, partial);
  } catch {
    // Graceful degradation — if DB fails, return no completions
    completions = [];
  }

  // Write completions to stdout, one per line
  const output = completions
    .map((c) => (c.description ? `${c.value}\t${c.description}` : c.value))
    .join("\n");

  if (output) {
    process.stdout.write(`${output}\n`);
  }

  // Queue timing data for the next normal CLI run to emit as Sentry metrics.
  // Pure SQLite write — no Sentry SDK overhead (~1ms).
  const cmdPath =
    precedingWords.length >= 2
      ? `${precedingWords[0]} ${precedingWords[1]}`
      : (precedingWords[0] ?? "");
  queueCompletionTelemetry({
    commandPath: cmdPath,
    durationMs: performance.now() - startMs,
    resultCount: completions.length,
  });
}

/**
 * Commands that accept org/project positional args.
 *
 * Hardcoded for fast-path performance — cannot derive from the route map
 * at runtime because `app.ts` imports `@sentry/node-core`. A property test in
 * `completions.property.test.ts` verifies this set stays in sync.
 *
 * @internal Exported for testing only.
 */
export const ORG_PROJECT_COMMANDS = new Set([
  "dsn list",
  "issue list",
  "issue events",
  "issue view",
  "issue explain",
  "issue plan",
  "issue resolve",
  "issue link",
  "issue unlink",
  "issue unresolve",
  "issue archive",
  "issue merge",
  "feedback list",
  "feedback view",
  "project list",
  "project view",
  "project delete",
  "replay list",
  "replay view",
  "trace list",
  "trace view",
  "trace logs",
  "span list",
  "span view",
  "event view",
  "event list",
  "log list",
  "log view",
  "dashboard list",
  "dashboard view",
  "dashboard create",
  "dashboard revisions",
  "dashboard restore",
]);

/**
 * Commands that accept only an org slug (no project).
 *
 * @internal Exported for testing only.
 */
export const ORG_ONLY_COMMANDS = new Set([
  "agent-conversation list",
  "agent-conversation view",
  "org view",
  "release list",
  "release view",
  "release create",
  "release finalize",
  "release delete",
  "release archive",
  "release restore",
  "release deploy",
  "release deploys",
  "release set-commits",
  "team list",
  "repo list",
  "monitor list",
  "trial list",
  "trial start",
]);

/**
 * Determine what completions to provide based on the command context.
 *
 * Walks the preceding words to identify the command path, then decides
 * whether to complete org slugs, project slugs, or aliases.
 *
 * @param precedingWords - Words before the partial (determines context)
 * @param partial - The current partial word being completed
 */
export function getCompletions(
  precedingWords: string[],
  partial: string
): Completion[] {
  // Build the command path from preceding words (e.g., "issue list")
  const cmdPath =
    precedingWords.length >= 2
      ? `${precedingWords[0]} ${precedingWords[1]}`
      : "";

  if (cmdPath === "project create") {
    return completeProjectCreateSpec(partial);
  }

  if (ORG_PROJECT_COMMANDS.has(cmdPath)) {
    return completeOrgSlashProject(partial);
  }

  if (ORG_ONLY_COMMANDS.has(cmdPath)) {
    return completeOrgSlugs(partial);
  }

  // Not a known command path — no dynamic completions
  return [];
}

/**
 * Complete the required `name:platform` positional used by `project create`.
 *
 * Before the final colon, only organization prefixes are suggested because a
 * create command targets a new project rather than an existing cached project.
 * After the colon, the project-name portion is preserved and valid platform
 * identifiers are completed.
 *
 * @param partial - The partial project specification being completed
 * @returns Organization-prefix or complete name/platform suggestions
 */
export function completeProjectCreateSpec(partial: string): Completion[] {
  if (WHITESPACE_RE.test(partial)) {
    return [];
  }

  const colonIdx = partial.lastIndexOf(":");
  if (colonIdx !== -1) {
    const namePart = partial.slice(0, colonIdx);
    const slashIdx = namePart.indexOf("/");
    if (slashIdx === 0 || namePart.indexOf("/", slashIdx + 1) !== -1) {
      return [];
    }
    const projectName =
      slashIdx === -1 ? namePart : namePart.slice(slashIdx + 1);
    if (projectName === "") {
      return [];
    }

    const specPrefix = partial.slice(0, colonIdx + 1);
    const platformPartial = partial.slice(colonIdx + 1);
    const candidates =
      platformPartial === "" ? COMMON_PLATFORMS : VALID_PLATFORMS;
    return fuzzyMatch(platformPartial, candidates).map((platform) => ({
      value: `${specPrefix}${platform}`,
      description: "Platform",
    }));
  }

  if (partial.includes("/")) {
    return [];
  }

  return completeOrgSlugs(partial, "/");
}

/**
 * Complete organization slugs with fuzzy matching.
 *
 * Queries the org_regions cache for all known org slugs and matches
 * them against the partial input.
 *
 * @param partial - Partial org slug to match
 * @param suffix - Appended to each slug (e.g., "/" for org/project mode)
 * @returns Completions with org names as descriptions
 */
export function completeOrgSlugs(partial: string, suffix = ""): Completion[] {
  const orgs = getCompletionOrganizations();
  if (orgs.length === 0) {
    return [];
  }

  const nameMap = new Map(orgs.map((o) => [o.slug, o.name]));
  const matched = fuzzyMatch(partial, Array.from(nameMap.keys()));

  return matched.map((slug) => ({
    value: `${slug}${suffix}`,
    description: nameMap.get(slug),
  }));
}

/**
 * Complete the `org/project` positional pattern with fuzzy matching.
 *
 * Two modes based on whether the partial contains a slash:
 * - No slash: suggest org slugs with a trailing `/` appended
 * - Has slash: split on first `/`, fuzzy-match project slugs for that org
 *
 * Also includes project aliases (e.g., `A`, `B`) as suggestions.
 *
 * @param partial - The partial input (e.g., "", "sen", "sentry/", "sentry/cl")
 * @returns Completions for org or org/project values
 */
export function completeOrgSlashProject(partial: string): Completion[] {
  const slashIdx = partial.indexOf("/");

  if (slashIdx === -1) {
    // No slash — suggest org slugs (with trailing slash) + aliases
    const orgCompletions = completeOrgSlugsWithSlash(partial);
    const aliasCompletions = completeAliases(partial);
    return [...orgCompletions, ...aliasCompletions];
  }

  // Has slash — complete project within the org.
  // Fuzzy-resolve the org slug first so that "senry/" still finds "sentry" projects.
  const orgPart = partial.slice(0, slashIdx);
  const projectPart = partial.slice(slashIdx + 1);

  // Bare "/" has no org part — can't resolve to a specific org
  if (!orgPart) {
    return [];
  }

  const resolvedOrg = fuzzyResolveOrg(orgPart);
  if (!resolvedOrg) {
    return [];
  }

  return completeProjectSlugs(projectPart, resolvedOrg);
}

/**
 * Complete org slugs and append a trailing `/` to each.
 *
 * When the user types `sentry issue list sen<TAB>`, we want to suggest
 * `sentry/` so they can continue typing the project name.
 */
function completeOrgSlugsWithSlash(partial: string): Completion[] {
  return completeOrgSlugs(partial, "/");
}

/**
 * Complete project slugs for a specific org with fuzzy matching.
 *
 * Reads from the project_cache SQLite table, which is populated by
 * DSN resolution and normal CLI command usage (e.g., `project list`,
 * `issue list`). The HTTP response cache handles API-level caching —
 * we don't make API calls during completion.
 *
 * @param projectPartial - Partial project slug to match
 * @param orgSlug - The org to find projects for
 */
export function completeProjectSlugs(
  projectPartial: string,
  orgSlug: string
): Completion[] {
  const projects = getCachedProjectsForOrg(orgSlug);

  if (projects.length === 0) {
    return [];
  }

  const nameMap = new Map(projects.map((p) => [p.projectSlug, p.projectName]));
  const matched = fuzzyMatch(projectPartial, Array.from(nameMap.keys()));

  return matched.map((slug) => ({
    value: `${orgSlug}/${slug}`,
    description: nameMap.get(slug),
  }));
}

/**
 * Fuzzy-resolve an org slug to its canonical form.
 *
 * When the user types `senry/`, we need to find the actual cached org
 * slug `sentry` so we can query projects for it. Returns the best
 * fuzzy match, or the original slug if it matches exactly.
 *
 * @param orgPart - The potentially misspelled org slug
 * @returns The resolved org slug, or undefined if no match
 */
function fuzzyResolveOrg(orgPart: string): string | undefined {
  const orgs = getCompletionOrganizations();
  if (orgs.length === 0) {
    return;
  }

  const slugs = orgs.map((o) => o.slug);
  const matched = fuzzyMatch(orgPart, slugs, { maxResults: 1 });
  return matched[0];
}

/**
 * Complete project aliases (e.g., `A`, `B` from monorepo detection).
 *
 * Aliases are short identifiers that resolve to org/project pairs.
 * They are shown alongside org slug completions.
 */
export function completeAliases(partial: string): Completion[] {
  const aliases = getProjectAliases();
  if (!aliases) {
    return [];
  }

  const keys = Object.keys(aliases);
  const matched = fuzzyMatch(partial, keys);

  return matched.map((alias) => {
    const entry = aliases[alias];
    return {
      value: alias,
      description: entry ? `${entry.orgSlug}/${entry.projectSlug}` : undefined,
    };
  });
}
