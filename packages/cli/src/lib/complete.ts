/**
 * Shell completion engine.
 *
 * Handles the `__complete` fast-path: parses completion context from
 * shell words, queries the SQLite cache, and outputs suggestions.
 *
 * Designed for minimal startup time — no Stricli boot, no telemetry,
 * no auth check, no API calls. Opens the SQLite cache directly for ~1ms
 * reads. All data comes from caches already populated by normal CLI
 * usage (org_regions, project_cache, project_aliases, completion_cache).
 *
 * Protocol:
 *   Input:  `sentry __complete <word1> <word2> ... <partial>`
 *   Output: One completion per line to stdout (`value\tdescription`)
 *   Exit:   0 on success (even if no completions)
 */

import generatedTargets from "../generated/completion-targets.json";
import {
  COMPLETION_TARGETS,
  type CompletionTarget,
  DASHBOARD_TARGET,
  ISSUE_TARGET,
  ORG_PROJECT_TARGET,
  ORG_TARGET,
} from "./completion-target.js";
import { getConfiguredSentryUrl } from "./constants.js";
import { getCredentialContext } from "./db/auth.js";
import {
  type CompletionEntityKind,
  DASHBOARD_ENTITY,
  getCachedCompletionEntities,
  ISSUE_ENTITY,
} from "./db/completion-cache.js";
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
        credential.identity,
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
 * Command path → completion target, from `src/generated/completion-targets.json`.
 *
 * Generated from the commands' completion-aware positional parsers (see
 * `completion-target.ts`) by `script/generate-completion-targets.ts`
 * because this fast path cannot boot Stricli to walk the route tree.
 */
const COMMAND_TARGETS = new Map<string, CompletionTarget>(
  COMPLETION_TARGETS.flatMap((kind) =>
    generatedTargets.targets[kind].map((path): [string, CompletionTarget] => [
      path,
      kind,
    ]),
  ),
);

/** Command path → spellings of its flags that take a value. */
const COMMAND_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> =
  generatedTargets.valueFlags;

/**
 * Command path → positional indices that take the target. Commands with a
 * variadic positional are absent: every positional takes the target.
 */
const COMMAND_TARGET_POSITIONS: Readonly<Record<string, readonly number[]>> =
  generatedTargets.targetPositions;

/** The command named by the preceding words and what follows it. */
type CommandMatch = {
  target: CompletionTarget;
  /** Words typed after the command path (positionals and flags). */
  args: string[];
  /** Flags of this command that consume the next word as their value. */
  valueFlags: ReadonlySet<string>;
  /** Positional indices that take the target; `undefined` when all do. */
  targetPositions: readonly number[] | undefined;
};

/** Words typed after a command path, split into positionals and flags. */
type ParsedArgs = {
  positionals: string[];
  /** The word being completed is the value of the last flag (`--period <TAB>`). */
  completingFlagValue: boolean;
};

/**
 * Separate positionals from flags in the words typed after a command path.
 *
 * A value-taking flag written as `--period 7d` consumes the next word;
 * `--period=7d` is a single word. Other `-`-prefixed words are flags.
 */
function parseArgs(match: CommandMatch): ParsedArgs {
  const positionals: string[] = [];
  let expectingValue = false;
  for (const word of match.args) {
    if (expectingValue) {
      expectingValue = false;
    } else if (word.startsWith("-")) {
      expectingValue = match.valueFlags.has(word);
    } else {
      positionals.push(word);
    }
  }
  return { positionals, completingFlagValue: expectingValue };
}

/**
 * Find the completion target declared by the command named in `words`.
 *
 * Commands are leaves of the route tree, so at most one prefix of the
 * preceding words can name a command; everything after it is positionals
 * or flags.
 */
function findCompletionTarget(words: string[]): CommandMatch | undefined {
  for (let length = 1; length <= words.length; length++) {
    const path = words.slice(0, length).join(" ");
    const target = COMMAND_TARGETS.get(path);
    if (target) {
      return {
        target,
        args: words.slice(length),
        valueFlags: new Set(COMMAND_VALUE_FLAGS[path] ?? []),
        targetPositions: COMMAND_TARGET_POSITIONS[path],
      };
    }
  }
  return;
}

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
  partial: string,
): Completion[] {
  // Build the command path from preceding words (e.g., "issue list")
  const cmdPath =
    precedingWords.length >= 2
      ? `${precedingWords[0]} ${precedingWords[1]}`
      : "";

  // `project create` takes `name:platform` specs, not an existing target,
  // so it keeps a dedicated completer instead of a generated target kind.
  if (cmdPath === "project create") {
    return completeProjectCreateSpec(partial);
  }

  const match = findCompletionTarget(precedingWords);
  if (!match) {
    // Not a known command path — no dynamic completions
    return [];
  }
  const args = parseArgs(match);
  if (args.completingFlagValue) {
    // The word is a flag value (e.g. after `--period`), not a target
    return [];
  }
  switch (match.target) {
    case ORG_PROJECT_TARGET:
      return completeOrgSlashProject(partial);
    case ORG_TARGET:
      return completeOrgSlugs(partial);
    case ISSUE_TARGET:
      // `issue link <issue> <url>`: only the issue positional is an issue
      if (match.targetPositions?.includes(args.positionals.length) === false) {
        return [];
      }
      return completeIssues(partial);
    case DASHBOARD_TARGET:
      return completeDashboards(partial, args.positionals);
    default:
      return [];
  }
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
    return fuzzyMatch(platformPartial, candidates, { mode: "search" }).map(
      (platform) => ({
        value: `${specPrefix}${platform}`,
        description: "Platform",
      }),
    );
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
  const matched = fuzzyMatch(partial, Array.from(nameMap.keys()), {
    mode: "search",
  });

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
  orgSlug: string,
): Completion[] {
  const projects = getCachedProjectsForOrg(orgSlug);

  if (projects.length === 0) {
    return [];
  }

  const nameMap = new Map(projects.map((p) => [p.projectSlug, p.projectName]));
  const matched = fuzzyMatch(projectPartial, Array.from(nameMap.keys()), {
    mode: "search",
  });

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
  const matched = fuzzyMatch(partial, keys, { mode: "search" });

  return matched.map((alias) => {
    const entry = aliases[alias];
    return {
      value: alias,
      description: entry ? `${entry.orgSlug}/${entry.projectSlug}` : undefined,
    };
  });
}

/** Most cached-entity suggestions returned for one completion. */
const MAX_ENTITY_COMPLETIONS = 50;

/** Where cached entities are looked up and how their values are written. */
type EntityScope = {
  /** Only suggest entities from this org; all completion orgs otherwise. */
  org?: string;
  /** Prepended to every suggested value (e.g. `my-org/`). */
  prefix?: string;
  /** Always write `org/value`, not only when a value exists in several orgs. */
  qualify?: boolean;
};

/**
 * Complete entities remembered in the `completion_cache` table.
 *
 * Matches the partial against both the value and its label (issue or
 * dashboard title), so typing part of a title finds its ID. An empty partial
 * returns the most recently seen entities first.
 *
 * Without a scope, values are bare unless the same value exists in more than
 * one org, in which case they are written as `org/value` to stay unambiguous.
 *
 * @param kind - Entity type to complete
 * @param partial - Partial value or title
 * @param scope - Optional org restriction and value formatting
 */
export function completeCachedEntities(
  kind: CompletionEntityKind,
  partial: string,
  scope: EntityScope = {},
): Completion[] {
  const orgs = scope.org
    ? [scope.org]
    : getCompletionOrganizations().map((org) => org.slug);
  const entities = getCachedCompletionEntities(kind, orgs);
  if (entities.length === 0) {
    return [];
  }

  let ranked = entities;
  if (partial !== "") {
    const candidates = new Set<string>();
    for (const entity of entities) {
      candidates.add(entity.value);
      if (entity.label) {
        candidates.add(entity.label);
      }
    }
    const rank = new Map(
      fuzzyMatch(partial, [...candidates], { mode: "search" }).map(
        (candidate, index) => [candidate, index],
      ),
    );
    const score = (entity: (typeof entities)[number]) =>
      Math.min(
        rank.get(entity.value) ?? Number.POSITIVE_INFINITY,
        entity.label
          ? (rank.get(entity.label) ?? Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY,
      );
    ranked = entities
      .map((entity) => ({ entity, score: score(entity) }))
      .filter(({ score: s }) => Number.isFinite(s))
      .sort((a, b) => a.score - b.score)
      .map(({ entity }) => entity);
  }

  const orgsPerValue = new Map<string, number>();
  for (const entity of entities) {
    orgsPerValue.set(entity.value, (orgsPerValue.get(entity.value) ?? 0) + 1);
  }

  const prefix = scope.prefix ?? "";
  return ranked.slice(0, MAX_ENTITY_COMPLETIONS).map((entity) => {
    const qualified =
      scope.qualify || (orgsPerValue.get(entity.value) ?? 0) > 1
        ? `${entity.orgSlug}/${entity.value}`
        : entity.value;
    return { value: `${prefix}${qualified}`, description: entity.label };
  });
}

/**
 * Complete an issue positional.
 *
 * Offers everything {@link completeOrgSlashProject} does plus issue short IDs
 * remembered from earlier `issue list` / `issue view` runs:
 * - No slash: `org/` prefixes, aliases, and short IDs (e.g. `CLI-1A2`)
 * - `org/…`: projects in the org and `org/SHORT-ID` for its issues
 *
 * @param partial - The partial issue argument
 */
export function completeIssues(partial: string): Completion[] {
  const slashIdx = partial.indexOf("/");
  if (slashIdx === -1) {
    return [
      ...completeOrgSlashProject(partial),
      ...completeCachedEntities(ISSUE_ENTITY, partial),
    ];
  }

  const orgPart = partial.slice(0, slashIdx);
  const org = orgPart ? fuzzyResolveOrg(orgPart) : undefined;
  if (!org) {
    return [];
  }
  const rest = partial.slice(slashIdx + 1);
  return [
    ...completeProjectSlugs(rest, org),
    ...completeCachedEntities(ISSUE_ENTITY, rest, {
      org,
      prefix: `${org}/`,
    }),
  ];
}

/**
 * Complete a `[<org/project>] <dashboard-id-or-title>` positional.
 *
 * - First positional, no slash: `org/` prefixes and `org/<id>` for
 *   remembered dashboards (the title is shown as description and matched)
 * - First positional, `org/…`: `org/<id>` for that org's dashboards
 * - Second positional: bare IDs for the org named by the first one
 *
 * @param partial - The partial dashboard argument
 * @param positionals - Positional words before the partial (flags removed)
 */
export function completeDashboards(
  partial: string,
  positionals: readonly string[],
): Completion[] {
  if (positionals.length === 1) {
    const orgPart = positionals[0]?.split("/")[0];
    const org = orgPart ? fuzzyResolveOrg(orgPart) : undefined;
    return org
      ? completeCachedEntities(DASHBOARD_ENTITY, partial, { org })
      : [];
  }
  if (positionals.length > 1) {
    return [];
  }

  const slashIdx = partial.indexOf("/");
  if (slashIdx === -1) {
    return [
      ...completeOrgSlugsWithSlash(partial),
      ...completeCachedEntities(DASHBOARD_ENTITY, partial, { qualify: true }),
    ];
  }

  const orgPart = partial.slice(0, slashIdx);
  const org = orgPart ? fuzzyResolveOrg(orgPart) : undefined;
  if (!org) {
    return [];
  }
  return completeCachedEntities(DASHBOARD_ENTITY, partial.slice(slashIdx + 1), {
    org,
    prefix: `${org}/`,
  });
}
