/**
 * Extract Sentry scope identifiers from a 403 response, so we can hint
 * at the specific missing scope instead of a hardcoded default
 * (getsentry/cli#785 #9).
 *
 * Sentry's standard 403 path is a DRF `PermissionDenied` with no
 * structured scope info, but some endpoints include the scope in the
 * free-text `detail`. We also peek at a few plausible structured field
 * names (`required` / `requiredScopes` / `scopes`) in case they're
 * added later. Empty result → callers fall back to their defaults.
 */

/**
 * Canonical Sentry scopes, mirrored from getsentry/sentry
 * `src/sentry/conf/server.py` SENTRY_SCOPES. Excludes OIDC scopes
 * (`openid`/`profile`/`email`) and internal-only `org:superuser`.
 *
 * Exported so `auth login --scope` can validate user-supplied scope values
 * against the authoritative set rather than the narrower subset the CLI
 * requests by default ({@link OAUTH_SCOPES}).
 */
export const SENTRY_SCOPES = [
  "org:read",
  "org:write",
  "org:admin",
  "org:integrations",
  "org:ci",
  "member:invite",
  "member:read",
  "member:write",
  "member:admin",
  "team:read",
  "team:write",
  "team:admin",
  "project:read",
  "project:write",
  "project:admin",
  "project:releases",
  "project:distribution",
  "event:read",
  "event:write",
  "event:admin",
  "alerts:read",
  "alerts:write",
] as const;

// Explicit alternation (not `<ns>:<action>` product) rejects nonexistent
// combinations like `release:write` or `alerts:admin`. `:` is not a
// regex metachar so no escaping needed.
const KNOWN_SCOPE_RE = new RegExp(`\\b(?:${SENTRY_SCOPES.join("|")})\\b`, "gi");

const SCOPE_FIELD_NAMES = ["required", "requiredScopes", "scopes"] as const;

/**
 * Extract Sentry scope identifiers from a 403 response detail.
 *
 * @param detail - ApiError.detail value; string, object, or undefined
 * @returns Deduplicated, source-ordered scope identifiers. Empty when none found.
 */
export function extractRequiredScopes(detail: unknown): string[] {
  if (!detail) {
    return [];
  }
  const serializedDetail =
    typeof detail === "string" ? detail : JSON.stringify(detail);
  if (isMemberProjectCreationPolicy(serializedDetail)) {
    return [];
  }
  if (typeof detail === "object") {
    const fromFields = extractFromRecord(detail as Record<string, unknown>);
    if (fromFields.length > 0) {
      return fromFields;
    }
    // Fall back to scanning the serialized form to catch non-standard keys.
    return extractFromText(JSON.stringify(detail));
  }
  if (typeof detail === "string") {
    return extractFromText(detail);
  }
  return [];
}

/** A role/policy denial can mention scope names without a token lacking them. */
function isMemberProjectCreationPolicy(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("disabled this feature for members") ||
    normalized.includes("org-level policy setting, not an auth issue")
  );
}

function extractFromRecord(record: Record<string, unknown>): string[] {
  for (const field of SCOPE_FIELD_NAMES) {
    const value = record[field];
    if (!Array.isArray(value)) {
      continue;
    }
    const scopes = collectScopesFromArray(value);
    if (scopes.length > 0) {
      return [...new Set(scopes)];
    }
  }
  return [];
}

/** Accepts both bare strings and `{scope: "..."}` objects. */
function collectScopesFromArray(entries: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const scope = extractScopeCandidate(entry);
    if (scope && matchesKnownScope(scope)) {
      out.push(scope.toLowerCase());
    }
  }
  return out;
}

function extractScopeCandidate(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (
    entry &&
    typeof entry === "object" &&
    "scope" in entry &&
    typeof (entry as { scope: unknown }).scope === "string"
  ) {
    return (entry as { scope: string }).scope;
  }
  return;
}

/** Tests + resets the shared `g`-flagged regex. */
function matchesKnownScope(scope: string): boolean {
  const matched = KNOWN_SCOPE_RE.test(scope);
  KNOWN_SCOPE_RE.lastIndex = 0;
  return matched;
}

function extractFromText(text: string): string[] {
  const matches = text.match(KNOWN_SCOPE_RE);
  if (!matches) {
    return [];
  }
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}
