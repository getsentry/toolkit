/**
 * sentry release set-commits
 *
 * Associate commits with a release using auto-discovery or local git history.
 */

import type { SentryContext } from "../../context.js";
import {
  NO_REPO_INTEGRATIONS_MESSAGE,
  setCommitsAuto,
  setCommitsLocal,
  setCommitsWithRefs,
} from "../../lib/api-client.js";
import { buildCommand, numberParser } from "../../lib/command.js";
import { getDatabase } from "../../lib/db/index.js";
import { clearMetadata, getMetadata, setMetadata } from "../../lib/db/utils.js";
import {
  ApiError,
  ValidationError,
  validationError,
} from "../../lib/errors.js";
import {
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  getCommitLog,
  getRepositoryName,
  isShallowRepository,
} from "../../lib/git.js";
import { logger } from "../../lib/logger.js";
import type { SentryRelease } from "../../types/index.js";
import { resolveReleaseTarget } from "./parse.js";

const log = logger.withTag("release.set-commits");

const USAGE_HINT = "sentry release set-commits [<org>/]<version>";

/** Diagnostic note shared by --from validation errors. */
const FROM_RANGE_NOTE =
  "Range is always <ref>..HEAD — checkout the current release before running.";

/** Note when --from receives a CLI-flag-like value (git refs cannot start with '-'). */
const FROM_DASHED_REF_NOTE =
  "Git refs cannot start with '-'. Tokens like '--format=x' are CLI flags, not refs — use a tag or commit (e.g. v0.9.0).";

/**
 * Read commits from local git history and send to the Sentry API.
 *
 * When `from` is set, reads the whole `from..HEAD` range (bounded by the range
 * itself, so `depth` is omitted); otherwise walks back `depth` commits from
 * HEAD. Optional `paths` restrict the log to commits touching those subtrees.
 */
function setCommitsFromLocal(
  org: string,
  version: string,
  cwd: string,
  options: { depth?: number; paths?: string[]; from?: string }
): Promise<SentryRelease> {
  const { depth, paths, from } = options;
  const shallow = isShallowRepository(cwd);
  if (shallow) {
    log.warn(
      "Repository is a shallow clone. Commit history may be incomplete. " +
        "Consider running `git fetch --unshallow` or increasing --initial-depth."
    );
  }

  const commits = getCommitLog(cwd, { depth, paths, from });
  if (commits.length === 0) {
    const hasPaths = paths !== undefined && paths.length > 0;
    const scope = from
      ? `in ${from}..HEAD`
      : `within the last ${depth} commits`;
    const pathClause = hasPaths ? ` touching ${paths.join(", ")}` : "";
    // Only mention paths in the suggestion when the user actually passed some,
    // so `--from` without `--path` doesn't tell them to "check the path(s)".
    let suggestion: string;
    if (from) {
      suggestion = hasPaths ? "Check the ref and path(s)." : "Check the ref.";
    } else {
      suggestion = "Check the path(s) or increase --initial-depth.";
    }
    if (from || hasPaths) {
      log.warn(`No commits found${pathClause} ${scope}. ${suggestion}`);
    }
  }
  const repoName = getRepositoryName(cwd);
  const commitsWithRepo = commits.map((c) => ({
    ...c,
    repository: repoName,
  }));

  return setCommitsLocal(org, version, commitsWithRepo);
}

// ---------------------------------------------------------------------------
// Repo integration cache — skip speculative --auto call when we know
// the org has no repo integration configured. Stored in the metadata
// key-value table with a 1-hour TTL.
// ---------------------------------------------------------------------------

/** Cache TTL: 1 hour in milliseconds */
const REPO_CACHE_TTL_MS = 60 * 60 * 1000;

/** Check if we've cached that this org has no repo integration */
function hasNoRepoIntegration(orgSlug: string): boolean {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const db = getDatabase();
    const key = `repos_configured.${orgSlug}`;
    const checkedKey = `${key}.checked_at`;
    const m = getMetadata(db, [key, checkedKey]);
    const value = m.get(key);
    const checkedAt = m.get(checkedKey);
    if (value === "false" && checkedAt) {
      const age = Date.now() - Number(checkedAt);
      return age < REPO_CACHE_TTL_MS;
    }
  } catch {
    // DB errors shouldn't block the command
  }
  return false;
}

/** Cache that this org has no repo integration */
function cacheNoRepoIntegration(orgSlug: string): void {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const db = getDatabase();
    const key = `repos_configured.${orgSlug}`;
    setMetadata(db, {
      [key]: "false",
      [`${key}.checked_at`]: String(Date.now()),
    });
  } catch {
    // Non-fatal
  }
}

/** Clear the negative cache (e.g., when auto succeeds) */
function clearRepoIntegrationCache(orgSlug: string): void {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const db = getDatabase();
    const key = `repos_configured.${orgSlug}`;
    clearMetadata(db, [key, `${key}.checked_at`]);
  } catch {
    // Non-fatal
  }
}

/**
 * Default mode: try auto-discovery, fall back to local git.
 *
 * Uses a per-org negative cache to skip the speculative auto API call
 * when we already know the org has no repo integration (1-hour TTL).
 */
async function setCommitsDefault(
  org: string,
  version: string,
  cwd: string,
  depth: number
): Promise<SentryRelease> {
  // Fast path: cached "no repos" — skip the API call entirely
  if (hasNoRepoIntegration(org)) {
    return setCommitsFromLocal(org, version, cwd, { depth });
  }

  try {
    const release = await setCommitsAuto(org, version, cwd);
    clearRepoIntegrationCache(org);
    return release;
  } catch (error) {
    // Only fall back to local git when the org genuinely has no repository
    // integration. setCommitsAuto internally calls setCommitsWithRefs, which can
    // return a server 400 for unrelated reasons (invalid refs, bad release
    // state) — those must propagate, not be masked as "no integration" (which
    // would also poison the cache). Match on the exact client-side message since
    // the API exposes no stable error code for this case.
    if (
      error instanceof ApiError &&
      error.status === 400 &&
      error.message === NO_REPO_INTEGRATIONS_MESSAGE
    ) {
      cacheNoRepoIntegration(org);
      log.warn(
        "Could not auto-discover commits (no repository integration). " +
          "Falling back to local git history."
      );
      return setCommitsFromLocal(org, version, cwd, { depth });
    }
    if (error instanceof ValidationError && error.field === "repository") {
      log.warn(
        `Auto-discovery failed: ${error.message}. ` +
          "Falling back to local git history."
      );
      return setCommitsFromLocal(org, version, cwd, { depth });
    }
    throw error;
  }
}

/**
 * Parse the `--commit` flag into Sentry ref objects.
 *
 * Accepts comma-separated `REPO@SHA` or `REPO@PREV..SHA` entries. The range
 * form maps `PREV` to `previousCommit` and `SHA` to `commit`.
 *
 * @throws {ValidationError} When an entry is missing the `@` separator.
 */
function parseCommitRefs(
  commitFlag: string
): Array<{ repository: string; commit: string; previousCommit?: string }> {
  return commitFlag.split(",").map((pair) => {
    const trimmed = pair.trim();
    const atIdx = trimmed.lastIndexOf("@");
    if (atIdx <= 0) {
      throw validationError(
        `Invalid commit format '${trimmed}'. Expected REPO@SHA or REPO@PREV..SHA.`,
        [
          "sentry release set-commits 1.0.0 --commit owner/repo@abc123",
          "sentry release set-commits 1.0.0 --commit owner/repo@prev..abc123",
        ],
        "commit"
      );
    }
    const repository = trimmed.slice(0, atIdx);
    const sha = trimmed.slice(atIdx + 1);

    const rangeParts = sha.split("..");
    if (rangeParts.length === 2 && rangeParts[0] && rangeParts[1]) {
      return {
        repository,
        commit: rangeParts[1],
        previousCommit: rangeParts[0],
      };
    }

    return { repository, commit: sha };
  });
}

/**
 * Parse and validate the local-scope flags (`--path`, `--from`).
 *
 * Both restrict commit selection to local git history and are incompatible
 * with `--auto`/`--commit`, whose commit ranges are expanded server-side (so a
 * client-side path filter or range start would be silently ignored).
 *
 * @returns The parsed pathspecs and the normalized (trimmed) `from` ref.
 * @throws {ValidationError} On an empty `--path`/`--from`, or a conflict with
 *   `--auto`/`--commit`.
 */
function parseLocalScope(flags: {
  auto: boolean;
  commit?: string;
  path?: string;
  from?: string;
}): { paths: string[]; from?: string } {
  const serverExpanded = flags.auto || Boolean(flags.commit);

  const paths =
    flags.path === undefined
      ? []
      : flags.path
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
  if (flags.path !== undefined && paths.length === 0) {
    throw validationError(
      "--path requires at least one non-empty path.",
      ["sentry release set-commits 1.0.0 --path apps/mobile,packages/shared"],
      "path"
    );
  }
  if (paths.length > 0 && serverExpanded) {
    throw validationError(
      "--path cannot be combined with --auto or --commit. Those modes expand commit ranges on the server; --path filters local git history only.",
      flags.commit
        ? [
            "sentry release set-commits 1.0.0 --from v0.9.0 --path apps/mobile",
            "sentry release set-commits 1.0.0 --local --path apps/mobile",
          ]
        : [
            "sentry release set-commits 1.0.0 --local --path apps/mobile",
            "sentry release set-commits 1.0.0 --from v0.9.0 --path apps/mobile",
          ],
      "path"
    );
  }

  const from = flags.from?.trim();
  if (flags.from !== undefined && !from) {
    throw validationError(
      "--from requires a non-empty git ref (tag, branch, or commit).",
      ["sentry release set-commits 1.0.0 --from v0.9.0"],
      "from",
      FROM_RANGE_NOTE
    );
  }
  // Reject option-like refs. Otherwise `--from=--format=x` would become the
  // argv element `--format=x..HEAD`, which git parses as a `--format` override
  // (arg injection). Git ref names cannot start with "-" anyway.
  if (from?.startsWith("-")) {
    throw validationError(
      `--from must be a git ref, not a CLI flag (received '${from}').`,
      [
        "sentry release set-commits 1.0.0 --from v0.9.0",
        "sentry release set-commits 1.0.0 --from v0.9.0 --path apps/mobile",
      ],
      "from",
      FROM_DASHED_REF_NOTE
    );
  }
  if (from && serverExpanded) {
    throw validationError(
      "--from cannot be combined with --auto or --commit. Those modes expand commit ranges on the server; --from reads local git history.",
      [
        "sentry release set-commits 1.0.0 --from v0.9.0 --path apps/mobile",
        "sentry release set-commits 1.0.0 --local --initial-depth 50",
      ],
      "from",
      FROM_RANGE_NOTE
    );
  }

  return { paths, from };
}

function formatCommitsSet(release: SentryRelease): string {
  const lines: string[] = [];
  lines.push(`## Commits Set: ${escapeMarkdownInline(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", safeCodeSpan(release.version)]);
  kvRows.push(["Commits", String(release.commitCount ?? 0)]);
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

export const setCommitsCommand = buildCommand({
  docs: {
    brief: "Set commits for a release",
    fullDescription:
      "Associate commits with a release.\n\n" +
      "Use --auto to let Sentry discover commits via your repository integration\n" +
      "(requires a local git checkout — matches the origin remote against Sentry repos),\n" +
      "or --local to read commits from the local git history.\n" +
      "With no flag, tries --auto first and falls back to --local on failure.\n\n" +
      "For monorepos, --path restricts commits to one or more subtrees\n" +
      "(comma-separated). It implies --local and cannot be combined with\n" +
      "--auto or --commit, whose ranges are expanded server-side.\n\n" +
      "Use --from <ref> to read the local range <ref>..HEAD (e.g. the previous\n" +
      "release tag through the current checkout). It implies --local, reads the\n" +
      "whole range (--initial-depth does not apply), and combines with --path to\n" +
      "scope a monorepo release to the files that changed since the last release.\n" +
      "Like --path, it cannot be combined with --auto or --commit. Requires a\n" +
      "full (non-shallow) checkout spanning the range.\n\n" +
      "Examples:\n" +
      "  sentry release set-commits 1.0.0 --auto\n" +
      "  sentry release set-commits my-org/1.0.0 --local\n" +
      "  sentry release set-commits 1.0.0 --local --initial-depth 50\n" +
      "  sentry release set-commits 1.0.0 --path apps/mobile,packages/shared-ui\n" +
      "  sentry release set-commits 1.0.0 --from v0.9.0\n" +
      "  sentry release set-commits 1.0.0 --from v0.9.0 --path apps/mobile,apps/shared\n" +
      "  sentry release set-commits 1.0.0 --commit owner/repo@abc123..def456\n" +
      "  sentry release set-commits 1.0.0 --clear",
  },
  output: {
    human: formatCommitsSet,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/version",
          brief: "[<org>/]<version> - Release version",
          parse: String,
        },
      ],
    },
    flags: {
      auto: {
        kind: "boolean",
        brief:
          "Auto-discover commits via repository integration (needs local git checkout)",
        default: false,
      },
      local: {
        kind: "boolean",
        brief: "Read commits from local git history",
        default: false,
      },
      clear: {
        kind: "boolean",
        brief: "Clear all commits from the release",
        default: false,
      },
      commit: {
        kind: "parsed",
        parse: String,
        brief:
          "Explicit commit as REPO@SHA or REPO@PREV..SHA (comma-separated)",
        optional: true,
      },
      path: {
        kind: "parsed",
        parse: String,
        brief:
          "Filter commits to these paths (comma-separated). Implies --local.",
        optional: true,
      },
      from: {
        kind: "parsed",
        parse: String,
        brief:
          "Read the local range <ref>..HEAD (e.g. previous release tag). Implies --local.",
        optional: true,
      },
      "initial-depth": {
        kind: "parsed",
        parse: numberParser,
        brief: "Number of commits to read with --local",
        default: "20", // Stricli passes string defaults through parse(); numberParser converts to number
      },
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly auto: boolean;
      readonly local: boolean;
      readonly clear: boolean;
      readonly commit?: string;
      readonly path?: string;
      readonly from?: string;
      readonly "initial-depth": number;
      readonly json: boolean;
      readonly fields?: string[];
    },
    target: string
  ) {
    const { cwd } = this;

    const { version, org } = await resolveReleaseTarget(
      target,
      USAGE_HINT,
      cwd
    );

    // Clear mode: remove all commits regardless of other flags.
    // The server only clears commits when it receives an explicitly-empty
    // `refs` array — an empty `commits` list is treated as "no change" and
    // silently no-ops. setCommitsWithRefs sends `{ refs: [] }`, which triggers
    // release.clear_commits() server-side.
    if (flags.clear) {
      const release = await setCommitsWithRefs(org, version, []);
      yield new CommandOutput(release);
      return;
    }

    // Validate mutual exclusivity of commit source flags
    const modeFlags = [flags.auto, flags.local, !!flags.commit].filter(Boolean);
    if (modeFlags.length > 1) {
      throw validationError(
        "Only one of --auto, --local, or --commit can be used at a time.",
        [
          "sentry release set-commits 1.0.0 --auto",
          "sentry release set-commits 1.0.0 --from v0.9.0 --path apps/mobile",
          "sentry release set-commits 1.0.0 --commit owner/repo@abc123..def456",
        ],
        "commit"
      );
    }

    // --path and --from restrict commit selection to local git history. Neither
    // works with --auto/--commit, whose ranges are expanded server-side.
    const { paths, from } = parseLocalScope(flags);

    // Explicit --commit mode: parse REPO@SHA or REPO@PREV..SHA pairs as refs
    if (flags.commit) {
      const refs = parseCommitRefs(flags.commit);
      const release = await setCommitsWithRefs(org, version, refs);
      yield new CommandOutput(release);
      return;
    }

    let release: SentryRelease;

    if (flags.local || paths.length > 0 || from) {
      // Explicit --local, or --path/--from (which imply local): local git only.
      // An explicit --from range is self-bounding, so pass depth 0 (no cap) to
      // read every commit in <ref>..HEAD; otherwise walk back --initial-depth.
      release = await setCommitsFromLocal(org, version, cwd, {
        depth: from ? 0 : flags["initial-depth"],
        paths,
        from,
      });
    } else if (flags.auto) {
      // Explicit --auto: use repo integration, fail hard on error
      release = await setCommitsAuto(org, version, cwd);
    } else {
      // Default (no flag): try auto with cached fallback
      release = await setCommitsDefault(
        org,
        version,
        cwd,
        flags["initial-depth"]
      );
    }

    yield new CommandOutput(release);
  },
});
