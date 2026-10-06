/**
 * Sentry Org-Auth-Token (`sntrys_`) Claim Extraction
 *
 * Format: `sntrys_<base64(JSON{iat, url, region_url, org})>_<random-secret>`
 * (server-side: getsentry/sentry `orgauthtoken_token.py`).
 *
 * The claim is **NOT signed** — anyone can forge a `sntrys_` string with any
 * `url`. However, for legitimate tokens the claim IS authoritative: the real
 * server wrote it at issuance time, and it's immune to env-injection attacks
 * (the attacker who can poison `SENTRY_HOST` via `$GITHUB_ENV` can't read or
 * modify the token bytes). `captureEnvTokenHost` uses the claim as the
 * primary trust source for `sntrys_` tokens, ahead of env vars.
 *
 * The forgery risk is accepted: an attacker who can supply a forged token has
 * already compromised the credential itself (out of threat model).
 */

const SNTRYS_PREFIX = "sntrys_";

/** 2 KB cap. Real tokens are ~150-300 bytes; cap defends the auth hot path. */
const MAX_TOKEN_LENGTH = 2048;

/** Return a non-empty string from a parsed claim field, or `undefined`. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Subset of `sntrys_` payload fields we care about. */
export type SntrysClaim = {
  url: string;
  regionUrl?: string;
  /** Organization slug embedded in the token at issuance time. */
  org?: string;
};

/**
 * Extract the `url` (and optional `region_url`) claim from a Sentry
 * org-auth-token. Returns `undefined` for any non-`sntrys_` token, any
 * malformed token, or any payload missing `iat` or `url`.
 *
 * Read the file-level JSDoc before adding new callers.
 */
export function parseSntrysClaim(
  token: string | undefined
): SntrysClaim | undefined {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return;
  }
  if (!token.startsWith(SNTRYS_PREFIX)) {
    return;
  }
  // Server contract: exactly 2 underscores. Standard base64 alphabet has no
  // `_`, so the second one always separates payload from secret.
  if ((token.match(/_/g) ?? []).length !== 2) {
    return;
  }
  const payloadEncoded = token.slice(
    SNTRYS_PREFIX.length,
    token.lastIndexOf("_")
  );
  if (!payloadEncoded) {
    return;
  }

  let parsed: unknown;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    parsed = JSON.parse(Buffer.from(payloadEncoded, "base64").toString("utf8"));
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const obj = parsed as Record<string, unknown>;

  // Match server's `parse_token`: rejects payloads without truthy `iat`.
  if (!obj.iat) {
    return;
  }

  const url = obj.url;
  if (typeof url !== "string" || !url) {
    return;
  }

  const regionUrl = optionalString(obj.region_url);
  const org = optionalString(obj.org);

  return { url, regionUrl, org };
}
