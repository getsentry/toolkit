/**
 * `.sentryclirc` Import Engine
 *
 * Scans for `.sentryclirc` files, classifies them, builds an import plan,
 * and executes it by storing credentials and defaults in SQLite.
 *
 * ## Security: Same-File Rule
 *
 * Trust is determined by file content, not file path. No location
 * (including `~/.sentryclirc`) is inherently trusted — on CI, any path
 * can be planted by an attacker.
 *
 * The core invariant: **the effective token and URL must originate from
 * the same `.sentryclirc` file** for the import to be trusted. This
 * "co-presence" rule means an attacker who planted both values already
 * has the token — there is nothing to steal via a URL redirect.
 *
 * When token and URL come from different files (cross-file merge), the
 * URL may have been injected by an attacker with write access to one
 * file but not the other. This requires explicit `--url` confirmation.
 *
 * ## Hash-Based Change Detection
 *
 * At import time, SHA-256 hashes of imported files are stored. On
 * subsequent runs, a hash mismatch clears the import record and
 * triggers re-evaluation — catching post-import tampering such as
 * an attacker appending a malicious URL to a token-only file.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SENTRY_URL, normalizeUrl } from "./constants.js";
import {
  clearAuth,
  hasStoredAuthCredentials,
  setAuthToken,
} from "./db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
  getDefaultUrl,
  setDefaultOrganization,
  setDefaultProject,
  setDefaultUrl,
} from "./db/defaults.js";
import { getConfigDir, getDatabase } from "./db/index.js";
import { setUserInfo } from "./db/user.js";
import { clearMetadata, getMetadata, setMetadata } from "./db/utils.js";
import { parseIni } from "./ini.js";
import { logger } from "./logger.js";
import { isSaaSTrustOrigin, normalizeOrigin } from "./sentry-urls.js";
import {
  CONFIG_FILENAME,
  getGlobalPaths,
  tryReadSentryCliRc,
} from "./sentryclirc.js";
import { parseSntrysClaim } from "./token-claims.js";
import { walkUpFrom } from "./walk-up.js";

const log = logger.withTag("import");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the file was found — used for auto-prompt eligibility, NOT for trust */
export type RcFileLocation = "homedir" | "config-dir" | "project-local";

/** A discovered .sentryclirc file with parsed content, location, and content hash */
export type DiscoveredRcFile = {
  /** Absolute path to the file */
  path: string;
  /** Where the file was found (homedir, config-dir, or project-local) */
  location: RcFileLocation;
  /** SHA-256 hex digest of the raw file content */
  contentHash: string;
  /** Auth token from [auth] section */
  token?: string;
  /** Sentry URL from [defaults] section */
  url?: string;
  /** Organization slug from [defaults] section */
  org?: string;
  /** Project slug from [defaults] section */
  project?: string;
};

/** Fields that can be imported from .sentryclirc */
type ImportableField = "token" | "url" | "org" | "project";

/** Preview of what the import will do */
export type ImportPlan = {
  /** All discovered .sentryclirc files */
  sources: DiscoveredRcFile[];
  /** Effective merged values (closest-wins + global-fallback) */
  effective: { token?: string; url?: string; org?: string; project?: string };
  /** Provenance: which file path contributed each effective field */
  effectiveSources: {
    token?: string;
    url?: string;
    org?: string;
    project?: string;
  };
  /** Which fields would be new (not already in SQLite) */
  newFields: ImportableField[];
  /** Whether usable OAuth credentials already exist in SQLite */
  hasExistingAuth: boolean;
  /** Whether the effective URL is SaaS (or absent = SaaS default) */
  isSaas: boolean;
  /**
   * Whether the effective token+URL pass the same-file trust gate.
   * true when: (a) token and URL from same file, or (b) no URL (SaaS default).
   */
  trusted: boolean;
  /** Security warnings for display */
  warnings: string[];
};

/** Result after executing an import */
export type ImportResult = {
  /** Whether the import was executed successfully */
  imported: boolean;
  /** Which fields were stored */
  stored: { token: boolean; url: boolean; org: boolean; project: boolean };
  /** Whether the token was validated against the API (undefined if skipped) */
  tokenValid?: boolean;
  /** User identity from token validation */
  user?: { name?: string; email?: string; username?: string };
  /** Warnings emitted during import */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Metadata keys
// ---------------------------------------------------------------------------

const IMPORT_COMPLETED_KEY = "import.sentryclirc";
const IMPORT_DECLINED_KEY = "import.sentryclirc_declined";

/** Persisted record of a completed import, including file content hashes */
type ImportRecord = {
  completedAt: number;
  sources: Array<{ path: string; contentHash: string }>;
};

/** Options for {@link executeImport} */
export type ExecuteImportOptions = {
  /** Validate the token against the Sentry API before committing (default: true) */
  validateToken?: boolean;
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a `.sentryclirc` file path by its location.
 *
 * Used for auto-prompt eligibility (project-local files are excluded),
 * NOT for trust decisions (trust uses the same-file rule instead).
 */
export function classifyRcFileLocation(filePath: string): RcFileLocation {
  const homedirPath = join(homedir(), CONFIG_FILENAME);
  if (filePath === homedirPath) {
    return "homedir";
  }
  const configDirPath = join(getConfigDir(), CONFIG_FILENAME);
  if (filePath === configDirPath) {
    return "config-dir";
  }
  return "project-local";
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a string */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Extract fields from parsed INI data */
function extractFields(iniData: ReturnType<typeof parseIni>): {
  token?: string;
  url?: string;
  org?: string;
  project?: string;
} {
  const result: {
    token?: string;
    url?: string;
    org?: string;
    project?: string;
  } = {};
  const token = iniData.auth?.token?.trim();
  if (token) {
    result.token = token;
  }
  const url = iniData.defaults?.url?.trim();
  if (url) {
    result.url = url;
  }
  const org = iniData.defaults?.org?.trim();
  if (org) {
    result.org = org;
  }
  const project = iniData.defaults?.project?.trim();
  if (project) {
    result.project = project;
  }
  return result;
}

/** Read and parse a single .sentryclirc file into a DiscoveredRcFile */
async function readRcFile(
  rcPath: string,
  location: RcFileLocation
): Promise<DiscoveredRcFile | null> {
  const content = await tryReadSentryCliRc(rcPath);
  if (content === null) {
    return null;
  }
  return {
    path: rcPath,
    location,
    contentHash: sha256(content),
    ...extractFields(parseIni(content)),
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover all `.sentryclirc` files by walking up from `cwd` and
 * checking global fallback paths.
 *
 * Returns per-file granularity (not merged) with provenance tracking,
 * content hashes, and location classification.
 */
export async function discoverRcFiles(
  cwd: string
): Promise<DiscoveredRcFile[]> {
  const files: DiscoveredRcFile[] = [];
  const globalPathSet = getGlobalPaths();
  const seen = new Set<string>();

  // Walk up from CWD (closest-first), skip global paths (handled below)
  for await (const dir of walkUpFrom(cwd)) {
    const rcPath = join(dir, CONFIG_FILENAME);
    if (globalPathSet.has(rcPath) || seen.has(rcPath)) {
      continue;
    }
    seen.add(rcPath);
    const file = await readRcFile(rcPath, "project-local");
    if (file) {
      files.push(file);
    }
  }

  // Check global fallback paths (config-dir first, then homedir)
  for (const globalPath of globalPathSet) {
    if (seen.has(globalPath)) {
      continue;
    }
    seen.add(globalPath);
    const file = await readRcFile(
      globalPath,
      classifyRcFileLocation(globalPath)
    );
    if (file) {
      files.push(file);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Trust Gate
// ---------------------------------------------------------------------------

/**
 * Check whether the effective token and URL satisfy the same-file rule.
 *
 * Trusted when:
 * - No URL at all -> SaaS default, no redirect vector
 * - Effective URL is SaaS and has no explicit source -> safe regardless
 * - Token and URL come from the same file -> co-presence
 *
 * Not trusted when token and URL come from different files (cross-file
 * merge -- URL may have been injected).
 */
export function isSameFileOrigin(plan: ImportPlan): boolean {
  if (!plan.effective.url) {
    return true;
  }
  if (isSaaSTrustOrigin(plan.effective.url) && !plan.effectiveSources.url) {
    return true;
  }
  return plan.effectiveSources.token === plan.effectiveSources.url;
}

// ---------------------------------------------------------------------------
// Plan Building helpers
// ---------------------------------------------------------------------------

/** Merge files into effective values using closest-wins order */
function mergeEffectiveValues(files: DiscoveredRcFile[]): {
  effective: ImportPlan["effective"];
  effectiveSources: ImportPlan["effectiveSources"];
} {
  const effective: ImportPlan["effective"] = {};
  const effectiveSources: ImportPlan["effectiveSources"] = {};

  for (const file of files) {
    for (const field of ["token", "url", "org", "project"] as const) {
      if (effective[field] === undefined && file[field]) {
        effective[field] = file[field];
        effectiveSources[field] = file.path;
      }
    }
  }

  // Normalize URL
  if (effective.url) {
    const normalized = normalizeUrl(effective.url);
    if (normalized) {
      effective.url = normalizeOrigin(normalized) ?? normalized;
    }
  }

  return { effective, effectiveSources };
}

/**
 * Check if a default value is already set, returning false on DB errors.
 * Used to determine which fields would be "new" in an import.
 */
function isDefaultSet(getter: () => string | null): boolean {
  try {
    return getter() !== null;
  } catch (error) {
    log.debug("Failed to check default value", error);
    return false;
  }
}

/** Determine which effective fields would be new (not already in SQLite) */
function computeNewFields(
  effective: ImportPlan["effective"],
  isSaas: boolean
): ImportableField[] {
  const fields: ImportableField[] = [];

  if (effective.token) {
    let hasAuth = false;
    try {
      hasAuth = hasStoredAuthCredentials();
    } catch (error) {
      log.debug("Failed to check stored auth credentials", error);
    }
    if (!hasAuth) {
      fields.push("token");
    }
  }

  if (effective.url && !isSaas && !isDefaultSet(getDefaultUrl)) {
    fields.push("url");
  }
  if (effective.org && !isDefaultSet(getDefaultOrganization)) {
    fields.push("org");
  }
  if (effective.project && !isDefaultSet(getDefaultProject)) {
    fields.push("project");
  }

  return fields;
}

/**
 * Check if a `sntrys_` token's embedded URL claim mismatches a given URL.
 * Returns a warning string if there's a mismatch, or undefined if OK.
 *
 * @internal Exported for use by the import command's `--url` override
 */
export function checkSntrysClaim(
  token: string,
  url: string
): string | undefined {
  const claim = parseSntrysClaim(token);
  if (!claim?.url) {
    return;
  }
  const claimOrigin = normalizeOrigin(claim.url);
  if (claimOrigin && url !== claimOrigin) {
    return (
      `Token's embedded URL claim (${claimOrigin}) doesn't match ` +
      `the config URL (${url}).`
    );
  }
  return;
}

/** Build security warnings based on provenance analysis */
function buildSecurityWarnings(
  effectiveSources: ImportPlan["effectiveSources"],
  effective: ImportPlan["effective"],
  isSaas: boolean
): string[] {
  const warnings: string[] = [];

  // Cross-file token+URL warning
  if (
    effectiveSources.token &&
    effectiveSources.url &&
    effectiveSources.token !== effectiveSources.url &&
    !isSaas
  ) {
    warnings.push(
      "Token and URL come from different files — URL may have been injected.\n" +
        `  Token: ${effectiveSources.token}\n` +
        `  URL:   ${effectiveSources.url}`
    );
  }

  // sntrys_ claim mismatch
  if (effective.token && effective.url) {
    const claimWarning = checkSntrysClaim(effective.token, effective.url);
    if (claimWarning) {
      warnings.push(claimWarning);
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Plan Building
// ---------------------------------------------------------------------------

/**
 * Build an import plan by merging discovered files and comparing
 * against current SQLite state.
 *
 * Uses closest-wins merge order (matching {@link loadSentryCliRc} behavior):
 * project-local files first, then config-dir, then homedir.
 */
export function buildImportPlan(files: DiscoveredRcFile[]): ImportPlan {
  const { effective, effectiveSources } = mergeEffectiveValues(files);
  const isSaas = effective.url ? isSaaSTrustOrigin(effective.url) : true;
  const newFields = computeNewFields(effective, isSaas);
  const warnings = buildSecurityWarnings(effectiveSources, effective, isSaas);

  let hasExistingAuth = false;
  try {
    hasExistingAuth = hasStoredAuthCredentials();
  } catch (error) {
    log.debug("Failed to check stored auth credentials for plan", error);
  }

  const plan: ImportPlan = {
    sources: files,
    effective,
    effectiveSources,
    newFields,
    hasExistingAuth,
    isSaas,
    trusted: true,
    warnings,
  };

  plan.trusted = isSameFileOrigin(plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

/**
 * Check if an error is an authentication failure (invalid/expired token)
 * vs a transient network error (DNS, timeout, 5xx) or a permission issue (403).
 *
 * Only 401 Unauthorized means the token is invalid. 403 Forbidden means the
 * token is valid but lacks the required scope — clearing it would destroy a
 * working token that's useful for other API operations.
 */
function isAuthFailure(error: unknown): boolean {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status === 401;
  }
  return false;
}

/**
 * Validate token against the Sentry API and fetch user info.
 *
 * On auth failure (401): clears the stored token and returns false.
 * On transient network/permission error (403, 5xx, DNS, timeout): keeps
 * the token stored but warns the user.
 */
async function validateAndFetchUser(result: ImportResult): Promise<boolean> {
  try {
    const { getUserRegions } = await import("./api-client.js");
    await getUserRegions();
    result.tokenValid = true;
  } catch (error) {
    if (isAuthFailure(error)) {
      await clearAuth();
      result.stored.token = false;
      result.tokenValid = false;
      result.warnings.push(
        "Token validation failed (invalid credentials) — the token was not stored."
      );
      return false;
    }
    // Transient network error — keep the token, warn the user
    log.debug("Token validation failed with transient error", error);
    result.warnings.push(
      "Could not validate token (network error). Token was stored — run 'sentry auth status' to verify."
    );
    return true;
  }

  // Fetch and cache user info (best-effort)
  try {
    const { getCurrentUser } = await import("./api-client.js");
    const user = await getCurrentUser();
    try {
      setUserInfo({
        userId: user.id,
        email: user.email ?? undefined,
        username: user.username ?? undefined,
        name: user.name ?? undefined,
      });
    } catch (dbError) {
      log.debug("Failed to cache user info", dbError);
    }
    result.user = {
      name: user.name ?? undefined,
      email: user.email ?? undefined,
      username: user.username ?? undefined,
    };
  } catch (userError) {
    log.debug("Failed to fetch user info", userError);
  }

  return true;
}

/**
 * Try to set a default value if not already set. Returns true if stored.
 * Catches and logs DB errors (non-fatal).
 */
function trySetDefault(
  getter: () => string | null,
  setter: (v: string) => void,
  value: string,
  label: string
): boolean {
  try {
    if (!getter()) {
      setter(value);
      return true;
    }
  } catch (error) {
    log.debug(`Failed to store default ${label}`, error);
  }
  return false;
}

/** Store default values that are not already set */
function storeDefaults(
  effective: ImportPlan["effective"],
  result: ImportResult
): void {
  if (effective.url && !isSaaSTrustOrigin(effective.url)) {
    result.stored.url = trySetDefault(
      getDefaultUrl,
      setDefaultUrl,
      effective.url,
      "URL"
    );
  }
  if (effective.org) {
    result.stored.org = trySetDefault(
      getDefaultOrganization,
      setDefaultOrganization,
      effective.org,
      "org"
    );
  }
  if (effective.project) {
    result.stored.project = trySetDefault(
      getDefaultProject,
      setDefaultProject,
      effective.project,
      "project"
    );
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute the import: store credentials and defaults in SQLite.
 *
 * Token validation is optional (the explicit command always validates;
 * the auto-prompt validates by default).
 */
export async function executeImport(
  plan: ImportPlan,
  options: ExecuteImportOptions = {}
): Promise<ImportResult> {
  const { validateToken = true } = options;
  const { effective } = plan;
  const result: ImportResult = {
    imported: false,
    stored: { token: false, url: false, org: false, project: false },
    warnings: [],
  };

  // 1. Store defaults (URL, org, project) before token validation
  //    so they're persisted even if the token is invalid.
  storeDefaults(effective, result);

  // 2. Store token with host scoping (only if token is new — re-check
  //    hasStoredAuthCredentials to guard against TOCTOU if user acquired
  //    OAuth credentials during the confirmation prompt)
  if (effective.token && plan.newFields.includes("token")) {
    let authAcquiredDuringPrompt = false;
    try {
      authAcquiredDuringPrompt = hasStoredAuthCredentials();
    } catch (error) {
      log.debug("Failed to re-check auth state before import", error);
    }

    if (!authAcquiredDuringPrompt) {
      const host = effective.url ?? DEFAULT_SENTRY_URL;
      setAuthToken(effective.token, undefined, undefined, { host });
      result.stored.token = true;

      if (validateToken && !(await validateAndFetchUser(result))) {
        // Mark as declined (not completed) to prevent infinite re-prompting.
        // Using "declined" because: markImportCompleted + hasStoredAuth()=false
        // (auth cleared by validation failure) would re-trigger on next run.
        // "Declined" is checked before hasStoredAuth, breaking the loop.
        // The user can re-run `sentry cli import` explicitly (which ignores
        // the declined flag), or updating the .sentryclirc file will trigger
        // hash-change detection on the completed record.
        markImportDeclined(plan.sources);
        return result;
      }
    }
  }

  // 3. Mark import as completed
  markImportCompleted(plan);

  result.imported = true;
  return result;
}

// ---------------------------------------------------------------------------
// Import State Tracking helpers
// ---------------------------------------------------------------------------

/** Parse a stored import record from JSON. Returns null on parse failure. */
function parseImportRecord(raw: string): ImportRecord | null {
  try {
    const parsed = JSON.parse(raw) as ImportRecord;
    if (!Array.isArray(parsed?.sources)) {
      log.debug("Import record has invalid sources field");
      return null;
    }
    return parsed;
  } catch (error) {
    log.debug("Failed to parse import record", error);
    return null;
  }
}

/**
 * Check if the user has declined the auto-prompt.
 * Returns the decline record (for hash verification) or null if not declined.
 */
function getDeclineRecord(): ImportRecord | null {
  try {
    const db = getDatabase();
    const raw = getMetadata(db, [IMPORT_DECLINED_KEY]).get(IMPORT_DECLINED_KEY);
    if (!raw) {
      return null;
    }
    // Support both old format (bare timestamp) and new format (JSON with hashes)
    const parsed = parseImportRecord(raw);
    if (parsed) {
      return parsed;
    }
    // Legacy bare timestamp — treat as declined with no hash info
    return { completedAt: Number(raw) || 0, sources: [] };
  } catch (error) {
    log.debug("Failed to check import decline state", error);
    return null;
  }
}

/** Get the stored import record, or null if none exists */
function getImportRecord(): ImportRecord | null {
  try {
    const db = getDatabase();
    const raw = getMetadata(db, [IMPORT_COMPLETED_KEY]).get(
      IMPORT_COMPLETED_KEY
    );
    if (!raw) {
      return null;
    }
    return parseImportRecord(raw);
  } catch (error) {
    log.debug("Failed to read import record", error);
    return null;
  }
}

/** Clear the stored decline flag (file hash changed — give user fresh chance) */
function clearImportDeclineRecord(): void {
  try {
    const db = getDatabase();
    clearMetadata(db, [IMPORT_DECLINED_KEY]);
  } catch (error) {
    log.debug("Failed to clear import decline record", error);
  }
}

/** Clear the stored import record (hash mismatch detected) */
function clearImportRecord(): void {
  try {
    const db = getDatabase();
    clearMetadata(db, [IMPORT_COMPLETED_KEY]);
  } catch (error) {
    log.debug("Failed to clear import record", error);
  }
}

// ---------------------------------------------------------------------------
// Import State Tracking
// ---------------------------------------------------------------------------

/** Verify all source files in a record still match their stored hashes */
async function verifyRecordHashes(record: ImportRecord): Promise<boolean> {
  for (const source of record.sources) {
    if (!(await verifyFileHash(source.path, source.contentHash))) {
      return false;
    }
  }
  return true;
}

/**
 * Async check whether an import is needed, with file hash verification.
 *
 * Returns `false` when:
 * - The user declined the auto-prompt (metadata key exists)
 * - A previous import completed AND stored auth still exists AND all
 *   source file hashes still match
 *
 * Returns `true` when:
 * - No import has been done
 * - A previous import's source files have changed (hash mismatch)
 * - Auth was cleared since the last import (logout, token expiry)
 */
export async function isImportNeededAsync(): Promise<boolean> {
  // Check for a completed import first — if the file changed since import,
  // clear BOTH the import record AND the decline flag so the user gets
  // re-prompted with the new file content.
  const record = getImportRecord();
  if (record) {
    if (!(await verifyRecordHashes(record))) {
      clearImportRecord();
      clearImportDeclineRecord();
      return true;
    }
    // If auth was cleared since the import (e.g., logout), re-offer import
    if (!hasStoredAuth()) {
      return true;
    }
    return false;
  }

  // No import record — check if previously declined
  const declineRecord = getDeclineRecord();
  if (declineRecord) {
    // If the decline has hashes and the files changed, clear the decline
    // so the user gets re-prompted with the new content
    if (
      declineRecord.sources.length > 0 &&
      !(await verifyRecordHashes(declineRecord))
    ) {
      clearImportDeclineRecord();
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Check if any stored auth credentials exist, catching DB errors.
 * Used to detect logout since last import.
 */
function hasStoredAuth(): boolean {
  try {
    return hasStoredAuthCredentials();
  } catch (error) {
    log.debug("Failed to check auth state for import", error);
    return false;
  }
}

/**
 * Check if a file's current content matches the expected hash.
 *
 * Uses {@link tryReadSentryCliRc} for FIFO/socket/device protection —
 * `Bun.file().text()` would block indefinitely on non-regular files.
 * A null result (file absent, unreadable, or non-regular) is treated
 * as a hash mismatch.
 */
async function verifyFileHash(
  filePath: string,
  expectedHash: string
): Promise<boolean> {
  try {
    const content = await tryReadSentryCliRc(filePath);
    if (content === null) {
      return false;
    }
    return sha256(content) === expectedHash;
  } catch (error) {
    log.debug(`Failed to verify hash for ${filePath}`, error);
    return false;
  }
}

/** Record a completed import with file content hashes */
export function markImportCompleted(plan: ImportPlan): void {
  const record: ImportRecord = {
    completedAt: Date.now(),
    sources: plan.sources
      .filter((s) => s.token || s.url || s.org || s.project)
      .map((s) => ({ path: s.path, contentHash: s.contentHash })),
  };
  try {
    const db = getDatabase();
    setMetadata(db, { [IMPORT_COMPLETED_KEY]: JSON.stringify(record) });
  } catch (error) {
    log.debug("Failed to record import state", error);
  }
}

/**
 * Clear any previous decline state so the auto-prompt can fire again.
 * Called by the explicit `sentry cli import` command after a successful
 * import — not by `markImportCompleted` to avoid clearing a decline
 * on no-op imports.
 */
export function clearImportDecline(): void {
  try {
    const db = getDatabase();
    clearMetadata(db, [IMPORT_DECLINED_KEY]);
  } catch (error) {
    log.debug("Failed to clear import decline", error);
  }
}

/**
 * Record that the user declined the auto-prompt, including file hashes
 * so we can re-prompt if the files change.
 *
 * @param sources - Discovered files at time of decline (for hash tracking)
 */
export function markImportDeclined(sources?: DiscoveredRcFile[]): void {
  try {
    const record: ImportRecord = {
      completedAt: Date.now(),
      sources: (sources ?? [])
        .filter((s) => s.token || s.url || s.org || s.project)
        .map((s) => ({ path: s.path, contentHash: s.contentHash })),
    };
    const db = getDatabase();
    setMetadata(db, {
      [IMPORT_DECLINED_KEY]: JSON.stringify(record),
    });
  } catch (error) {
    log.debug("Failed to record import decline", error);
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Mask a token for display: show first 4 and last 4 characters.
 *
 * @internal Exported for use by the import command's formatter
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 4)}${"*".repeat(token.length - 8)}${token.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Clear import state (for testing).
 *
 * @internal Exported for testing only
 */
export function clearImportState(): void {
  try {
    const db = getDatabase();
    clearMetadata(db, [IMPORT_COMPLETED_KEY, IMPORT_DECLINED_KEY]);
  } catch (error) {
    log.debug("Failed to clear import state", error);
  }
}
