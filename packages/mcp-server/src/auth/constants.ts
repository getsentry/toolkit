import { SCOPES } from "@sentry/mcp-core/scopes";

/**
 * Public OAuth app registered on sentry.io for the stdio device code flow.
 * No client secret — device code grant is a public client flow.
 * The Cloudflare transport uses a separate OAuth app with a secret.
 * Override via SENTRY_CLIENT_ID environment variable.
 * See docs/operations/stdio-auth.md for the full credential architecture.
 */
export const DEFAULT_SENTRY_CLIENT_ID =
  "0acbeba7d07d58076dd7dbde8cea2fed8ab525ce3713bda604988009ab35d765";

export const DEVICE_CODE_ENDPOINT = "/oauth/device/code/";
export const TOKEN_ENDPOINT = "/oauth/token/";
export const DEVICE_CODE_SCOPES = Object.keys(SCOPES).join(" ");

/**
 * OAuth endpoints live on sentry.io regardless of regional host.
 * Always use this as the host for device code and token requests.
 */
export const OAUTH_HOST = "sentry.io";
