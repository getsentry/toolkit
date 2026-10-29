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
import type {
  CompletionTarget,
  CompletionValues,
} from "./completion-target.js";
import { getConfiguredSentryUrl } from "./constants.js";
import { getCredentialContext } from "./db/auth.js";
import {
  type CachedCompletionEntity,
  type CompletionEntityKind,
  getCachedCompletionEntities,
} from "./db/completion-cache.js";
import { queueCompletionTelemetry } from "./db/completion-telemetry.js";
import { getProjectAliases } from "./db/project-aliases.js";
import { getCachedProjectsForOrg } from "./db/project-cache.js";
import { getCachedOrganizations } from "./db/regions.js";
import { ValidationError } from "./errors.js";
import { fuzzyMatch } from "./fuzzy.js";
import type { CommandCompletions } from "./introspect.js";
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
export async function handleComplete(args: string[]): Promise<void> {
  const startMs = performance.now();

  // The last word is the partial being completed (may be empty)
  const partial = args.at(-1) ?? "";
  // All preceding words form the command path context
  const precedingWords = args.slice(0, -1);

  let completions: Completion[];

  try {
    completions = await getCompletions(precedingWords, partial);
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
 * Command path → completion kind of each positional and value-taking flag,
 * and the fixed values completers offer, from
 * `src/generated/completion-targets.json`.
 *
 * Generated from the parsers the commands declare (see
 * `completion-target.ts`) by `script/generate-completion-targets.ts`
 * because this fast path cannot boot Stricli to walk the route tree, nor
 * load the modules those values come from.
 */
const GENERATED = generatedTargets as {
  commands: CommandCompletions;
  values: CompletionValues;
};

/** What the word being completed is, and the positionals typed before it. */
type CompletionSlot = {
  kind: CompletionTarget | null;
  /** Positionals before the word being completed, flags removed. */
  positionals: string[];
};

/**
 * Find the argument the word being completed fills.
 *
 * Commands are leaves of the route tree, so at most one prefix of the
 * preceding words names a command; the rest are positionals and flags. A
 * value-taking flag written as `--period 7d` consumes the next word;
 * `--period=7d` is a single word. Other `-`-prefixed words are flags, and
 * like Stricli's scanner, a flag ends the one before it instead of becoming
 * its value: an `inferEmpty` flag such as `--time-series` then takes an
 * empty value, and any other flag would be a usage error anyway.
 *
 * @returns The slot, or `undefined` when the words name no command with
 *   completion metadata
 */
function findSlot(words: string[]): CompletionSlot | undefined {
  for (let length = 1; length <= words.length; length++) {
    const command = GENERATED.commands[words.slice(0, length).join(" ")];
    if (!command) {
      continue;
    }
    const positionals: string[] = [];
    let flag: string | undefined;
    for (const word of words.slice(length)) {
      if (word.startsWith("-")) {
        flag = word in command.flags ? word : undefined;
      } else if (flag !== undefined) {
        flag = undefined;
      } else {
        positionals.push(word);
      }
    }
    if (flag !== undefined) {
      return { kind: command.flags[flag] ?? null, positionals };
    }
    // A variadic positional is a single parameter that every word fills
    const index = command.variadic ? 0 : positionals.length;
    return { kind: command.positionals[index] ?? null, positionals };
  }
  return;
}

/**
 * Suggests values for one completion kind. Completers that need a parser
 * import it when called, so other completions never load it.
 */
type Completer = (
  partial: string,
  slot: CompletionSlot,
) => Completion[] | Promise<Completion[]>;

/**
 * `org/` prefixes and `org/<id>` dashboards. Always qualified: dashboard IDs
 * are sequential integers, so a bare ID would be read in whichever org is
 * auto-detected, not the one it was seen in.
 */
const completeDashboards = entityCompleter(
  "dashboard",
  (partial) => (partial.includes("/") ? [] : completeOrgSlugs(partial, "/")),
  { qualify: true },
);

/** The completer of every kind a parser can declare. */
const COMPLETERS: Record<CompletionTarget, Completer> = {
  org: (partial) => completeOrgSlugs(partial),
  "org/project": (partial) => completeOrgSlashProject(partial),
  issue: entityCompleter("issue", completeOrgSlashProject),
  // Only the first word: in `<org/project> <id-or-title>`, the org of the
  // second word is for `parseDashboardPositionalArgs` to decide, and this
  // fast path cannot load it
  dashboard: (partial, slot) =>
    slot.positionals.length > 0 ? [] : completeDashboards(partial),
  "issue-query": async (partial) => {
    const { completeSearchQuery } =
      await import("@sentry/toolkit-core/search-query");
    return completeSearchQuery(partial, GENERATED.values.issueSearch).map(
      (value) => ({ value }),
    );
  },
  period: (partial) => completePeriods(partial),
};

const DIGITS_RE = /^\d+$/;

/**
 * Complete a relative `--period` value: the presets starting with the
 * partial, or, for a bare number, that number with every unit
 * `parsePeriod` accepts (`3` → `3m`, `3h`, `3d`, …).
 */
function completePeriods(partial: string): Completion[] {
  const { periodPresets, periodUnits } = GENERATED.values;
  if (DIGITS_RE.test(partial)) {
    return periodUnits.map((unit) => ({ value: `${partial}${unit}` }));
  }
  return Object.entries(periodPresets)
    .filter(([period]) => period.startsWith(partial))
    .map(([value, description]) => ({ value, description }));
}

/**
 * Determine what completions to provide based on the command context.
 *
 * Finds the argument the partial fills (a positional or a flag value) and
 * runs the completer for the kind its parser declares.
 *
 * @param precedingWords - Words before the partial (determines context)
 * @param partial - The current partial word being completed
 */
export async function getCompletions(
  precedingWords: string[],
  partial: string,
): Promise<Completion[]> {
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

  const slot = findSlot(precedingWords);
  return slot?.kind ? await COMPLETERS[slot.kind](partial, slot) : [];
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

/**
 * Where a partial target points: the cached org it names, if one has been
 * typed, and the rest of the partial after `org/`.
 */
type TargetScope = { org: string | undefined; rest: string };

/**
 * Read the org of a partial target with the parser the commands use
 * (`parseOrgProjectInput`), so completion and execution agree on what
 * names an org. The parser is loaded on demand, so completions that do
 * not need it do not pay for it.
 *
 * @returns The scope, or `undefined` when the partial cannot become a valid
 *   target: the parser rejects it, it is a URL, or it names an org that is
 *   not cached
 */
async function parseTargetScope(
  partial: string,
): Promise<TargetScope | undefined> {
  const { parseOrgProjectInput } = await import("./arg-parsing.js");
  let input: ReturnType<typeof parseOrgProjectInput>;
  try {
    input = parseOrgProjectInput(partial);
  } catch (error) {
    // Partial input that can never become a valid target (e.g. `a/b/c`)
    if (error instanceof ValidationError) {
      return;
    }
    throw error;
  }
  if (input.baseUrl) {
    return;
  }
  const { parsed } = input;
  const named = parsed.type === "auto-detect" ? undefined : parsed.org;
  if (named === undefined) {
    // A bare word or `/word` has no org; only the bare word can still get one
    return partial.includes("/")
      ? undefined
      : { org: undefined, rest: partial };
  }
  const org = fuzzyResolveOrg(named);
  return org
    ? { org, rest: partial.slice(partial.indexOf("/") + 1) }
    : undefined;
}

/**
 * Cached entities of `orgs` matching `partial`, best match first.
 *
 * The partial is matched against both the value and its label (issue or
 * dashboard title), so typing part of a title finds its ID. An empty
 * partial returns the most recently seen entities first.
 */
function matchCachedEntities(
  kind: CompletionEntityKind,
  partial: string,
  orgs: readonly string[],
): CachedCompletionEntity[] {
  const entities = getCachedCompletionEntities(kind, orgs);
  if (partial === "" || entities.length === 0) {
    return entities.slice(0, MAX_ENTITY_COMPLETIONS);
  }
  const candidates = new Set<string>();
  for (const { value, label } of entities) {
    candidates.add(value);
    if (label) {
      candidates.add(label);
    }
  }
  const rank = new Map(
    fuzzyMatch(partial, [...candidates], { mode: "search" }).map(
      (candidate, index) => [candidate, index],
    ),
  );
  const score = ({ value, label }: CachedCompletionEntity) =>
    Math.min(
      rank.get(value) ?? Number.POSITIVE_INFINITY,
      (label ? rank.get(label) : undefined) ?? Number.POSITIVE_INFINITY,
    );
  return entities
    .map((entity) => ({ entity, score: score(entity) }))
    .filter((ranked) => Number.isFinite(ranked.score))
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_ENTITY_COMPLETIONS)
    .map(({ entity }) => entity);
}

/**
 * Build the completer of an entity kind remembered in `completion_cache`.
 *
 * The org part of the argument is read by {@link parseTargetScope}, so
 * every entity kind follows the same rules: the target suggestions for the
 * partial (`org/`, the org's projects, …), then the entities of the org
 * typed, or of every org when none is. Entities are written `org/<value>`
 * after `org/`, when more than one org is known, and with `qualify`, so
 * the value names its org.
 *
 * @param kind - Entity type to complete
 * @param target - Completes the target part of the argument (`org/`,
 *   `org/project`, …), offered next to the entities
 * @param options.qualify - Always write `org/<value>`, for values that do
 *   not identify their org on their own
 */
function entityCompleter(
  kind: CompletionEntityKind,
  target: (partial: string) => Completion[],
  options: { qualify?: boolean } = {},
): (partial: string) => Promise<Completion[]> {
  return async (partial) => {
    const scope = await parseTargetScope(partial);
    if (!scope) {
      return [];
    }
    const orgs = scope.org
      ? [scope.org]
      : getCompletionOrganizations().map((org) => org.slug);
    const qualified =
      options.qualify || scope.org !== undefined || orgs.length > 1;
    return [
      ...target(partial),
      ...matchCachedEntities(kind, scope.rest, orgs).map(
        ({ orgSlug, value, label }) => ({
          value: qualified ? `${orgSlug}/${value}` : value,
          description: label,
        }),
      ),
    ];
  };
}
