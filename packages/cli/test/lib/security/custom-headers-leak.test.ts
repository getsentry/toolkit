/**
 * CVE regression: custom-headers leak via share URL and via the
 * `auth login` rc-URL bypass.
 *
 * Tests `applyCustomHeaders` trust scoping. Two attack shapes:
 * 1. Share URL: `getSharedIssue(https://evil.com, ...)` — headers must
 *    not attach to URLs that don't match the active token.
 * 2. auth login bypass: when `env.SENTRY_URL` is rc-poisoned and no
 *    token is active yet, headers must fail closed.
 *
 * See also `fetch-layer-guard.test.ts` for the Bearer-token path.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSharedIssue } from "../../../src/lib/api/issues.js";
import {
  _resetCustomHeadersCache,
  applyCustomHeaders,
} from "../../../src/lib/custom-headers.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import {
  captureEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../../src/lib/env-token-host.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../../src/lib/sentry-client.js";
import {
  mintSntrysToken,
  mockFetch,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

const ENV_KEYS = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CUSTOM_HEADERS",
] as const;

describe("CVE: custom-headers leak (share URL + auth-login bypass)", () => {
  useEnvSandbox(ENV_KEYS);

  beforeEach(() => {
    resetEnvTokenHostForTesting();
    _resetCustomHeadersCache();
  });

  afterEach(() => {
    resetEnvTokenHostForTesting();
    _resetCustomHeadersCache();
  });

  test("getSharedIssue with attacker baseUrl does not leak custom headers (direct-call regression)", async () => {
    // Simulates someone bypassing applySentryUrlContext and calling
    // getSharedIssue directly with an attacker-controlled baseUrl.
    // Simulates someone bypassing applySentryUrlContext and calling
    // getSharedIssue directly with an attacker-controlled baseUrl.
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
    process.env["SENTRY_HOST"] = "https://sentry.acme.com";
    captureEnvTokenHost();

    // Intercept fetch to capture outbound headers
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      return new Response("{}", { status: 404 });
    };

    try {
      await getSharedIssue(
        "https://evil.com",
        "test-org",
        "deadbeef12345678",
      ).catch(() => {
        /* we only care about headers, not the response */
      });
      expect(capturedHeaders?.get("X-IAP-Token")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("IAP onboarding: 'auth login --url' registers a trust anchor so custom headers attach during OAuth device flow", async () => {
    // Scenario: first-time self-hosted login with IAP protection.
    // User runs `sentry auth login --url https://sentry.acme.com` before
    // having any token. The device-code request MUST carry the IAP
    // token or the IAP proxy will block it.
    delete process.env["SENTRY_AUTH_TOKEN"];
    delete process.env["SENTRY_TOKEN"];
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: legit";

    // `applyLoginUrl` (from login command) registers the trust anchor
    const { applyLoginUrl } =
      await import("../../../src/commands/auth/login.js");
    applyLoginUrl("https://sentry.acme.com");

    const headers = new Headers();
    applyCustomHeaders(headers, "https://sentry.acme.com/oauth/device/code/");
    // Legitimate IAP token attaches — this is the onboarding case
    expect(headers.get("X-IAP-Token")).toBe("legit");

    // Cleanup the anchor so subsequent tests aren't affected
    const { resetLoginTrustAnchorForTesting } =
      await import("../../../src/lib/token-host.js");
    resetLoginTrustAnchorForTesting();
  });

  test("Attacker .sentryclirc does NOT register a login trust anchor (rc bypass still fails closed)", async () => {
    // This is the critical distinguishing test: the .sentryclirc shim
    // writes env.SENTRY_URL (trust check is deferred to buildCommand), but it
    // does NOT call registerLoginTrustAnchor. So no-token
    // applyCustomHeaders must still fail closed even though SENTRY_URL
    // is set.
    delete process.env["SENTRY_AUTH_TOKEN"];
    delete process.env["SENTRY_TOKEN"];
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
    process.env["SENTRY_URL"] = "https://evil.com"; // simulating rc shim write
    // Intentionally NOT calling applyLoginUrl — attacker flow doesn't

    const { resetLoginTrustAnchorForTesting } =
      await import("../../../src/lib/token-host.js");
    resetLoginTrustAnchorForTesting();

    const headers = new Headers();
    applyCustomHeaders(headers, "https://evil.com/oauth/device/code/");
    expect(headers.get("X-IAP-Token")).toBeNull();
  });
});

/**
 * getsentry/toolkit#2545: the share lookup is unauthenticated, so no
 * credential guard vouches for its host. A CI step that can write
 * `$GITHUB_ENV` sets `SENTRY_URL` to its own host without reading the token;
 * a later `sentry issue view <share-url>` for that host must not send it
 * `SENTRY_CUSTOM_HEADERS`. Only a host the user logged in to qualifies.
 */
describe("custom headers on unauthenticated requests need a login", () => {
  useTestConfigDir("custom-headers-login-");
  useEnvSandbox(ENV_KEYS);

  const ACME = "https://sentry.acme.com";
  let originalFetch: typeof globalThis.fetch;
  let sent: Headers[];

  beforeEach(async () => {
    await resetHostScopingState();
    _resetCustomHeadersCache();
    resetAuthenticatedFetch();
    originalFetch = globalThis.fetch;
    sent = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      sent.push(
        new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ),
      );
      return Response.json({ id: "1" });
    });
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetAuthenticatedFetch();
    _resetCustomHeadersCache();
    await resetHostScopingState();
  });

  test("an env-only SENTRY_URL host gets no custom headers on the share lookup with an env token", async () => {
    process.env["SENTRY_AUTH_TOKEN"] = "opaque-env-token";
    process.env["SENTRY_URL"] = ACME;
    captureEnvTokenHost();

    await getSharedIssue(ACME, "test-org", "deadbeef12345678");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("X-IAP-Token")).toBeNull();
  });

  test("an env-only SENTRY_URL host gets no custom headers on the share lookup with an rc token", async () => {
    process.env["SENTRY_URL"] = ACME;
    captureEnvTokenHost();
    // The .sentryclirc shim copies `[auth] token` in after the boot snapshot.
    process.env["SENTRY_AUTH_TOKEN"] = mintSntrysToken({ iat: 1, url: ACME });

    await getSharedIssue(ACME, "test-org", "deadbeef12345678");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("X-IAP-Token")).toBeNull();
  });

  test("a stored login's host still gets custom headers on the share lookup", async () => {
    process.env["SENTRY_URL"] = ACME;
    captureEnvTokenHost();
    setAuthToken("stored-token", undefined, undefined, { host: ACME });

    await getSharedIssue(ACME, "test-org", "deadbeef12345678");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("X-IAP-Token")).toBe("secret");
    expect(sent[0]?.has("Authorization")).toBe(false);
  });

  test("authenticated requests to the env token's host still get custom headers", async () => {
    process.env["SENTRY_AUTH_TOKEN"] = "opaque-env-token";
    process.env["SENTRY_URL"] = ACME;
    captureEnvTokenHost();

    await getSdkConfig(ACME).fetch(`${ACME}/api/0/organizations/`);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("Authorization")).toBe("Bearer opaque-env-token");
    expect(sent[0]?.get("X-IAP-Token")).toBe("secret");
  });
});
