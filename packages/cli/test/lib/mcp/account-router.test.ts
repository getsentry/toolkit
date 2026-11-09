import { ConfigurationError } from "@sentry/api/client";
import { describe, expect, test } from "vitest";
import {
  clearAuth,
  setActiveAccount,
  setAuthToken,
  type StoredAccountRef,
  withStoredAccount,
} from "../../../src/lib/db/auth.js";
import { setOrgRegions } from "../../../src/lib/db/regions.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import { withEnv } from "../../../src/lib/env.js";
import { AuthError } from "../../../src/lib/errors.js";
import {
  createMcpAccountRouter,
  type StoredAccountPin,
} from "../../../src/lib/mcp/account-router.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("mcp-account-router-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const SAAS = "https://sentry.io";
let nextOrgId = 9000;

function login(token: string, userId: string): string {
  const id = setAuthToken(token, 3600, `${token}-refresh`, {
    host: SAAS,
    newAccount: true,
  });
  setUserInfo({ userId, email: `${userId}@example.com` });
  return id;
}

/** Cache a full org list for the account in effect, like `org list`. */
function seeOrgList(orgs: string[]): void {
  setOrgRegions(
    orgs.map((slug) => {
      nextOrgId += 1;
      return {
        slug,
        regionUrl: SAAS,
        sourceOrigin: SAAS,
        orgId: String(nextOrgId),
        orgName: slug,
      };
    }),
  );
}

/**
 * A router over the stored accounts whose org lists come from `orgsOf`,
 * keyed by account id. Tokens are `token-of-<account id>`.
 */
function createRouter(
  defaultAccountId: string,
  orgsOf: Record<string, string[]>,
  resolvePin: (pin: StoredAccountPin) => Promise<string> = async (pin) =>
    `token-of-${pin.accountId}`,
  beforeList: (accountId: string) => void = () => {},
) {
  const listed: string[] = [];
  const router = createMcpAccountRouter({
    targetUrl: SAAS,
    defaultPin: { kind: "stored", accountId: defaultAccountId, userId: "1" },
    withCredentialEnv: (fn) => withEnv({ ...process.env }, fn),
    resolvePin,
    cacheOrgList: async (account: StoredAccountRef) => {
      listed.push(account.id);
      beforeList(account.id);
      return await withStoredAccount(account, async () => {
        seeOrgList(orgsOf[account.id] ?? []);
      });
    },
  });
  return { router, listed };
}

describe("createMcpAccountRouter", () => {
  test("lists each account's orgs to route an org no account is known to reach", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    setActiveAccount(a);
    const { router, listed } = createRouter(a, {
      [a]: ["a-org"],
      [b]: ["b-org"],
    });

    await expect(
      router.resolve({ organizationSlug: "b-org" }),
    ).resolves.toMatchObject({ id: b, accessToken: `token-of-${b}` });
    expect(listed.sort()).toEqual([a, b].sort());

    // The fresh lists now route without listing again.
    await expect(
      router.resolve({ organizationSlug: "a-org" }),
    ).resolves.toMatchObject({ id: a });
    expect(listed).toHaveLength(2);
  });

  test("shares one listing per account between overlapping calls", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    setActiveAccount(a);
    const { router, listed } = createRouter(a, {
      [a]: ["a-org"],
      [b]: ["b-org"],
    });

    const resolved = await Promise.all([
      router.resolve({ organizationSlug: "b-org" }),
      router.resolve({ organizationSlug: "b-org" }),
    ]);
    expect(resolved.map((credential) => credential.id)).toEqual([b, b]);
    expect(listed.sort()).toEqual([a, b].sort());
  });

  test("does not list an account with no orgs again on every call", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    setActiveAccount(a);
    const { router, listed } = createRouter(a, {});

    await router.resolve({ organizationSlug: "missing" });
    await router.resolve({ organizationSlug: "missing" });
    expect(listed.sort()).toEqual([a, b].sort());
  });

  test("lists the startup account's orgs before keeping it for an org another account knows", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    seeOrgList(["b-org"]);
    setActiveAccount(a);
    const { router, listed } = createRouter(a, { [a]: ["a-org"] });

    await expect(
      router.resolve({ organizationSlug: "b-org" }),
    ).resolves.toMatchObject({ id: b });
    expect(listed).toEqual([a]);
  });

  test("routes to a known owner when listing the startup account fails", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    seeOrgList(["b-org"]);
    setActiveAccount(a);
    const { router, listed } = createRouter(a, {}, undefined, (id) => {
      if (id === a) {
        throw new Error("network down");
      }
    });

    await expect(
      router.resolve({ organizationSlug: "b-org" }),
    ).resolves.toMatchObject({ id: b });
    expect(listed).toEqual([a]);
  });

  test("lists the other accounts when the startup account has no orgs", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const b = login("b-token", "2");
    setActiveAccount(a);
    const { router, listed } = createRouter(a, { [b]: ["b-org"] });

    await expect(
      router.resolve({ organizationSlug: "b-org" }),
    ).resolves.toMatchObject({ id: b });
    expect(listed.sort()).toEqual([a, b].sort());
  });

  test("keeps the startup account for an org both accounts know", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    seeOrgList(["shared"]);
    login("b-token", "2");
    seeOrgList(["shared"]);
    setActiveAccount(a);
    const { router, listed } = createRouter(a, {});

    await expect(
      router.resolve({ organizationSlug: "shared" }),
    ).resolves.toMatchObject({ id: a });
    expect(listed).toEqual([]);
  });

  test("skips routing with only the startup account", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const { router, listed } = createRouter(a, {});

    await expect(
      router.resolve({ organizationSlug: "any-org" }),
    ).resolves.toMatchObject({ id: a });
    expect(listed).toEqual([]);
  });

  test("reports a CLI auth failure as a configuration error", async () => {
    await clearAuth();
    const a = login("a-token", "1");
    const { router } = createRouter(a, {}, async () => {
      throw new AuthError("expired", "Log in again.", { skipAutoAuth: true });
    });

    const result = router.resolve({ organizationSlug: null });
    await expect(result).rejects.toBeInstanceOf(ConfigurationError);
    await expect(result).rejects.toThrow("Log in again.");
  });
});
