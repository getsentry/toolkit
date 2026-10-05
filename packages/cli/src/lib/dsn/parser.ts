/**
 * DSN Parser
 *
 * Parses Sentry DSN strings to extract organization and project identifiers.
 *
 * DSN Format: {PROTOCOL}://{PUBLIC_KEY}@{HOST}/{PROJECT_ID}
 * Example: https://abc123@o1169445.ingest.us.sentry.io/4505229541441536
 *
 * For SaaS DSNs, the host contains the org ID in the pattern: oXXX.ingest...
 */

import {
  type DetectedDsn,
  type DsnSource,
  MONOREPO_ROOTS,
  type ParsedDsn,
} from "./types.js";

/**
 * Regular expression to match org ID from Sentry SaaS ingest hosts
 * Matches patterns like: o1169445.ingest.sentry.io or o1169445.ingest.us.sentry.io
 */
const ORG_ID_PATTERN = /^o(\d+)\.ingest(?:\.[a-z]+)?\.sentry\.io$/;

/**
 * Pattern to strip trailing colon from protocol
 */
const PROTOCOL_COLON_PATTERN = /:$/;

/**
 * Numeric org/project IDs that are only zeros ("0", "00", "00000").
 * Docs and examples often use these as stand-ins for real IDs.
 */
const ALL_ZERO_ID_PATTERN = /^0+$/;

/**
 * Public keys used as documentation placeholders.
 *
 * Sourced from getsentry/sentry-docs code context defaults and common
 * SDK/docs example strings (examplePublicKey@o0..., YOUR_DSN_HERE, etc.).
 * Matched case-insensitively against the DSN username.
 */
// Keep this list to unmistakable docs/template keys. Do NOT include bare
// "public" or "publickey" — legacy DSNs and scanner fixtures use those as
// real public keys (`public:secret@host/project`). Docs copies that use
// bare `public` also use o0 / project 0 and are caught by numeric-id checks.
const PLACEHOLDER_PUBLIC_KEY_PATTERN =
  /^(?:example(?:public)?key|your(?:public)?key|your[_-]?dsn(?:[_-]?here)?|___+public[_-]?dsn___+|__+dsn__+|<[^<>]+>)$/i;

/**
 * Extract organization ID from a Sentry ingest host
 *
 * @param host - The host portion of the DSN (e.g., "o1169445.ingest.us.sentry.io")
 * @returns The numeric org ID as a string, or null if not a SaaS ingest host
 *
 * @example
 * extractOrgIdFromHost("o1169445.ingest.us.sentry.io") // "1169445"
 * extractOrgIdFromHost("o123.ingest.sentry.io") // "123"
 * extractOrgIdFromHost("sentry.mycompany.com") // null (self-hosted)
 */
export function extractOrgIdFromHost(host: string): string | null {
  const match = host.match(ORG_ID_PATTERN);
  return match?.[1] ?? null;
}

/**
 * True when a SaaS org ID or project ID is a docs-style zero placeholder.
 * Covers `0`, `00`, and `00000` (for example `o00000.ingest.sentry.io`).
 */
export function isPlaceholderNumericId(id: string): boolean {
  return ALL_ZERO_ID_PATTERN.test(id);
}

/**
 * True when a DSN public key is a known documentation placeholder.
 */
export function isPlaceholderPublicKey(publicKey: string): boolean {
  // URL parsers may percent-encode angle-bracket templates such as `%3Ckey%3E`.
  let decoded = publicKey;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    decoded = decodeURIComponent(publicKey);
  } catch {
    // Keep the raw key when it is not valid percent-encoding.
  }
  return PLACEHOLDER_PUBLIC_KEY_PATTERN.test(decoded);
}

/**
 * Parse a Sentry DSN string into its components
 *
 * @param dsn - The full DSN string
 * @returns Parsed DSN components, or null if invalid
 *
 * @example
 * parseDsn("https://abc123@o1169445.ingest.us.sentry.io/4505229541441536")
 * // {
 * //   protocol: "https",
 * //   publicKey: "abc123",
 * //   host: "o1169445.ingest.us.sentry.io",
 * //   projectId: "4505229541441536",
 * //   orgId: "1169445"
 * // }
 */
export function parseDsn(dsn: string): ParsedDsn | null {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const url = new URL(dsn);

    // Protocol without the trailing colon
    const protocol = url.protocol.replace(PROTOCOL_COLON_PATTERN, "");

    // Public key is the username portion
    const publicKey = url.username;
    if (!publicKey || isPlaceholderPublicKey(publicKey)) {
      return null;
    }

    // Host
    const host = url.host;
    if (!host) {
      return null;
    }

    // Project ID is the last path segment
    const pathParts = url.pathname.split("/").filter(Boolean);
    const projectId = pathParts.at(-1);
    if (!projectId || isPlaceholderNumericId(projectId)) {
      return null;
    }

    // Try to extract org ID from host (SaaS only).
    // `o0` / `o00000` hosts become org IDs that are only zeros — reject those
    // so docs placeholders never become API org context.
    const orgId = extractOrgIdFromHost(host) ?? undefined;
    if (orgId !== undefined && isPlaceholderNumericId(orgId)) {
      return null;
    }

    return {
      protocol,
      publicKey,
      host,
      projectId,
      orgId,
    };
  } catch {
    // Invalid URL
    return null;
  }
}

/**
 * Validate that a string looks like a Sentry DSN
 *
 * @param value - String to validate
 * @returns True if the string appears to be a valid DSN
 */
export function isValidDsn(value: string): boolean {
  return parseDsn(value) !== null;
}

/**
 * Create a DetectedDsn from a raw DSN string.
 * Parses the DSN and attaches source metadata.
 *
 * @param raw - Raw DSN string
 * @param source - Where the DSN was detected from
 * @param sourcePath - Relative path to source file (for file-based sources)
 * @param packagePath - Package/app directory for monorepo grouping (e.g., "packages/frontend")
 * @returns DetectedDsn with parsed components, or null if DSN is invalid
 */
export function createDetectedDsn(
  raw: string,
  source: DsnSource,
  sourcePath?: string,
  packagePath?: string
): DetectedDsn | null {
  const parsed = parseDsn(raw);
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    raw,
    source,
    sourcePath,
    packagePath,
  };
}

/**
 * Infer package path from a source file path.
 *
 * Detects common monorepo patterns like:
 * - packages/frontend/src/index.ts → "packages/frontend"
 * - apps/web/.env → "apps/web"
 * - src/index.ts → undefined (root project)
 *
 * @param sourcePath - Relative path to source file
 * @returns Package path or undefined if at root
 */
export function inferPackagePath(sourcePath: string): string | undefined {
  const parts = sourcePath.split("/");
  const root = parts[0];
  const pkg = parts[1];

  // Check if path starts with a common monorepo directory pattern
  if (
    root &&
    pkg &&
    MONOREPO_ROOTS.includes(root as (typeof MONOREPO_ROOTS)[number])
  ) {
    return `${root}/${pkg}`;
  }

  return;
}

/**
 * Create a fingerprint from detected DSNs for cache validation.
 *
 * The fingerprint uniquely identifies the set of projects detected in a workspace.
 * Aliases cached with one fingerprint are only valid when the same DSNs are detected.
 *
 * For DSNs with orgId (SaaS pattern): uses "orgId:projectId"
 * For DSNs without orgId (self-hosted or non-standard): uses "host:projectId"
 *
 * @param dsns - Array of detected DSNs
 * @returns Fingerprint string (sorted comma-separated identifier pairs)
 *
 * @example
 * // SaaS DSNs with orgId
 * createDsnFingerprint([
 *   { orgId: "123", projectId: "456", host: "o123.ingest.sentry.io", ... },
 *   { orgId: "123", projectId: "789", host: "o123.ingest.sentry.io", ... }
 * ])
 * // Returns: "123:456,123:789"
 *
 * @example
 * // Self-hosted DSN without orgId
 * createDsnFingerprint([
 *   { projectId: "1", host: "sentry.mycompany.com", ... }
 * ])
 * // Returns: "sentry.mycompany.com:1"
 */
export function createDsnFingerprint(dsns: DetectedDsn[]): string {
  const keys = dsns
    .filter((d) => d.projectId)
    .map((d) => {
      // Use orgId if available (SaaS pattern), otherwise use host (self-hosted)
      const prefix = d.orgId ?? d.host;
      return `${prefix}:${d.projectId}`;
    })
    .sort();

  // Deduplicate (same DSN might be detected from multiple sources)
  return [...new Set(keys)].join(",");
}

/**
 * Normalize a DSN-style org identifier to a numeric org ID.
 *
 * DSN hosts encode org IDs as `oNNNNN` (e.g., `o1081365` from
 * `o1081365.ingest.us.sentry.io`). The Sentry API accepts numeric IDs
 * via `organization_id_or_slug` but not the `o`-prefixed DSN form.
 *
 * Reuses `extractOrgIdFromHost` by constructing a synthetic ingest hostname
 * from the bare identifier, sharing the same pattern logic.
 *
 * @param org - Raw org identifier (e.g. `"o1081365"` or `"my-org"`)
 * @returns Numeric org ID if input matches `oNNNNN`, otherwise unchanged
 *
 * @example
 * stripDsnOrgPrefix("o1081365")  // "1081365"
 * stripDsnOrgPrefix("o123")      // "123"
 * stripDsnOrgPrefix("sentry")    // "sentry"  (no change)
 * stripDsnOrgPrefix("organic")   // "organic" (no change — not all digits after 'o')
 */
export function stripDsnOrgPrefix(org: string): string {
  return extractOrgIdFromHost(`${org}.ingest.sentry.io`) ?? org;
}
