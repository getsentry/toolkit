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

import { readdirSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import generatedTargets from "../generated/completion-targets.json";
import type {
  CompletionValues,
  DatasetCompletion,
  DatasetFields,
} from "./completion-target.js";
import { getConfiguredSentryUrl } from "./constants.js";
import {
  type AccountSummary,
  accountSelectorOf,
  accountServerOf,
  listAccounts,
} from "./db/accounts.js";
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
import { silenceReadonlyHandling } from "./db/resilient.js";
import { getEnv } from "./env.js";
import type { GitCompletion } from "./git.js";
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
 * Run `sentry __complete`.
 *
 * `src/bin.ts` and the npm package's `dist/bin.cjs` (`dist/complete.cjs`)
 * call this before anything else of the CLI loads, so a TAB press loads only
 * this module's imports. `test/script/cli-startup.test.ts` keeps them free of
 * `@sentry/node`, the API client, and the command tree.
 *
 * @param args - The words after `__complete`
 */
export async function runCompletion(args: string[]): Promise<void> {
  // Keeps the database modules from requiring telemetry and `@sentry/node`
  getEnv().SENTRY_CLI_NO_TELEMETRY = "1";
  // A read-only cli.db must not print a warning on every TAB press
  silenceReadonlyHandling();
  await handleComplete(args);
}

/**
 * Complete the shell words in `args`: parses them to determine what kind of
 * completion is needed, queries the cache, and writes results to stdout.
 *
 * @param args - The words after `__complete` (COMP_WORDS[1:] from the shell)
 */
async function handleComplete(args: string[]): Promise<void> {
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
 * route group path → its subcommands and their briefs, and the fixed
 * values completers offer, from `src/generated/completion-targets.json`.
 *
 * Generated from the parsers the commands declare (see
 * `completion-target.ts`) by `script/generate-completion-targets.ts`
 * because this fast path cannot boot Stricli to walk the route tree, nor
 * load the modules those values come from.
 */
const GENERATED = generatedTargets as {
  commands: CommandCompletions;
  groups: Record<string, Record<string, string>>;
  values: CompletionValues;
};

/** What a completer reads besides the partial. */
type CompleterContext = {
  /** Positionals before the word being completed, flags removed. */
  positionals: string[];
  /**
   * The value of each flag given before the word being completed, by its
   * `--name` spelling (`-d spans` and `--dataset=spans` as `--dataset`).
   */
  flagValues: Readonly<Record<string, string>>;
  /** The values a `choice` or `choice-list` argument offers. */
  choices?: readonly string[];
  /** The fields and aggregates a field or aggregate flag completes. */
  datasets?: DatasetCompletion;
};

/** What the word being completed is, and the positionals typed before it. */
type CompletionSlot = CompleterContext & {
  kind: CompletionTarget | null;
  /** The flags the word can name if it starts with `-`. */
  flagNames: Completion[];
};

/** A flag's spelling without the value given with `=` (`--period=7d`). */
const FLAG_VALUE_RE = /=.*$/s;

/** Where a flag's spelling ends and its value begins (`--period=7d`). */
const FLAG_VALUE_SEPARATOR = /=(.*)/s;

/** The `--name` spelling of each of the command's flag spellings. */
function flagNameOf(
  command: CommandCompletions[string],
): (spelling: string) => string {
  const names = new Map<string, string>();
  for (const [name, { aliases = [] }] of Object.entries(
    command.flagNames ?? {},
  )) {
    for (const alias of aliases) {
      names.set(alias, name);
    }
  }
  return (spelling) => names.get(spelling) ?? spelling;
}

/**
 * The command's visible flags and their aliases, with their briefs, except
 * those already in `words`. Variadic flags may be given again.
 */
function remainingFlagNames(
  command: CommandCompletions[string],
  words: readonly string[],
): Completion[] {
  const given = new Set(words.map((word) => word.replace(FLAG_VALUE_RE, "")));
  return Object.entries(command.flagNames ?? {}).flatMap(
    ([name, { brief, aliases = [], variadic }]) => {
      const spellings = [name, ...aliases];
      return !variadic && spellings.some((spelling) => given.has(spelling))
        ? []
        : spellings.map((value) => ({ value, description: brief }));
    },
  );
}

/**
 * Find the argument the word being completed fills.
 *
 * Commands are leaves of the route tree, so at most one prefix of the
 * preceding words names a command; the rest are positionals and flags. A
 * value-taking flag written as `--period 7d` consumes the next word;
 * `--period=7d` is a single word. Other `-`-prefixed words are flags, and
 * like Stricli's scanner, a flag ends the one before it instead of becoming
 * its value: an `inferEmpty` flag such as `--time-series` then takes an
 * empty value, and any other flag would be a usage error anyway. For the
 * same reason, a word starting with `-` names a flag even after one that
 * takes a value.
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
    const flagValues: Record<string, string> = {};
    const nameOf = flagNameOf(command);
    let flag: string | undefined;
    for (const word of words.slice(length)) {
      if (word.startsWith("-")) {
        const [spelling = word, value] = word.split(FLAG_VALUE_SEPARATOR);
        if (value !== undefined) {
          flagValues[nameOf(spelling)] = value;
        }
        flag = value === undefined && word in command.flags ? word : undefined;
      } else if (flag !== undefined) {
        flagValues[nameOf(flag)] = word;
        flag = undefined;
      } else {
        positionals.push(word);
      }
    }
    const flagNames = remainingFlagNames(command, words.slice(length));
    if (flag !== undefined) {
      return {
        kind: command.flags[flag] ?? null,
        positionals,
        flagValues,
        choices: command.choices?.[flag],
        datasets: command.datasets?.[nameOf(flag)],
        flagNames,
      };
    }
    // A variadic positional is a single parameter that every word fills.
    // Its choices are for the first word; the rest are the chosen value's
    // arguments (`cli defaults <key> <value>`).
    const index = command.variadic ? 0 : positionals.length;
    const choices =
      command.variadic && positionals.length > 0
        ? undefined
        : command.choices?.[index];
    return {
      kind: command.positionals[index] ?? null,
      positionals,
      flagValues,
      choices,
      flagNames,
    };
  }
  return;
}

/**
 * Suggests values for one completion kind. Completers that need a parser
 * import it when called, so other completions never load it.
 */
type Completer = (
  partial: string,
  slot: CompleterContext,
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

/**
 * The completer of every kind a parser can declare. Its keys are the
 * kinds: {@link CompletionTarget} is derived from them.
 */
const COMPLETERS = Object.freeze({
  /** Organization slugs only (e.g. `org`, `org/version`, `org/id`). */
  org: (partial) => completeOrgSlugs(partial),
  /** `org/` prefixes, `org/project` pairs, and project aliases. */
  "org/project": (partial) => completeOrgSlashProject(partial),
  /** What `org/project` does plus cached issue short IDs. */
  issue: entityCompleter("issue", completeOrgSlashProject),
  /**
   * `org/` prefixes and cached dashboards (`org/<id>`), in the first word
   * only: in `<org/project> <id-or-title>`, the org of the second word is
   * for the dashboard grammar to decide, and this fast path cannot load it.
   */
  dashboard: (partial, slot) =>
    slot.positionals.length > 0 ? [] : completeDashboards(partial),
  /** The term at the end of an issue search query (`is:`, `level:`). */
  "issue-query": async (partial) => {
    const { completeSearchQuery } =
      await import("@sentry/toolkit-core/search-query");
    return completeSearchQuery(partial, GENERATED.values.issueSearch).map(
      (value) => ({ value }),
    );
  },
  /** Relative `--period` values (`24h`, `7d`, a number plus a unit). */
  period: (partial) => completePeriods(partial),
  /** `project create` `name:platform` specs: `org/` prefixes, then platforms. */
  "project-spec": (partial) => completeProjectCreateSpec(partial),
  /** Stored accounts (`sentry auth list`) by email, username, or ID. */
  account: (partial) => completeAccounts(partial),
  /** File and directory paths. */
  file: (partial) => completePaths(partial, { directoriesOnly: false }),
  /** Directory paths only. */
  directory: (partial) => completePaths(partial, { directoriesOnly: true }),
  /**
   * `sentry init`'s `[<target>] [<directory>]`: what `org/project` does, or
   * directories once the word looks like a path (`./`, `../`, `/`, `~/`).
   * At most one of each, in either order.
   */
  "org-project-or-directory": async (partial, slot) => {
    const { looksLikePath } = await import("./arg-parsing.js");
    const [previous, ...rest] = slot.positionals;
    if (rest.length > 0) {
      return [];
    }
    const afterTarget = previous !== undefined && !looksLikePath(previous);
    if (!(afterTarget || looksLikePath(partial))) {
      return completeOrgSlashProject(partial);
    }
    if (previous !== undefined && !afterTarget) {
      return [];
    }
    // Every suggestion must still look like a path: `.` and `~` alone
    // list inside themselves, and a bare word after a target becomes `./…`
    const path =
      partial === "." || partial === "~"
        ? `${partial}/`
        : looksLikePath(partial)
          ? partial
          : `./${partial}`;
    return completePaths(path, { directoriesOnly: true });
  },
  /** A CLI command path, one route segment per word (`help issue list`). */
  "command-path": (partial, slot) =>
    completeSubcommands(slot.positionals.join(" "), partial),
  /** The values its parser was made with by `choiceParser`. */
  choice: (partial, slot) =>
    (slot.choices ?? [])
      .filter((value) => value.startsWith(partial))
      .map((value) => ({ value })),
  /**
   * The values its parser was made with by `choiceListParser`, as the next
   * item of a comma-separated list (`--fields id,ti` → `id,title`).
   */
  "choice-list": (partial, slot) => completeListItem(partial, slot.choices),
  /** Platform identifiers (`javascript-react`, `python-django`, …). */
  platform: (partial) => completePlatforms(partial).map((value) => ({ value })),
  /** Cached environment names. */
  environment: flagEntityCompleter("environment"),
  /** Comma-separated cached environment names. */
  "environment-list": flagEntityCompleter("environment", { list: true }),
  /** Cached release versions. */
  release: flagEntityCompleter("release"),
  /** Cached team slugs. */
  team: flagEntityCompleter("team"),
  /** Cached teams as the `team:<id>` actor an owner flag takes. */
  owner: flagEntityCompleter("owner"),
  /** Project slugs of the org typed, else of every org. */
  project: projectCompleter({ list: false }),
  /** Comma-separated project slugs of the org typed, else of every org. */
  "project-list": projectCompleter({ list: true }),
  /** Comma-separated cached alert (workflow) IDs, described by name. */
  "workflow-list": flagEntityCompleter("workflow", { list: true }),
  /** Cached monitor slugs in the first word; the command to run after it. */
  "monitor-command": (partial, slot) =>
    slot.positionals.length > 0 ? [] : completeMonitors(partial, slot),
  /** Cached native integration IDs, described by provider and name. */
  integration: flagEntityCompleter("integration"),
  /** Cached slugs of installed Sentry Apps. */
  "sentry-app": flagEntityCompleter("sentry-app"),
  /**
   * `name=` of cached Sentry App issue-link form fields, then, once the
   * name is typed, that field's fixed choices (`priority=high`).
   */
  "app-link-field": async (partial, slot) => {
    const fields = await completeAppLinkFields(partial, slot);
    return partial.includes("=")
      ? fields.filter(({ value }) => value.startsWith(partial))
      : fields;
  },
  /** Cached public DSNs, described by the client key name. */
  dsn: flagEntityCompleter("dsn"),
  /** Loopback hosts, every interface, then the addresses of local adapters. */
  "bind-host": (partial) => completeBindHosts(partial),
  /** Cached tag keys of issues, described by their labels. */
  "tag-key": flagEntityCompleter("tag-key"),
  /**
   * Fields of the dataset the command's `--dataset` names: cached attribute
   * or tag keys, or a fixed set (replays).
   */
  field: (partial, slot) => matchFields(partial, slot, datasetFieldsOf(slot)),
  /** What `field` does, then `fn()` and `fn(field)` aggregates. */
  "field-or-aggregate": (partial, slot) =>
    completeAggregates(partial, slot, { fields: true }),
  /** `fn()` and `fn(field)` aggregates of the `--dataset` given. */
  aggregate: (partial, slot) =>
    completeAggregates(partial, slot, { fields: false }),
  /** Dashboard shorthand aggregates: `fn`, then `fn:field`. */
  "aggregate-shorthand": (partial, slot) =>
    completeShorthandAggregates(partial, slot),
  /** Servers of stored accounts. */
  "account-server": (partial) => completeAccountServers(partial),
  /**
   * `issue archive --until` conditions: `forever`, `auto`, durations, and
   * `<n>x` / `<n>u` counts, alone or as `<count>/<window>`.
   */
  "archive-until": (partial) => completeArchiveUntil(partial),
  /** API paths relative to `/api/0/`, one segment at a time. */
  "api-endpoint": (partial) => completeApiEndpoint(partial),
  /** Refs git resolves locally: branches, tags, remote-tracking branches. */
  "git-ref": async (partial) => {
    const { listLocalRefs } = await import("./git.js");
    return completeGit(partial, listLocalRefs());
  },
  /** Branch and tag names as the remote knows them (`origin/main` → `main`). */
  "vcs-ref": async (partial) => {
    const { listVcsRefs } = await import("./git.js");
    return completeGit(partial, listVcsRefs());
  },
  /** Full SHAs of the latest commits of `HEAD`, described by subject. */
  "git-commit": async (partial) => {
    const { listRecentCommits } = await import("./git.js");
    return completeGit(partial, listRecentCommits());
  },
  /** `owner/repo` names of the git remotes. */
  "git-repo": async (partial) => {
    const { listRemoteRepositories } = await import("./git.js");
    return completeGit(partial, listRemoteRepositories());
  },
  /**
   * Comma-separated `REPO@SHA` or `REPO@PREV..SHA` commits: remote
   * `owner/repo` names, then the latest commits of `HEAD`.
   */
  "repo-commit-list": (partial) => completeRepoCommitList(partial),
  /**
   * Free text or numbers, with nothing to suggest (messages, queries, URLs,
   * names of new things, limits). Declared, so that every argument says
   * how it completes.
   */
  text: () => [],
} satisfies Record<string, Completer>);

/** What shell completion suggests for an argument: a key of {@link COMPLETERS}. */
export type CompletionTarget = keyof typeof COMPLETERS;

/**
 * Subcommands of the route group `group` (`""` for the top level) whose
 * names start with the partial, with their briefs.
 */
function completeSubcommands(group: string, partial: string): Completion[] {
  return Object.entries(GENERATED.groups[group] ?? {})
    .filter(([name]) => name.startsWith(partial))
    .map(([value, description]) => ({ value, description }));
}

/**
 * Complete stored accounts with fuzzy matching, written the way
 * `auth switch` and `auth logout` take them: the email (else username,
 * else ID), or `<who>:<server>` when the same user is stored for several
 * servers.
 */
function completeAccounts(partial: string): Completion[] {
  const accounts = listAccounts();
  const whoOf = (account: AccountSummary) =>
    account.email ?? account.username ?? account.id;
  const counts = new Map<string, number>();
  for (const account of accounts) {
    counts.set(whoOf(account), (counts.get(whoOf(account)) ?? 0) + 1);
  }
  const servers = new Map(
    accounts.map((account) => [
      counts.get(whoOf(account)) === 1
        ? whoOf(account)
        : accountSelectorOf(account),
      accountServerOf(account),
    ]),
  );
  return fuzzyMatch(partial, [...servers.keys()], { mode: "search" }).map(
    (value) => ({ value, description: servers.get(value) }),
  );
}

/**
 * Complete the entries of the directory a path partial is in whose names
 * start with its last segment. Directories end in `/`, so the next TAB
 * goes into them; dotfiles are listed only once the segment starts with
 * `.`. A leading `~/` is read from the home directory and kept as typed.
 *
 * @param options.directoriesOnly - Leave out everything but directories
 */
function completePaths(
  partial: string,
  options: { directoriesOnly: boolean },
): Completion[] {
  const parent = partial.slice(0, partial.lastIndexOf("/") + 1);
  const name = partial.slice(parent.length);
  const dir = parent.startsWith("~/")
    ? join(homedir(), parent.slice(2))
    : parent || ".";
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  const completions: Completion[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(name) ||
      (entry.name.startsWith(".") && !name.startsWith("."))
    ) {
      continue;
    }
    const isDirectory =
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        statSync(join(dir, entry.name), {
          throwIfNoEntry: false,
        })?.isDirectory());
    if (isDirectory) {
      completions.push({ value: `${parent}${entry.name}/` });
    } else if (!options.directoriesOnly) {
      completions.push({ value: `${parent}${entry.name}` });
    }
  }
  return completions.sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Complete the last item of a comma-separated list with the `values` that
 * start with it and are not in the list yet, keeping the items before it.
 */
function completeListItem(
  partial: string,
  values: readonly string[] = [],
): Completion[] {
  const head = partial.slice(0, partial.lastIndexOf(",") + 1);
  const item = partial.slice(head.length);
  const chosen = new Set(head.split(","));
  return values
    .filter((value) => value.startsWith(item) && !chosen.has(value))
    .map((value) => ({ value: `${head}${value}` }));
}

/**
 * Platform identifiers matching the partial, best match first: the common
 * ones for an empty partial, any valid one otherwise.
 */
function completePlatforms(partial: string): string[] {
  const candidates = partial === "" ? COMMON_PLATFORMS : VALID_PLATFORMS;
  return fuzzyMatch(partial, candidates, { mode: "search" });
}

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
 * runs the completer for the kind its parser declares. A partial starting
 * with `-` completes the command's flag names instead. Words that name a
 * nested route group (`alert issues`) complete its subcommands; the shell
 * scripts embed the first two levels themselves.
 *
 * @param precedingWords - Words before the partial (determines context)
 * @param partial - The current partial word being completed
 */
export async function getCompletions(
  precedingWords: string[],
  partial: string,
): Promise<Completion[]> {
  const slot = findSlot(precedingWords);
  if (!slot) {
    return precedingWords.length >= 2
      ? completeSubcommands(precedingWords.join(" "), partial)
      : [];
  }
  if (partial.startsWith("-")) {
    return slot.flagNames.filter(({ value }) => value.startsWith(partial));
  }
  return slot.kind ? await COMPLETERS[slot.kind](partial, slot) : [];
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
    return completePlatforms(partial.slice(colonIdx + 1)).map((platform) => ({
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
  const matched = fuzzyMatch(partial, [...nameMap.keys()], {
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
  const matched = fuzzyMatch(projectPartial, [...nameMap.keys()], {
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

/**
 * The org named by the first positional that names one (`my-org/`,
 * `my-org/project`, `my-org/CLI-1`), read like an entity target. Flag
 * values are scoped to it, since they belong to the command's target.
 */
async function positionalOrg(
  positionals: readonly string[],
): Promise<string | undefined> {
  for (const word of positionals) {
    const scope = await parseTargetScope(word);
    if (scope?.org) {
      return scope.org;
    }
  }
  return;
}

/** The orgs whose entities a flag value completes. */
async function flagOrgs(positionals: readonly string[]): Promise<string[]> {
  const org = await positionalOrg(positionals);
  return org ? [org] : getCompletionOrganizations().map(({ slug }) => slug);
}

/**
 * A partial split at its last comma, for values of a comma-separated list:
 * the items before it, kept as typed, and the one being completed.
 */
function splitListItem(
  partial: string,
  list: boolean,
): { head: string; item: string; chosen: Set<string> } {
  const head = list ? partial.slice(0, partial.lastIndexOf(",") + 1) : "";
  return {
    head,
    item: partial.slice(head.length),
    chosen: new Set(head.split(",")),
  };
}

/**
 * Build the completer of a flag (or positional) whose value is a cached
 * entity written bare, as an API filter or body field takes it
 * (`--environment production`, `--team backend`).
 *
 * The entities are those of the org the command's target names (see
 * {@link positionalOrg}), else of every cached org, each value once.
 *
 * @param kind - Entity type to complete
 * @param options.list - The value is a comma-separated list: complete its
 *   last item, leaving out those already in it
 */
function flagEntityCompleter(
  kind: CompletionEntityKind,
  options: { list?: boolean } = {},
): Completer {
  return async (partial, slot) => {
    const { head, item, chosen } = splitListItem(partial, !!options.list);
    const seen = new Set(chosen);
    return matchCachedEntities(kind, item, await flagOrgs(slot.positionals))
      .filter(({ value }) => !seen.has(value) && !!seen.add(value))
      .map(({ value, label }) => ({
        value: `${head}${value}`,
        description: label,
      }));
  };
}

/**
 * Build the completer of project slugs: those of the org the target names,
 * else of every cached org, each once.
 *
 * @param options.list - The value is a comma-separated list: complete its
 *   last item, leaving out those already in it
 */
function projectCompleter(options: { list: boolean }): Completer {
  return async (partial, slot) => {
    const { head, item, chosen } = splitListItem(partial, options.list);
    const names = new Map<string, string>();
    for (const org of await flagOrgs(slot.positionals)) {
      for (const { projectSlug, projectName } of getCachedProjectsForOrg(org)) {
        if (!(chosen.has(projectSlug) || names.has(projectSlug))) {
          names.set(projectSlug, projectName);
        }
      }
    }
    return fuzzyMatch(item, [...names.keys()], { mode: "search" }).map(
      (slug) => ({ value: `${head}${slug}`, description: names.get(slug) }),
    );
  };
}

/**
 * What completes on the dataset the command's `--dataset` names, on its
 * default dataset without one, or on every dataset when it has no default
 * (`dashboard widget edit` keeps the widget's).
 */
function datasetFieldsOf(slot: CompleterContext): DatasetFields[] {
  const completion = slot.datasets;
  if (!completion) {
    return [];
  }
  const given = slot.flagValues["--dataset"]?.toLowerCase();
  const name =
    given === undefined
      ? completion.default
      : (completion.aliases?.[given] ?? given);
  if (name === undefined) {
    return Object.values(completion.datasets);
  }
  const fields = completion.datasets[name];
  return fields ? [fields] : [];
}

/**
 * The fields of `datasets` that match the partial: cached entities of the
 * org the command's target names (else of every org), then fixed fields,
 * each once.
 */
async function matchFields(
  partial: string,
  slot: CompleterContext,
  datasets: readonly DatasetFields[],
): Promise<Completion[]> {
  const found = new Map<string, string | undefined>();
  const orgs = datasets.some(({ entity }) => entity)
    ? await flagOrgs(slot.positionals)
    : [];
  for (const { entity, fields = [] } of datasets) {
    const cached = entity ? matchCachedEntities(entity, partial, orgs) : [];
    for (const { value, label } of cached) {
      if (!found.has(value)) {
        found.set(value, label);
      }
    }
    for (const value of fuzzyMatch(partial, fields, { mode: "search" })) {
      if (!found.has(value)) {
        found.set(value, undefined);
      }
    }
  }
  return [...found].map(([value, description]) => ({ value, description }));
}

/** The aggregate function names of `datasets`, each once. */
function functionsOf(datasets: readonly DatasetFields[]): string[] {
  return [...new Set(datasets.flatMap(({ functions = [] }) => functions))];
}

/**
 * Complete an aggregate call. Before the `(`, the function names that
 * start with the partial, as `fn()`; a name typed in full also completes
 * `fn(field)` for each field, so the shell inserts `fn(` and lists them.
 * After the `(`, `fn(field)` for the fields that match.
 *
 * @param options.fields - The argument also takes a bare field
 *   (`explore --field title`): complete the fields before the functions
 */
async function completeAggregates(
  partial: string,
  slot: CompleterContext,
  options: { fields: boolean },
): Promise<Completion[]> {
  const datasets = datasetFieldsOf(slot);
  const functions = functionsOf(datasets);
  const calls = async (name: string, argument: string) => [
    ...(argument === "" ? [{ value: `${name}()` }] : []),
    ...(await matchFields(argument, slot, datasets)).map(
      ({ value, description }) => ({ value: `${name}(${value})`, description }),
    ),
  ];
  const open = partial.indexOf("(");
  if (open !== -1) {
    const name = partial.slice(0, open);
    return functions.includes(name)
      ? await calls(name, partial.slice(open + 1))
      : [];
  }
  const names = functions.filter((name) => name.startsWith(partial));
  return [
    ...(options.fields ? await matchFields(partial, slot, datasets) : []),
    ...(names.includes(partial) ? await calls(partial, "") : []),
    ...names
      .filter((name) => name !== partial)
      .map((name) => ({ value: `${name}()` })),
  ];
}

/**
 * Complete a dashboard shorthand aggregate: the function names that start
 * with the partial, then, after `fn:`, `fn:field` for the fields that
 * match (`p95:span.duration`). A word starting with `-` completes flag
 * names, so a descending sort's `-` is typed after completing.
 */
async function completeShorthandAggregates(
  partial: string,
  slot: CompleterContext,
): Promise<Completion[]> {
  const datasets = datasetFieldsOf(slot);
  const functions = functionsOf(datasets);
  const colon = partial.indexOf(":");
  if (colon === -1) {
    return functions
      .filter((name) => name.startsWith(partial))
      .map((value) => ({ value }));
  }
  const name = partial.slice(0, colon);
  if (!functions.includes(name)) {
    return [];
  }
  return (await matchFields(partial.slice(colon + 1), slot, datasets)).map(
    ({ value, description }) => ({ value: `${name}:${value}`, description }),
  );
}

const completeMonitors = flagEntityCompleter("monitor");

const completeAppLinkFields = flagEntityCompleter("app-link-field");

/** IPv6 link-local addresses, which cannot be bound without a zone. */
const LINK_LOCAL_IPV6_RE = /^fe80:/i;

/**
 * Hosts a Local server can bind: the loopback hosts (the only ones that
 * keep its UI actions), `0.0.0.0` for every interface, then the address of
 * each network adapter, described by the adapter's name.
 */
function completeBindHosts(partial: string): Completion[] {
  const hosts = new Map<string, string>(
    GENERATED.values.loopbackHosts.map((host) => [host, "loopback"]),
  );
  hosts.set("0.0.0.0", "every IPv4 interface");
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const { address, family } of addresses ?? []) {
      if (!(hosts.has(address) || LINK_LOCAL_IPV6_RE.test(address))) {
        hosts.set(address, `${name} (${family})`);
      }
    }
  }
  return [...hosts]
    .filter(([host]) => host.startsWith(partial))
    .map(([value, description]) => ({ value, description }));
}

/** Servers of stored accounts, described by the accounts on each. */
function completeAccountServers(partial: string): Completion[] {
  const accounts = new Map<string, string[]>();
  for (const account of listAccounts()) {
    if (account.host) {
      const who = account.email ?? account.username ?? account.id;
      accounts.set(account.host, [...(accounts.get(account.host) ?? []), who]);
    }
  }
  return [...accounts]
    .filter(([server]) => server.startsWith(partial))
    .map(([value, who]) => ({ value, description: who.join(", ") }));
}

/** Count suffixes of `--until`: events and users. */
const UNTIL_COUNTS: Readonly<Record<string, string>> = {
  x: "more events",
  u: "more users",
};

/** A `--until` count alone (`10x`), which can still take a `/<window>`. */
const UNTIL_COUNT_RE = /^\d+[xu]$/i;

/**
 * Complete an `issue archive --until` condition. A bare number completes
 * to each count (`10x`, `10u`) and duration (`10m`, `10h`, …); a count
 * offers its `/` window, which completes like a duration. Anything else
 * completes the keywords and the duration presets that start with it.
 */
function completeArchiveUntil(partial: string): Completion[] {
  const slash = partial.indexOf("/");
  if (slash !== -1) {
    const head = partial.slice(0, slash + 1);
    return completePeriods(partial.slice(slash + 1)).map(
      ({ value, description }) => ({
        value: `${head}${value}`,
        description: description && `Within the ${description.toLowerCase()}`,
      }),
    );
  }
  if (DIGITS_RE.test(partial)) {
    return [
      ...Object.entries(UNTIL_COUNTS).map(([suffix, what]) => ({
        value: `${partial}${suffix}`,
        description: `Until ${partial} ${what}`,
      })),
      ...completePeriods(partial).map(({ value }) => ({
        value,
        description: `For ${value}`,
      })),
    ];
  }
  if (UNTIL_COUNT_RE.test(partial)) {
    return [
      { value: partial },
      { value: `${partial}/`, description: "Within a time window" },
    ];
  }
  return [
    { value: "forever", description: "Never unarchive" },
    { value: "auto", description: "Until Sentry detects escalation" },
    ...completePeriods(partial),
  ].filter(({ value }) => value.startsWith(partial.toLowerCase()));
}

/** Placeholder segment of an API path template (`{organization_id_or_slug}`). */
const PATH_PARAM_RE = /^\{(\w+)\}$/;

/** Prefixes `api` strips from an endpoint, kept as typed. */
const API_PREFIX_RE = /^\/?(?:api\/0\/)?/;

/**
 * Complete an `api` endpoint one path segment at a time from the API
 * schema's paths. A literal segment completes as itself; an organization
 * or project placeholder completes to the cached orgs or that org's
 * projects; any other placeholder (`{issue_id}`) is typed by the user, so
 * the paths after it match whatever was typed there.
 */
function completeApiEndpoint(partial: string): Completion[] {
  const prefix = API_PREFIX_RE.exec(partial)?.[0] ?? "";
  const typed = partial.slice(prefix.length).split("/");
  const segment = typed.pop() ?? "";
  const done = typed.join("/");
  const head = `${prefix}${done ? `${done}/` : ""}`;
  const next = new Map<string, string | undefined>();
  const add = (value: string, description?: string) => {
    if (value.startsWith(segment) && !next.has(value)) {
      next.set(value, description);
    }
  };
  for (const path of GENERATED.values.apiPaths) {
    const template = path.split("/");
    // Paths end in `/`, so the last element is empty
    if (template.length - 1 <= typed.length) {
      continue;
    }
    const matches = typed.every((word, index) => {
      const part = template[index] ?? "";
      return PATH_PARAM_RE.test(part) ? word !== "" : part === word;
    });
    const part = template[typed.length] ?? "";
    const param = PATH_PARAM_RE.exec(part)?.[1];
    if (!matches) {
      continue;
    }
    if (param === "organization_id_or_slug") {
      for (const { value, description } of completeOrgSlugs("")) {
        add(value, description);
      }
    } else if (param === "project_id_or_slug") {
      const org = typed[template.indexOf("{organization_id_or_slug}")];
      for (const { projectSlug, projectName } of org
        ? getCachedProjectsForOrg(org)
        : []) {
        add(projectSlug, projectName);
      }
    } else if (!param) {
      add(part);
    }
  }
  return [...next].map(([value, description]) => ({
    value: `${head}${value}/`,
    description,
  }));
}

/** Git names that start with the partial, described by their commit subject. */
function completeGit(
  partial: string,
  names: readonly GitCompletion[],
): Completion[] {
  return names
    .filter(({ name }) => name.startsWith(partial))
    .map(({ name, subject }) => ({
      value: name,
      description: subject || undefined,
    }));
}

/**
 * Complete the last commit of a `--commit` list: a remote `owner/repo`
 * with `@`, then a commit SHA after `@` or after `..` in a range.
 */
async function completeRepoCommitList(partial: string): Promise<Completion[]> {
  const { listRecentCommits, listRemoteRepositories } =
    await import("./git.js");
  const { head, item } = splitListItem(partial, true);
  const at = item.indexOf("@");
  if (at === -1) {
    return completeGit(item, listRemoteRepositories()).map(
      ({ value, description }) => ({
        value: `${head}${value}@`,
        description,
      }),
    );
  }
  const range = item.indexOf("..", at);
  const sha = range === -1 ? at + 1 : range + 2;
  return completeGit(item.slice(sha), listRecentCommits()).map(
    ({ value, description }) => ({
      value: `${head}${item.slice(0, sha)}${value}`,
      description,
    }),
  );
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
