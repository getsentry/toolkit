/**
 * CVE regression: `sentry auth login` in a `.sentryclirc`-poisoned repo.
 *
 * Two attack shapes are blocked by `refuseLoginToUntrustedHost`:
 *
 * **Token leak** (`auth login --token X`):
 * 1. User has a SaaS API token from `https://sentry.io/settings/auth-tokens/`.
 * 2. User cd's into an attacker repo with `.sentryclirc` setting
 *    `url = https://evil.com`.
 * 3. User runs `sentry auth login --token $SENTRY_API_TOKEN` (no --url).
 * 4. The rc shim writes `env.SENTRY_URL = evil.com` (the URL trust check
 *    is deferred to buildCommand, and auth login has skipRcUrlCheck: true). Without the refusal, login validation would
 *    POST the user's token to evil.com.
 *
 * **Phishing** (`auth login` OAuth device flow, no --token):
 * 1. Same poisoned-rc setup.
 * 2. User runs `sentry auth login` to set up Sentry per the repo's README.
 * 3. CLI prints the device-code URL pointing at evil.com. With a
 *    homograph or look-alike domain (e.g. `sentry-io.example-attacker.com`),
 *    the user opens it without scrutiny and authenticates with their
 *    SSO credentials at the attacker's cloned login page. SSO leak is
 *    worse than a single token leak — it compromises every service the
 *    SSO covers.
 *
 * Fix: `refuseLoginToUntrustedHost` rejects login (both --token and
 * OAuth paths) when the effective host wasn't registered as a login
 * trust anchor (didn't come from explicit `--url` or boot-time env).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loginCommand } from "../../../src/commands/auth/login.js";
import { captureEnvTokenHost } from "../../../src/lib/env-token-host.js";
import { HostScopeError } from "../../../src/lib/errors.js";
import {
  extractFetchUrl,
  resetHostScopingState,
  useEnvSandbox,
} from "../../helpers.js";

const ENV_KEYS = [
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_CLIENT_ID",
  "SENTRY_CUSTOM_HEADERS",
] as const;

type LoginFlags = {
  readonly token?: string;
  readonly timeout: number;
  readonly force: boolean;
  readonly url?: string;
};

type LoginFunc = (this: unknown, flags: LoginFlags) => Promise<void>;

const noop = () => {
  // write sinks in test context
};

function createContext() {
  return {
    stdout: { write: noop },
    stderr: { write: noop },
    cwd: "/tmp",
  };
}

/**
 * Check if a URL's hostname exactly matches one of the given hostnames.
 * Use in preference to `.includes()` substring matching — a crafted
 * URL like `https://evil.com.attacker.com/` would pass a substring
 * check on `"evil.com"` and produce a false security assurance.
 */
function urlHostnameIn(url: string, hostnames: string[]): boolean {
  try {
    return hostnames.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe("CVE: auth login --token with rc-poisoned env.SENTRY_URL", () => {
  useEnvSandbox(ENV_KEYS);

  let fetchCalls: { url: string; authorization: string | null }[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    await resetHostScopingState();

    // Intercept fetch to assert no outbound requests on the attacker path.
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      fetchCalls.push({
        url: extractFetchUrl(input),
        authorization: headers.get("Authorization"),
      });
      throw new Error("test: unexpected fetch");
    }) as typeof fetch;
  });

  afterEach(async () => {
    await resetHostScopingState();
    globalThis.fetch = originalFetch;
  });

  test("auth login --token without --url in rc-poisoned env throws before network I/O", async () => {
    // Simulate the attack state: no SENTRY_HOST at boot (env-token-host
    // captures SaaS default), then rc shim writes env.SENTRY_URL to the
    // attacker's host.
    captureEnvTokenHost(); // captures SaaS default (no env set)
    process.env.SENTRY_URL = "https://evil.com"; // simulate rc shim write

    const func = (await loginCommand.loader()) as unknown as LoginFunc;
    const context = createContext();

    await expect(
      func.call(context, {
        token: "user-saas-api-token-secret",
        force: false,
        timeout: 900,
      })
    ).rejects.toBeInstanceOf(HostScopeError);

    // Critical: the user's token NEVER hit the wire.
    const leaked = fetchCalls.filter((c) =>
      c.authorization?.includes("user-saas-api-token-secret")
    );
    expect(leaked).toEqual([]);
    // And no requests to the attacker at all
    const toEvil = fetchCalls.filter((c) => urlHostnameIn(c.url, ["evil.com"]));
    expect(toEvil).toEqual([]);
  });

  test("auth login OAuth flow (no token, no --url) in rc-poisoned env: refused before browser open", async () => {
    // Phishing defense: the OAuth device flow would otherwise direct
    // the user's browser to <attacker>/oauth/authorize/... A homograph
    // domain plus a Sentry-cloned login page can capture SSO
    // credentials. Refusing here keeps the user from opening the
    // attacker URL in the first place — much stronger than relying on
    // them to spot the malicious URL in terminal output.
    captureEnvTokenHost();
    process.env.SENTRY_URL = "https://evil.com";

    const func = (await loginCommand.loader()) as unknown as LoginFunc;
    const context = createContext();

    await expect(
      func.call(context, { force: false, timeout: 900 })
    ).rejects.toBeInstanceOf(HostScopeError);

    const toEvil = fetchCalls.filter((c) => urlHostnameIn(c.url, ["evil.com"]));
    expect(toEvil).toEqual([]);
  });

  test("auth login --url explicitly acknowledges the host (legitimate onboarding)", async () => {
    // The explicit --url path is the documented way to acknowledge a
    // new host. rc-sourced env.SENTRY_URL is overwritten by applyLoginUrl.
    captureEnvTokenHost();
    process.env.SENTRY_URL = "https://evil.com"; // poisoned by rc

    const func = (await loginCommand.loader()) as unknown as LoginFunc;
    const context = createContext();

    // User explicitly says `--url https://sentry.example.com` — this
    // wins over the rc-poisoned env. Host is registered as anchor, so
    // no HostScopeError. The actual login fires and hits our mock fetch
    // (which throws), but importantly: it targets the user's intended
    // host, not the attacker's.
    await expect(
      func.call(context, {
        token: "legit-token",
        url: "https://sentry.example.com",
        force: false,
        timeout: 900,
      })
    ).rejects.toThrow(); // our fetch mock throws

    const toEvil = fetchCalls.filter((c) => urlHostnameIn(c.url, ["evil.com"]));
    expect(toEvil).toEqual([]);
    const toIntended = fetchCalls.filter((c) =>
      urlHostnameIn(c.url, ["sentry.example.com"])
    );
    expect(toIntended.length).toBeGreaterThan(0);
  });

  test("auth login --token with SENTRY_HOST but no --url: requires explicit --url", async () => {
    // Even when SENTRY_HOST is legitimately shell-exported, --token login
    // requires --url to confirm the host. This simplifies the trust model
    // (only --url registers a trust anchor) and avoids the boot-snapshot
    // comparison complexity. Self-hosted users add --url on first login.
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    captureEnvTokenHost();

    const func = (await loginCommand.loader()) as unknown as LoginFunc;
    const context = createContext();

    await expect(
      func.call(context, {
        token: "legit-token",
        force: false,
        timeout: 900,
      })
    ).rejects.toBeInstanceOf(HostScopeError);

    // No network I/O attempted.
    expect(fetchCalls).toEqual([]);
  });

  test("stale login anchor for hostA does NOT admit login --token in rc-poisoned hostB", async () => {
    // Library-mode regression: a previous applyLoginUrl(--url=hostA) in
    // the same process registers a login anchor for hostA. A subsequent
    // `auth login --token X` in a poisoned-rc hostB env must NOT use
    // hostA's anchor as a free pass — the refusal guard checks anchor↔host
    // match, not anchor existence.
    captureEnvTokenHost();
    const { registerLoginTrustAnchor } = await import(
      "../../../src/lib/token-host.js"
    );
    registerLoginTrustAnchor("https://sentry.hosta.com");

    process.env.SENTRY_URL = "https://evil.com";

    const func = (await loginCommand.loader()) as unknown as LoginFunc;
    const context = createContext();

    await expect(
      func.call(context, {
        token: "user-saas-api-token-secret",
        force: false,
        timeout: 900,
      })
    ).rejects.toBeInstanceOf(HostScopeError);

    const toEvil = fetchCalls.filter((c) => urlHostnameIn(c.url, ["evil.com"]));
    expect(toEvil).toEqual([]);
  });
});
