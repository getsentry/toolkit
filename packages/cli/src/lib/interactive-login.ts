/**
 * Interactive Login Flow
 *
 * Reusable OAuth device flow with UI for interactive terminals.
 * Used by both the `auth login` command and auto-auth in bin.ts.
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import { openBrowser } from "./browser.js";
import { setupCopyKeyListener } from "./clipboard.js";
import { getDbPath } from "./db/index.js";
import { setUserInfo } from "./db/user.js";
import { formatError } from "./errors.js";
import { renderInlineMarkdown } from "./formatters/markdown.js";
import { logger } from "./logger.js";
import { completeOAuthFlow, performDeviceFlow } from "./oauth.js";
import { generateQRCode } from "./qrcode.js";

const log = logger.withTag("auth.login");

/** Structured result returned on successful authentication. */
export type LoginResult = {
  /** Authentication method used. */
  method: "oauth" | "token";
  /** User identity if available. */
  user?: { name?: string; email?: string; username?: string; id?: string };
  /** Path where credentials are stored. */
  configPath: string;
  /** Token lifetime in seconds, if known. */
  expiresIn?: number;
  /** Whether the OAuth access token can be refreshed automatically. */
  refreshEnabled?: boolean;
};

/**
 * Build a clean user object for {@link LoginResult}, omitting falsy
 * fields (null, undefined, empty string) so they don't leak into output.
 *
 * Empty-string names/emails are semantically absent for display purposes.
 */
export function toLoginUser(user: {
  id: string;
  name?: string | null;
  email?: string | null;
  username?: string | null;
}): NonNullable<LoginResult["user"]> {
  return Object.fromEntries(
    Object.entries(user).filter(([k, v]) => k === "id" || Boolean(v))
  ) as NonNullable<LoginResult["user"]>;
}

/** Options for the interactive login flow */
export type InteractiveLoginOptions = {
  /** Timeout for OAuth flow in milliseconds (default: 900000 = 15 minutes) */
  timeout?: number;
  /**
   * Space-joined OAuth scope string to request. When omitted, the device flow
   * requests the full default scope set. Build via `resolveOAuthScopeString`.
   */
  scope?: string;
};

/**
 * Build the user-facing display lines for the device flow verification step.
 *
 * Shows the complete verification URL (with embedded user code) so it works
 * in environments where the browser can't auto-open (SSH, CI, etc.).
 * Uses `renderInlineMarkdown()` for styled output that respects `NO_COLOR`.
 *
 * Extracted from the `onUserCode` callback for testability.
 *
 * @param userCode - The device flow user code (e.g., "ABCD-EFGH")
 * @param verificationUriComplete - Full URL with `?user_code=...` embedded
 * @param browserOpened - Whether the browser was successfully opened
 * @param isTTY - Whether stdin is a TTY (controls copy-to-clipboard hint)
 * @returns Array of strings to emit via `log.log()`, one per call
 */
export function buildDeviceFlowDisplay(
  userCode: string,
  verificationUriComplete: string,
  browserOpened: boolean,
  isTTY: boolean
): string[] {
  const lines: string[] = [];

  lines.push("");
  // URL is emitted as plain text (no markdown rendering) so it stays
  // intact for copy-paste in all output modes including plain/CI.
  lines.push(`  URL:  ${verificationUriComplete}`);
  lines.push(renderInlineMarkdown(`  Code: \`${userCode}\``));
  lines.push("");

  if (!browserOpened) {
    const copyHint = isTTY ? renderInlineMarkdown(" *(`c` to copy URL)*") : "";
    lines.push(`  Copy the URL above to sign in.${copyHint}`);
    lines.push("");
  }

  return lines;
}

/**
 * Run the interactive OAuth device flow login.
 *
 * Handles the full device flow including:
 * - Displaying verification URL and user code
 * - Opening browser automatically (or showing QR code as fallback)
 * - Setting up keyboard listener for copying URL
 * - Storing the token and user info on success
 *
 * All UI output goes to stderr via the logger, keeping stdout clean for
 * structured command output. A spinner replaces raw polling dots for a
 * cleaner interactive experience.
 *
 * @param options - Optional configuration
 * @returns Structured login result on success, or null on failure/cancellation
 */
export async function runInteractiveLogin(
  options?: InteractiveLoginOptions
): Promise<LoginResult | null> {
  const timeout = options?.timeout ?? 900_000; // 15 minutes default
  const scope = options?.scope;

  log.info("Starting authentication...");

  let urlToCopy = "";
  // Object wrapper needed for TypeScript control flow analysis with async callbacks
  const keyListener = { cleanup: null as (() => void) | null };

  try {
    const tokenResponse = await performDeviceFlow(
      {
        onUserCode: async (
          userCode,
          _verificationUri,
          verificationUriComplete
        ) => {
          urlToCopy = verificationUriComplete;

          // Try to open browser (best effort)
          const browserOpened = await openBrowser(verificationUriComplete);

          if (browserOpened) {
            log.info("Opening in browser...");
          } else {
            // Show QR code as fallback when browser can't open
            log.info("Scan this QR code or visit the URL below:");
            const qr = await generateQRCode(verificationUriComplete);
            log.log(qr);
          }

          // Show the complete URL (with user_code embedded) and optional copy hint
          const displayLines = buildDeviceFlowDisplay(
            userCode,
            verificationUriComplete,
            browserOpened,
            process.stdin.isTTY ?? false
          );
          for (const line of displayLines) {
            log.log(line);
          }

          // Use a spinner for the "waiting" state instead of raw polling dots
          log.start("Waiting for authorization...");

          // Setup keyboard listener for 'c' to copy URL
          if (process.stdin.isTTY) {
            keyListener.cleanup = setupCopyKeyListener(
              process.stdin as NodeJS.ReadStream & { fd: 0 },
              () => urlToCopy
            );
          }
        },
      },
      timeout,
      scope
    );

    // Stop the spinner
    log.success("Authorization received!");

    // Store the token
    await completeOAuthFlow(tokenResponse);

    // Store user info from token response for telemetry and display
    const user = tokenResponse.user;
    if (user) {
      try {
        setUserInfo({
          userId: user.id,
          email: user.email ?? undefined,
          name: user.name ?? undefined,
        });
      } catch (error) {
        // Report to Sentry but don't block auth - user info is not critical
        Sentry.captureException(error);
      }
    }

    const result: LoginResult = {
      method: "oauth",
      configPath: getDbPath(),
      expiresIn: tokenResponse.expires_in,
      refreshEnabled: Boolean(tokenResponse.refresh_token),
    };
    if (user) {
      result.user = toLoginUser(user);
    }
    return result;
  } catch (err) {
    log.fail("Authorization failed");
    log.error(formatError(err));
    return null;
  } finally {
    // Always cleanup keyboard listener
    keyListener.cleanup?.();
  }
}
