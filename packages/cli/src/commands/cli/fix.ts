/**
 * sentry cli fix
 *
 * Diagnose and repair CLI database issues (schema, permissions, and ownership).
 */

import { execFileSync } from "node:child_process";
import { chmod, chown, stat } from "node:fs/promises";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { getConfigDir, getDbPath, getRawDatabase } from "../../lib/db/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  getSchemaIssues,
  repairSchema,
  type SchemaIssue,
} from "../../lib/db/schema.js";
import { OutputError } from "../../lib/errors.js";
import { formatFixResult } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { getRealUsername } from "../../lib/utils.js";

type FixFlags = {
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

/**
 * A single diagnosed issue with optional repair outcome.
 *
 * Each issue represents one problem found during diagnosis. The `repaired`
 * field indicates the repair outcome: `true` = fixed, `false` = failed,
 * `undefined` = not attempted (dry-run or skipped).
 */
export type FixIssue = {
  /** Which diagnostic category this issue belongs to */
  category: "ownership" | "permission" | "schema";
  /** Human-readable description of the problem */
  description: string;
  /** Repair outcome: true=fixed, false=failed, undefined=not attempted */
  repaired?: boolean;
  /** Detail message for the repair success or failure */
  repairMessage?: string;
};

/**
 * Complete result of the fix command, collecting all diagnosed issues
 * across ownership, permission, and schema categories.
 */
export type FixResult = {
  /** Absolute path to the database file */
  dbPath: string;
  /** Expected schema version */
  schemaVersion: number;
  /** Whether this was a dry-run (no repairs attempted) */
  dryRun: boolean;
  /** All diagnosed issues across all categories */
  issues: FixIssue[];
  /** True when at least one issue couldn't be repaired */
  repairFailed: boolean;
  /** Manual instructions when automatic repair isn't possible */
  instructions?: string;
};

/** Format a schema issue as a human-readable string for display. */
function formatIssue(issue: SchemaIssue): string {
  if (issue.type === "missing_table") {
    return `Missing table: ${issue.table}`;
  }
  if (issue.type === "missing_column") {
    return `Missing column: ${issue.table}.${issue.column}`;
  }
  return `Wrong primary key: ${issue.table}`;
}

/** Expected permissions for the config directory (owner rwx) */
const EXPECTED_DIR_MODE = 0o700;
/** Expected permissions for the database file (owner rw) */
const EXPECTED_FILE_MODE = 0o600;

type PermissionIssue = {
  path: string;
  /** What kind of file this is (for display) */
  kind: "directory" | "database" | "journal";
  currentMode: number;
  expectedMode: number;
};

/**
 * A file or directory that is owned by a different user (typically root),
 * preventing the current process from writing to it.
 */
type OwnershipIssue = {
  path: string;
  kind: "directory" | "database" | "journal";
  /** UID of the file's current owner */
  ownerUid: number;
};

/**
 * Check if a path has the exact expected permission mode.
 *
 * Uses exact match (not bitmask) so extra bits like group/other read (e.g.,
 * 0o644 instead of 0o600) are flagged as issues — the CLI's local database
 * may contain auth tokens and should not be accessible to other users.
 *
 * @param path - Filesystem path to check
 * @param expectedMode - Exact permission mode (e.g., 0o700, 0o600)
 * @returns Object with the actual mode if permissions differ, or null if OK.
 *          Returns null if the path doesn't exist (ENOENT). Re-throws unexpected errors
 *          so they propagate to the user and get captured by Sentry's error handling.
 */
async function checkMode(
  path: string,
  expectedMode: number
): Promise<{ actualMode: number } | null> {
  try {
    const st = await stat(path);
    // biome-ignore lint/suspicious/noBitwiseOperators: extracting permission bits with bitmask
    const mode = st.mode & 0o777;
    if (mode !== expectedMode) {
      return { actualMode: mode };
    }
  } catch (error: unknown) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    // Missing files aren't a permission problem (WAL/SHM created on demand).
    // EACCES means the parent directory blocks stat — the directory check
    // will catch the root cause, so skip the individual file here.
    if (code === "ENOENT" || code === "EACCES") {
      return null;
    }
    throw error;
  }
  return null;
}

/**
 * Check if the database file and its directory have correct permissions.
 * Inspects the config directory (needs rwx), the DB file, and SQLite's
 * WAL/SHM journal files (need rw) in parallel. Missing files are silently
 * skipped since WAL/SHM are created on demand.
 *
 * @param dbPath - Absolute path to the database file
 * @returns List of permission issues found (empty if everything is OK)
 */
async function checkPermissions(dbPath: string): Promise<PermissionIssue[]> {
  const configDir = getConfigDir();

  const checks: Array<{
    path: string;
    kind: PermissionIssue["kind"];
    expectedMode: number;
  }> = [
    { path: configDir, kind: "directory", expectedMode: EXPECTED_DIR_MODE },
    { path: dbPath, kind: "database", expectedMode: EXPECTED_FILE_MODE },
    {
      path: `${dbPath}-wal`,
      kind: "journal",
      expectedMode: EXPECTED_FILE_MODE,
    },
    {
      path: `${dbPath}-shm`,
      kind: "journal",
      expectedMode: EXPECTED_FILE_MODE,
    },
  ];

  const results = await Promise.all(
    checks.map(async ({ path, kind, expectedMode }) => {
      const result = await checkMode(path, expectedMode);
      if (result) {
        return {
          path,
          kind,
          currentMode: result.actualMode,
          expectedMode,
        } satisfies PermissionIssue;
      }
      return null;
    })
  );

  return results.filter((r): r is PermissionIssue => r !== null);
}

/**
 * Check whether any config dir files or the DB are owned by a different user
 * (typically root after a `sudo` install).
 *
 * We only check the config directory and the DB file — those are the gating
 * items. If they are owned by root, chmod will fail and is pointless to attempt.
 *
 * @param dbPath - Absolute path to the database file
 * @param comparisonUid - The UID to compare against file owners. When running as
 *   root via `sudo`, pass the real user's UID (not 0) so root-owned files are detected.
 * @returns List of paths owned by a different user (empty = all owned by us)
 */
async function checkOwnership(
  dbPath: string,
  comparisonUid: number
): Promise<OwnershipIssue[]> {
  const configDir = getConfigDir();

  const checks: Array<{ path: string; kind: OwnershipIssue["kind"] }> = [
    { path: configDir, kind: "directory" },
    { path: dbPath, kind: "database" },
    { path: `${dbPath}-wal`, kind: "journal" },
    { path: `${dbPath}-shm`, kind: "journal" },
  ];

  const settled = await Promise.allSettled(checks.map((c) => stat(c.path)));
  const issues: OwnershipIssue[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i] as PromiseSettledResult<
      Awaited<ReturnType<typeof stat>>
    >;
    const check = checks[i] as (typeof checks)[number];

    if (result.status === "fulfilled") {
      const ownerUid = Number(result.value.uid);
      if (ownerUid !== comparisonUid) {
        issues.push({ path: check.path, kind: check.kind, ownerUid });
      }
      continue;
    }

    // Missing files are fine (WAL/SHM created on demand).
    // EACCES on a child file means the directory already blocks access — the
    // directory check above will surface the real issue.
    const code =
      result.reason instanceof Error
        ? (result.reason as NodeJS.ErrnoException).code
        : undefined;
    if (code !== "ENOENT" && code !== "EACCES") {
      throw result.reason;
    }
  }

  return issues;
}

/**
 * Resolve the numeric UID for a username by running `id -u -- <username>`.
 * Returns null if the lookup fails or returns a non-numeric result.
 *
 * Uses `execFileSync` (not `execSync`) so the username is passed as a
 * separate argument — the shell never interpolates it, preventing injection.
 */
const log = logger.withTag("cli.fix");

function resolveUid(username: string): number | null {
  try {
    const result = execFileSync("id", ["-u", "--", username], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const uid = Number(result.trim());
    return Number.isNaN(uid) ? null : uid;
  } catch (error) {
    log.debug(`Failed to resolve UID for user "${username}"`, error);
    return null;
  }
}

/** Per-issue repair outcome, aligned by index with the input issues array */
type RepairOutcome = {
  /** Whether the repair succeeded */
  success: boolean;
  /** Human-readable repair message */
  message: string;
};

/**
 * Perform chown on the given ownership issues, transferring files to
 * `username`. Called only when the current process is already root.
 *
 * @returns Per-issue outcomes aligned by index with the input issues array
 */
async function repairOwnership(
  issues: OwnershipIssue[],
  username: string,
  targetUid: number
): Promise<RepairOutcome[]> {
  const results = await Promise.allSettled(
    issues.map((issue) => chown(issue.path, targetUid, -1))
  );

  return results.map((result, i) => {
    const issue = issues[i] as OwnershipIssue;
    if (result.status === "fulfilled") {
      return {
        success: true,
        message: `${issue.kind} ${issue.path}: transferred to ${username}`,
      };
    }
    const reason =
      result.reason instanceof Error ? result.reason.message : "unknown error";
    return {
      success: false,
      message: `${issue.kind} ${issue.path}: ${reason}`,
    };
  });
}

/** Result of diagnosing a category of issues (used internally) */
type HandlerResult = {
  issues: FixIssue[];
  instructions?: string;
  repairFailed: boolean;
};

/**
 * Return the ownership fix instructions string.
 *
 * @param currentUid - UID of the running process
 * @param username - The real user's login name
 * @param configDir - The config directory path
 * @param dryRun - Whether this is a dry-run preview
 */
function ownershipInstructions(
  currentUid: number,
  username: string,
  configDir: string,
  dryRun: boolean
): string {
  if (dryRun && currentUid === 0) {
    return `Would transfer ownership of "${configDir}" to ${username}.`;
  }
  return (
    "To fix ownership, run one of:\n\n" +
    `  sudo chown -R ${username} "${configDir}"\n\n` +
    "Or let sentry fix it automatically:\n\n" +
    "  sudo sentry cli fix"
  );
}

/**
 * Diagnose ownership issues and optionally repair them.
 *
 * When the running process is root (`currentUid === 0`), we can perform chown
 * to transfer ownership back to the real user. The real username is inferred
 * from `SUDO_USER` / `USER` / `USERNAME` env vars (set by sudo).
 *
 * When not root, we return manual instructions for the user.
 *
 * @param dbPath - Absolute path to the database file
 * @param currentUid - UID of the running process
 * @param dryRun - If true, report issues without repairing
 * @returns Issues found, instructions, and whether repairs failed
 */
async function handleOwnershipIssues(
  dbPath: string,
  currentUid: number,
  dryRun: boolean
): Promise<HandlerResult> {
  const configDir = getConfigDir();
  const username = getRealUsername();

  // When running as root (e.g. `sudo sentry cli fix`), files from
  // `sudo brew install` are uid 0 — same as the process uid. Compare against
  // the real user's UID instead. If we can't resolve a non-root UID, bail
  // early: using 0 would make root-owned files look correct, and chowning to
  // 0 would permanently worsen things.
  let comparisonUid = currentUid;
  let resolvedTargetUid: number | null = null;
  if (currentUid === 0) {
    const uid = resolveUid(username);
    if (uid === null || uid === 0) {
      return {
        issues: [],
        instructions: `Could not determine a non-root UID for user "${username}".\nRun the following command manually:\n  chown -R ${username} "${configDir}"`,
        repairFailed: true,
      };
    }
    resolvedTargetUid = uid;
    comparisonUid = uid;
  }

  const rawIssues = await checkOwnership(dbPath, comparisonUid);
  if (rawIssues.length === 0) {
    return { issues: [], repairFailed: false };
  }

  // Convert raw ownership issues to FixIssue objects
  const fixIssues: FixIssue[] = rawIssues.map((issue) => ({
    category: "ownership" as const,
    description: `${issue.kind} ${issue.path}: owned by uid ${issue.ownerUid}`,
  }));

  if (dryRun) {
    return {
      issues: fixIssues,
      instructions: ownershipInstructions(
        currentUid,
        username,
        configDir,
        true
      ),
      repairFailed: false,
    };
  }

  if (currentUid !== 0) {
    // Not root — can't chown, return instructions.
    return {
      issues: fixIssues,
      instructions: ownershipInstructions(
        currentUid,
        username,
        configDir,
        false
      ),
      repairFailed: true,
    };
  }

  // Running as root — perform chown. resolvedTargetUid is guaranteed non-null
  // and non-zero here (we bailed out above if it couldn't be resolved).
  const resolvedUid = resolvedTargetUid as number;
  const outcomes = await repairOwnership(rawIssues, username, resolvedUid);

  // Mark each issue with its repair outcome (aligned by index)
  let anyFailed = false;
  for (let i = 0; i < fixIssues.length; i++) {
    const issue = fixIssues[i] as FixIssue;
    const outcome = outcomes[i] as RepairOutcome;
    issue.repaired = outcome.success;
    issue.repairMessage = outcome.message;
    if (!outcome.success) {
      anyFailed = true;
    }
  }

  return {
    issues: fixIssues,
    repairFailed: anyFailed,
  };
}

/**
 * Format a permission mode as an octal string (e.g., "0644").
 *
 * @param mode - Unix permission bits (0-0o777)
 */
function formatMode(mode: number): string {
  return `0${mode.toString(8)}`;
}

/**
 * Attempt to fix file/directory permissions via chmod.
 * Directory issues are repaired first (sequentially) because child file
 * chmod calls will fail with EACCES if the parent directory lacks execute
 * permission. File issues are then repaired in parallel.
 *
 * @param issues - Permission issues to repair
 * @returns Separate lists of human-readable repair successes and failures
 */
/**
 * Repair permissions, returning outcomes aligned by index with input.
 *
 * Repairs directories before files to avoid EACCES on child chmod calls.
 */
async function repairPermissions(
  issues: PermissionIssue[]
): Promise<RepairOutcome[]> {
  const outcomes = new Array<RepairOutcome>(issues.length);

  // Build index maps for dirs and files
  const dirEntries: Array<{ idx: number; issue: PermissionIssue }> = [];
  const fileEntries: Array<{ idx: number; issue: PermissionIssue }> = [];
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i] as PermissionIssue;
    if (issue.kind === "directory") {
      dirEntries.push({ idx: i, issue });
    } else {
      fileEntries.push({ idx: i, issue });
    }
  }

  // Repair directories first, then files
  await collectPermResults(dirEntries, outcomes);
  await collectPermResults(fileEntries, outcomes);

  return outcomes;
}

/**
 * Run chmod for each entry in parallel, writing outcomes by original index.
 */
async function collectPermResults(
  entries: Array<{ idx: number; issue: PermissionIssue }>,
  outcomes: RepairOutcome[]
): Promise<void> {
  const results = await Promise.allSettled(
    entries.map(async ({ issue }) => {
      await chmod(issue.path, issue.expectedMode);
      return `${issue.kind} ${issue.path}: ${formatMode(issue.currentMode)} -> ${formatMode(issue.expectedMode)}`;
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i] as PromiseSettledResult<string>;
    const entry = entries[i] as { idx: number; issue: PermissionIssue };
    if (result.status === "fulfilled") {
      outcomes[entry.idx] = { success: true, message: result.value };
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : "unknown error";
      outcomes[entry.idx] = {
        success: false,
        message: `${entry.issue.kind} ${entry.issue.path}: ${reason}`,
      };
    }
  }
}

/**
 * Diagnose permission issues and optionally repair them.
 *
 * @param dbPath - Absolute path to the database file
 * @param dryRun - If true, report issues without repairing
 * @returns Issues found and whether any repairs failed
 */
async function handlePermissionIssues(
  dbPath: string,
  dryRun: boolean
): Promise<HandlerResult> {
  const permIssues = await checkPermissions(dbPath);
  if (permIssues.length === 0) {
    return { issues: [], repairFailed: false };
  }

  // Convert to FixIssue objects
  const fixIssues: FixIssue[] = permIssues.map((issue) => ({
    category: "permission" as const,
    description: `${issue.kind} ${issue.path}: ${formatMode(issue.currentMode)} (expected ${formatMode(issue.expectedMode)})`,
  }));

  if (dryRun) {
    return { issues: fixIssues, repairFailed: false };
  }

  const outcomes = await repairPermissions(permIssues);

  // Mark each issue with its repair outcome (aligned by index)
  let anyFailed = false;
  for (let i = 0; i < fixIssues.length; i++) {
    const issue = fixIssues[i] as FixIssue;
    const outcome = outcomes[i] as RepairOutcome;
    issue.repaired = outcome.success;
    issue.repairMessage = outcome.message;
    if (!outcome.success) {
      anyFailed = true;
    }
  }

  return {
    issues: fixIssues,
    instructions: anyFailed
      ? `You may need to fix permissions manually:\n  chmod 700 "${getConfigDir()}"\n  chmod 600 "${dbPath}"`
      : undefined,
    repairFailed: anyFailed,
  };
}

/**
 * Diagnose schema issues (missing tables/columns) and optionally repair them.
 *
 * @param dbPath - Absolute path to the database file (used in error messages)
 * @param dryRun - If true, report issues without repairing
 * @returns Issues found and whether any repairs failed
 */
function handleSchemaIssues(dbPath: string, dryRun: boolean): HandlerResult {
  const db = getRawDatabase();
  const issues = getSchemaIssues(db);
  if (issues.length === 0) {
    return { issues: [], repairFailed: false };
  }

  // Convert to FixIssue objects
  const fixIssues: FixIssue[] = issues.map((issue) => ({
    category: "schema" as const,
    description: formatIssue(issue),
  }));

  if (dryRun) {
    return { issues: fixIssues, repairFailed: false };
  }

  const { fixed, failed } = repairSchema(db);
  const anyFailed = failed.length > 0;

  // Mark original issues with repair outcomes.
  // Schema repair runs independently of detection — mark all issues based
  // on overall success/failure. Attach repair messages for diagnostics.
  for (const issue of fixIssues) {
    issue.repaired = !anyFailed;
    issue.repairMessage = anyFailed
      ? failed.join("; ")
      : fixed.join("; ") || "Schema repaired";
  }

  return {
    issues: fixIssues,
    instructions: anyFailed
      ? `Try deleting the database and restarting: rm "${dbPath}"`
      : undefined,
    repairFailed: anyFailed,
  };
}

/**
 * Run schema diagnostics, guarding against DB open failures.
 *
 * The schema check opens the database, which can throw if the DB or config
 * directory is inaccessible. This wrapper catches those errors so `--dry-run`
 * can finish all diagnostics even when the filesystem is broken.
 *
 * @param priorIssuesFound - Total ownership+permission issues already found.
 *   If non-zero, a schema open failure is expected and we stay quiet about it.
 */
function safeHandleSchemaIssues(
  dbPath: string,
  dryRun: boolean,
  priorIssuesFound: number
): HandlerResult {
  try {
    return handleSchemaIssues(dbPath, dryRun);
  } catch {
    if (priorIssuesFound === 0) {
      return {
        issues: [
          {
            category: "schema",
            description: "Could not open database to check schema",
            repaired: false,
            repairMessage: `Try deleting the database and restarting: rm "${dbPath}"`,
          },
        ],
        instructions: `Try deleting the database and restarting: rm "${dbPath}"`,
        repairFailed: true,
      };
    }
    return { issues: [], repairFailed: true };
  }
}

export const fixCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Diagnose and repair CLI database issues",
    fullDescription:
      "Check the CLI's local SQLite database for schema, permission, and ownership\n" +
      "issues and repair them.\n\n" +
      "This is useful when upgrading from older CLI versions, if the database\n" +
      "becomes inconsistent due to interrupted operations, or if file permissions\n" +
      "prevent the CLI from writing to its local database.\n\n" +
      "The command performs non-destructive repairs only - it adds missing tables\n" +
      "and columns, fixes file permissions, and transfers ownership — but never\n" +
      "deletes data.\n\n" +
      "If files are owned by root (e.g. after `sudo brew install`), run with sudo\n" +
      "to transfer ownership back to the current user:\n\n" +
      "  sudo sentry cli fix\n\n" +
      "Examples:\n" +
      "  sentry cli fix              # Fix database issues\n" +
      "  sudo sentry cli fix         # Fix root-owned files\n" +
      "  sentry cli fix --dry-run    # Show what would be fixed without making changes",
  },
  output: { human: formatFixResult },
  parameters: {
    flags: {
      "dry-run": {
        kind: "boolean",
        brief: "Show what would be fixed without making changes",
        default: false,
      },
    },
  },
  async *func(this: SentryContext, flags: FixFlags) {
    const dbPath = getDbPath();
    const dryRun = flags["dry-run"];

    // process.getuid() is undefined on Windows
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : -1;

    // 1. Check ownership first — if files are root-owned, chmod will fail anyway.
    //    On Windows (currentUid === -1), skip the ownership check entirely.
    const ownership: HandlerResult =
      currentUid >= 0
        ? await handleOwnershipIssues(dbPath, currentUid, dryRun)
        : { issues: [], repairFailed: false };

    // 2. Check permissions (skip if ownership issues already reported failures —
    //    chmod will fail on root-owned files so the output would be misleading).
    const skipPerm = !dryRun && ownership.repairFailed;
    const perm: HandlerResult = skipPerm
      ? { issues: [], repairFailed: false }
      : await handlePermissionIssues(dbPath, dryRun);

    // 3. Schema check — guarded so filesystem errors don't hide earlier reports.
    const schema = safeHandleSchemaIssues(
      dbPath,
      dryRun,
      ownership.issues.length + perm.issues.length
    );

    const allIssues = [...ownership.issues, ...perm.issues, ...schema.issues];
    const anyFailed =
      ownership.repairFailed || perm.repairFailed || schema.repairFailed;

    // Merge instructions from all handlers
    const instructions = [
      ownership.instructions,
      perm.instructions,
      schema.instructions,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result: FixResult = {
      dbPath,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dryRun,
      issues: allIssues,
      repairFailed: anyFailed,
      instructions: instructions || undefined,
    };

    // Non-zero exit when there are unfixed failures
    if (anyFailed) {
      throw new OutputError(result);
    }

    return yield new CommandOutput(result);
  },
});
