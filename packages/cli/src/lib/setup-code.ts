/** Read the issuing Sentry instance from a private setup code. */

import { looseObject, safeParse, string } from "valibot";
import type { BootstrapResult } from "../output-schemas/auth.js";
import { pointDefaultUrlAtAccount } from "./account-selection.js";
import { sentry } from "./app-identity.js";
import { normalizeAuthToken } from "./auth-header.js";
import {
  getAccountIdToReplace,
  hasStoredAuthCredentials,
  setAuthToken,
} from "./db/auth.js";
import { getDbPath } from "./db/index.js";
import { clearUserInfo, setUserInfo } from "./db/user.js";
import { getEnv, withEnv } from "./env.js";
import {
  getBootConfiguredSentryUrl,
  inheritEnvTokenHost,
} from "./env-token-host.js";
import { toLoginUser } from "./interactive-login.js";
import { exchangeSetupCode } from "./oauth.js";
import { registerLoginTrustAnchor } from "./token-host.js";
import { ValidationError } from "./errors.js";
import { normalizeHttpOrigin } from "./sentry-urls.js";

export type { BootstrapResult } from "../output-schemas/auth.js";

const setupCodePattern = /^sntryc_([A-Za-z0-9+/=]+)_([A-Za-z0-9+/]{43})$/;
const claimSchema = looseObject({ url: string() });

/** Resolve the issuing instance from the code's unsigned routing claim. */
export function getSetupCodeHost(code: string): string {
  const encodedClaim = setupCodePattern.exec(code)?.[1];

  if (!encodedClaim) {
    throw new ValidationError("Invalid Sentry setup code.", "setup-code");
  }

  let claim: unknown;

  try {
    claim = JSON.parse(Buffer.from(encodedClaim, "base64").toString("utf8"));
  } catch {
    throw new ValidationError("Invalid Sentry setup code.", "setup-code");
  }

  const parsed = safeParse(claimSchema, claim);
  const host = parsed.success
    ? normalizeHttpOrigin(parsed.output.url)
    : undefined;

  if (!host) {
    throw new ValidationError("Invalid setup-code instance URL.", "setup-code");
  }

  return host;
}

/** Redeem a private setup code, replacing only the issuing server's selected login. */
export async function bootstrapAuthentication(
  options: {
    /** Explicit consent to replace an existing stored login. */
    force?: boolean;
    /** Explicit issuing instance URL, required for HTTP without a boot-time URL. */
    url?: string;
  } = {},
): Promise<BootstrapResult> {
  const code = getEnv().SENTRY_SETUP_CODE;

  if (!code) {
    throw new ValidationError(
      "Set SENTRY_SETUP_CODE to the private code provided by Sentry.",
      "setup-code",
    );
  }

  const host = getSetupCodeHost(code);

  if (options.url && normalizeHttpOrigin(options.url) !== host) {
    throw new ValidationError(
      "The setup code belongs to a different Sentry instance.",
      "url",
    );
  }

  if (
    !host.startsWith("https://") &&
    !options.url &&
    getBootConfiguredSentryUrl() !== host
  ) {
    throw new ValidationError(
      "HTTP setup requires an explicit --url or SENTRY_URL for the issuing instance.",
      "url",
    );
  }

  if (
    (getAccountIdToReplace(host) !== undefined || hasStoredAuthCredentials()) &&
    !options.force
  ) {
    throw new ValidationError(
      `A stored login already exists. To replace it, run:\nSENTRY_SETUP_CODE='<setup-code>' ${sentry`auth bootstrap --force`}`,
      "force",
    );
  }

  if (options.url || getBootConfiguredSentryUrl() === host) {
    registerLoginTrustAnchor(host);
  }

  const env = { ...getEnv(), SENTRY_HOST: host, SENTRY_URL: host };
  inheritEnvTokenHost(env);

  return await withEnv(env, async () => {
    const token = await exchangeSetupCode(code, host);
    const accessToken = normalizeAuthToken(token.access_token);
    setAuthToken(accessToken, token.expires_in, token.refresh_token, {
      host,
    });
    pointDefaultUrlAtAccount(host);

    if (token.user) {
      setUserInfo({
        userId: token.user.id,
        email: token.user.email ?? undefined,
        name: token.user.name ?? undefined,
      });
    } else {
      clearUserInfo();
    }

    return {
      method: "oauth",
      configPath: getDbPath(),
      expiresIn: token.expires_in,
      refreshEnabled: Boolean(token.refresh_token),
      ...(token.user ? { user: toLoginUser(token.user) } : {}),
    };
  });
}
