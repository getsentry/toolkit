/**
 * Credential identity hashing, shared by the account store and schema
 * migrations (which cannot import the DB-backed modules).
 */

import { createHash } from "node:crypto";

/**
 * Stable SHA-256 namespace for high-entropy OAuth and organization tokens.
 * A collision would mix credentials' cached responses, so retain the full
 * digest. This fingerprint is never a password verifier or a bearer token.
 */
export function hashIdentity(kind: string, secret: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(secret)
    .digest("hex");
}

/** Cache namespace for stored OAuth credentials (matches `getIdentityFingerprint`). */
export function storedCredentialIdentity(row: {
  token: string | null;
  refresh_token: string | null;
}): string | undefined {
  if (row.refresh_token) {
    return hashIdentity("oauth", row.refresh_token);
  }
  if (row.token) {
    return hashIdentity("oauth-access", row.token);
  }
  return;
}
