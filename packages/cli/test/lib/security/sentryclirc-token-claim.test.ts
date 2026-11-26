/**
 * `.sentryclirc` `sntrys_` token scoped to its own claim.
 *
 * A project rc that holds an org auth token and the self-hosted URL it was
 * issued for (what `sentry wizard` writes) must work: the token's `url`
 * claim names its server. Changing only the URL, by writing or appending to
 * an rc or adding a project rc under a global one that holds the token,
 * must not point the token at another host, and `SENTRY_CUSTOM_HEADERS`
 * must not reach a host that only the rc names.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listOrganizations } from "@sentry/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { _resetCustomHeadersCache } from "../../../src/lib/custom-headers.js";
import {
  getCredentialContext,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { captureEnvTokenHost } from "../../../src/lib/env-token-host.js";
import { HostScopeError } from "../../../src/lib/errors.js";
import {
  applySentryCliRcEnvShim,
  assertRcUrlTrusted,
  CONFIG_FILENAME,
  clearSentryCliRcCache,
} from "../../../src/lib/sentryclirc.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { getSdkClientConfig } from "../../../src/lib/sentry-sdk-client.js";
import {
  assertCredentialScope,
  isRequestOriginTrustedForCustomHeaders,
} from "../../../src/lib/token-host.js";
import {
  mintSntrysToken,
  mockFetch,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

const ACME = "https://sentry.acme.com";
const EVIL = "https://evil.example.com";
const ACME_TOKEN = mintSntrysToken({ iat: 1, url: ACME, org: "acme" });

const getConfigDir = useTestConfigDir("sentryclirc-claim-", {
  isolateProjectRoot: true,
});
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CUSTOM_HEADERS",
]);

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  clearSentryCliRcCache();
  _resetCustomHeadersCache();
  resetAuthenticatedFetch();
  await resetHostScopingState();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearSentryCliRcCache();
  _resetCustomHeadersCache();
  resetAuthenticatedFetch();
  await resetHostScopingState();
});

/** Send one request through the authenticated fetch; return its headers. */
async function sentHeaders(baseUrl: string): Promise<Headers> {
  let sent: Headers | undefined;
  globalThis.fetch = mockFetch(async (input, init) => {
    sent = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    return Response.json([]);
  });
  await listOrganizations({
    ...getSdkClientConfig(baseUrl),
    throwOnError: true,
  });
  if (!sent) {
    throw new Error("No request was sent");
  }
  return sent;
}

function writeRc(dir: string, content: string): void {
  writeFileSync(join(dir, CONFIG_FILENAME), content, "utf-8");
}

/** A project directory below the config dir, whose rc is the global one. */
function projectDir(): string {
  const dir = join(getConfigDir(), "project");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** Boot order of `preloadProjectContext`: snapshot env, then the rc shim. */
async function boot(cwd: string): Promise<void> {
  captureEnvTokenHost();
  await applySentryCliRcEnvShim(cwd);
}

describe(".sentryclirc sntrys_ token", () => {
  test("is trusted with an rc url that matches its claim", async () => {
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${ACME_TOKEN}\n[defaults]\nurl = ${ACME}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).resolves.toBeUndefined();
    const credential = getCredentialContext();
    expect(credential?.host).toBe(ACME);
    expect(() =>
      assertCredentialScope(`${ACME}/api/0/organizations/`, credential),
    ).not.toThrow();
  });

  test("is refused with an rc url for another host", async () => {
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${ACME_TOKEN}\n[defaults]\nurl = ${EVIL}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).rejects.toThrow(HostScopeError);
    expect(() =>
      assertCredentialScope(`${EVIL}/api/0/`, getCredentialContext()),
    ).toThrow(HostScopeError);
  });

  test("is refused when an appended url names another host", async () => {
    const dir = projectDir();
    writeRc(
      dir,
      `[auth]\ntoken = ${ACME_TOKEN}\n[defaults]\nurl = ${ACME}\n` +
        `[defaults]\nurl = ${EVIL}\n`,
    );
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).rejects.toThrow(HostScopeError);
  });

  test("from a global rc is refused with a project rc url for another host", async () => {
    const dir = projectDir();
    writeRc(getConfigDir(), `[auth]\ntoken = ${ACME_TOKEN}\n`);
    writeRc(dir, `[defaults]\nurl = ${EVIL}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).rejects.toThrow(HostScopeError);
  });

  test("from a global rc is trusted with a project rc url that matches its claim", async () => {
    const dir = projectDir();
    writeRc(getConfigDir(), `[auth]\ntoken = ${ACME_TOKEN}\n`);
    writeRc(dir, `[defaults]\nurl = ${ACME}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).resolves.toBeUndefined();
  });

  test("does not send SENTRY_CUSTOM_HEADERS to the rc host", async () => {
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${ACME_TOKEN}\n[defaults]\nurl = ${ACME}\n`);
    await boot(dir);

    await assertRcUrlTrusted(dir);
    expect(isRequestOriginTrustedForCustomHeaders(`${ACME}/api/0/`)).toBe(
      false,
    );
  });

  test("does not send SENTRY_CUSTOM_HEADERS to the rc host on authenticated requests", async () => {
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${ACME_TOKEN}\n[defaults]\nurl = ${ACME}\n`);
    await boot(dir);
    await assertRcUrlTrusted(dir);

    const headers = await sentHeaders(ACME);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACME_TOKEN}`);
    expect(headers.get("X-IAP-Token")).toBeNull();
  });

  test("sends SENTRY_CUSTOM_HEADERS on authenticated requests to a boot SENTRY_URL that matches", async () => {
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
    process.env["SENTRY_URL"] = ACME;
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${ACME_TOKEN}\n`);
    await boot(dir);

    const headers = await sentHeaders(ACME);
    expect(headers.get("X-IAP-Token")).toBe("secret");
  });

  test("keeps SENTRY_CUSTOM_HEADERS on a boot SENTRY_URL that matches", async () => {
    process.env["SENTRY_CUSTOM_HEADERS"] = "X-IAP-Token: secret";
    process.env["SENTRY_URL"] = ACME;
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${ACME_TOKEN}\n`);
    await boot(dir);

    expect(isRequestOriginTrustedForCustomHeaders(`${ACME}/api/0/`)).toBe(true);
  });
});

describe("unchanged trust paths", () => {
  test("an opaque rc token with a self-hosted rc url is refused", async () => {
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = opaque-token\n[defaults]\nurl = ${ACME}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).rejects.toThrow(HostScopeError);
  });

  test("an env sntrys_ token is trusted with an rc url that matches its claim", async () => {
    process.env["SENTRY_AUTH_TOKEN"] = ACME_TOKEN;
    const dir = projectDir();
    writeRc(dir, `[defaults]\nurl = ${ACME}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).resolves.toBeUndefined();
    expect(isRequestOriginTrustedForCustomHeaders(`${ACME}/api/0/`)).toBe(true);
  });

  test("an env sntrys_ token is refused with an rc url for another host", async () => {
    process.env["SENTRY_AUTH_TOKEN"] = ACME_TOKEN;
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = opaque-token\n[defaults]\nurl = ${EVIL}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).rejects.toThrow(HostScopeError);
  });

  test("a stored login wins over an rc token whose claim names the rc url", async () => {
    setAuthToken("stored-token", undefined, undefined, { host: ACME });
    const evilToken = mintSntrysToken({ iat: 1, url: EVIL });
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = ${evilToken}\n[defaults]\nurl = ${EVIL}\n`);
    await boot(dir);

    expect(getCredentialContext()?.host).toBe(ACME);
    await expect(assertRcUrlTrusted(dir)).rejects.toThrow(HostScopeError);
  });

  test("a stored login on the rc url's host is trusted", async () => {
    setAuthToken("stored-token", undefined, undefined, { host: ACME });
    const dir = projectDir();
    writeRc(dir, `[auth]\ntoken = opaque-token\n[defaults]\nurl = ${ACME}\n`);
    await boot(dir);

    await expect(assertRcUrlTrusted(dir)).resolves.toBeUndefined();
  });
});
