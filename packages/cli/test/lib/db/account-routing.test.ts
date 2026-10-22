/**
 * Automatic account selection tests.
 *
 * With several stored logins, commands use the account that matches what
 * they target — the configured server or the organization — without
 * `sentry auth switch`, and never change the stored active account.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { markPersistedDefaultUrl } from "../../../src/lib/constants.js";
import {
  getActiveAccountId,
  getAuthToken,
  getEffectiveAccountRow,
  getEnvAccount,
  getReauthorizationAccountId,
  refreshToken,
  resetAccountSelection,
  selectAccountForOrg,
  setActiveAccount,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { hashIdentity } from "../../../src/lib/db/identity-hash.js";
import { closeDatabase, getDatabase } from "../../../src/lib/db/index.js";
import { getEnvTokenHost } from "../../../src/lib/env-token-host.js";
import { AuthError } from "../../../src/lib/errors.js";
import { assertReauthorizingSameUser } from "../../../src/lib/interactive-login.js";
import {
  ORG_CACHE_TTL_MS,
  setOrgRegion,
  setOrgRegions,
} from "../../../src/lib/db/regions.js";
import { CURRENT_SCHEMA_VERSION } from "../../../src/lib/db/schema.js";
import { getUserInfo, setUserInfo } from "../../../src/lib/db/user.js";
import { resolveOrgRegion } from "../../../src/lib/region.js";
import { applySentryUrlContext } from "../../../src/lib/sentry-url-parser.js";
import {
  applySentryCliRcEnvShim,
  assertRcUrlTrusted,
  clearSentryCliRcCache,
} from "../../../src/lib/sentryclirc.js";
import {
  mintSntrysToken,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

useTestConfigDir("account-routing-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const SAAS = "https://sentry.io";
const ACME = "https://sentry.acme.com";
/** An org auth token issued by ACME: its claim names its server. */
const ACME_ORG_TOKEN = mintSntrysToken({ iat: 1, url: ACME, org: "ci" });

function login(token: string, host: string, userId: string): string {
  const id = setAuthToken(token, undefined, undefined, {
    host,
    newAccount: true,
  });
  setUserInfo({ userId, email: `${userId}@example.com` });
  return id;
}

/** Cache `org` (looked up on `host`) as seen by the account in effect. */
function seeOrg(org: string, host: string, region = host): void {
  setOrgRegion(org, region, host);
}

/** An account's stored access token; `undefined` once the account is gone. */
function tokenOf(accountId: string): string | null | undefined {
  const row = getDatabase()
    .query("SELECT token FROM accounts WHERE account_id = ?")
    .get(accountId) as { token: string | null } | null;
  return row?.token;
}

let nextOrgId = 1000;

/** Cache a full org list for the account in effect, like `org list`. */
function seeOrgList(host: string, orgs: string[]): void {
  setOrgRegions(
    orgs.map((slug) => {
      nextOrgId += 1;
      return {
        slug,
        regionUrl: host,
        sourceOrigin: host,
        orgId: String(nextOrgId),
        orgName: slug,
      };
    }),
  );
}

describe("server-based selection", () => {
  test("uses the stored account on the configured server", () => {
    login("acme-token", ACME, "acme-user");
    const saas = login("saas-token", SAAS, "saas-user");

    process.env.SENTRY_URL = ACME;

    expect(getAuthToken()).toBe("acme-token");
    expect(getUserInfo()?.userId).toBe("acme-user");
    expect(getActiveAccountId()).toBe(saas);
  });

  test("keeps the active account when no stored account is on that server", () => {
    login("saas-token", SAAS, "saas-user");

    process.env.SENTRY_URL = "https://sentry.other.com";

    expect(getAuthToken()).toBe("saas-token");
  });

  test("treats every sentry.io subdomain as the SaaS server", () => {
    login("saas-token", SAAS, "saas-user");
    login("acme-token", ACME, "acme-user");

    process.env.SENTRY_URL = "https://us.sentry.io";

    expect(getAuthToken()).toBe("saas-token");
  });
});

describe("organization-based selection", () => {
  test("uses the account that knows the org without switching", () => {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const personal = login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);

    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("work-token");
    expect(getActiveAccountId()).toBe(personal);
    expect(work).not.toBe(personal);
  });

  test("keeps an account whose org list isn't cached, e.g. right after a switch", () => {
    login("work-token", SAAS, "work");
    seeOrg("shared-org", SAAS);
    login("personal-token", SAAS, "personal");

    selectAccountForOrg("shared-org");

    expect(getAuthToken()).toBe("personal-token");
  });

  test("keeps an account whose cached org list has expired", () => {
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const personal = login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    getDatabase()
      .query("UPDATE org_regions SET updated_at = ? WHERE account_id = ?")
      .run(Date.now() - ORG_CACHE_TTL_MS - 1000, personal);

    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("personal-token");
  });

  test("matches DSN-style numeric org ids", () => {
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    getDatabase()
      .query("UPDATE org_regions SET org_id = '42' WHERE org_slug = 'work-org'")
      .run();
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);

    selectAccountForOrg("o42", "42");

    expect(getAuthToken()).toBe("work-token");
  });

  test("matches a DSN org id against an account that only resolved the slug", () => {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    const db = getDatabase();
    // Only an org list (here: an env-token's, not tied to an account) knows
    // that org 42 is `work-org`; the work account resolved it by slug.
    db.query(
      `INSERT INTO org_regions (org_slug, org_id, region_url, credential_identity, account_id, source_origin, response_origin, updated_at)
       SELECT org_slug, '42', region_url, 'env-token-identity', NULL, source_origin, response_origin, updated_at
       FROM org_regions WHERE account_id = ? AND org_slug = 'work-org'`,
    ).run(work);

    selectAccountForOrg("o42", "42");

    expect(getAuthToken()).toBe("work-token");
  });

  test("keeps the current account when it knows the org too", () => {
    login("work-token", SAAS, "work");
    seeOrg("shared-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrg("shared-org", SAAS);

    selectAccountForOrg("shared-org");

    expect(getAuthToken()).toBe("personal-token");
  });

  test("leaves unknown orgs on the active account", () => {
    login("work-token", SAAS, "work");
    login("personal-token", SAAS, "personal");

    selectAccountForOrg("never-seen");

    expect(getAuthToken()).toBe("personal-token");
  });

  test("never mixes accounts within one invocation", () => {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const other = login("other-token", SAAS, "other");
    seeOrg("other-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);

    selectAccountForOrg("work-org");
    selectAccountForOrg("other-org");

    expect(getAuthToken()).toBe("work-token");
    expect(other).not.toBe(work);
  });

  test("an explicit server limits candidates to accounts on it", () => {
    login("acme-token", ACME, "acme");
    seeOrg("acme-org", ACME);
    login("saas-token", SAAS, "saas");
    seeOrgList(SAAS, ["saas-org"]);

    process.env.SENTRY_HOST = SAAS;
    selectAccountForOrg("acme-org");

    expect(getAuthToken()).toBe("saas-token");
    expect(process.env.SENTRY_HOST).toBe(SAAS);
  });

  test("the persisted default URL yields to the org's account server", () => {
    login("saas-token", SAAS, "saas");
    seeOrg("saas-org", SAAS);
    login("acme-token", ACME, "acme");
    seeOrgList(ACME, ["acme-org"]);
    process.env.SENTRY_URL = ACME;
    markPersistedDefaultUrl(ACME);

    selectAccountForOrg("saas-org");

    expect(getAuthToken()).toBe("saas-token");
    expect(process.env.SENTRY_URL).toBe(SAAS);
  });

  test("a self-hosted org's account brings its server along", () => {
    login("acme-token", ACME, "acme");
    seeOrg("acme-org", ACME);
    login("saas-token", SAAS, "saas");
    seeOrgList(SAAS, ["saas-org"]);

    selectAccountForOrg("acme-org");

    expect(getAuthToken()).toBe("acme-token");
    expect(process.env.SENTRY_URL).toBe(ACME);
  });

  test("a forced env token is never overridden", () => {
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_FORCE_ENV_TOKEN = "1";

    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("env-token");
  });

  test.each(["0", "false", "no", "off"])(
    "SENTRY_FORCE_ENV_TOKEN=%s doesn't force the env token",
    (value) => {
      login("work-token", SAAS, "work");
      process.env.SENTRY_AUTH_TOKEN = "env-token";
      process.env.SENTRY_FORCE_ENV_TOKEN = value;

      expect(getAuthToken()).toBe("work-token");
    },
  );

  test("skips accounts whose credentials were invalidated", () => {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(work);

    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("personal-token");
  });

  test("moves off an account in effect whose credentials were invalidated", () => {
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const personal = login("personal-token", SAAS, "personal");
    // Invalidated: token cleared and its org cache dropped, still active.
    const db = getDatabase();
    db.query("UPDATE accounts SET token = NULL WHERE account_id = ?").run(
      personal,
    );
    db.query("DELETE FROM org_regions WHERE account_id = ?").run(personal);

    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("work-token");
    expect(getActiveAccountId()).toBe(personal);
  });

  test("skips expired accounts that cannot refresh", () => {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    getDatabase()
      .query(
        "UPDATE accounts SET expires_at = ?, refresh_token = NULL WHERE account_id = ?",
      )
      .run(Date.now() - 1000, work);

    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("personal-token");
  });

  test("picks the most recently used account when several know the org", () => {
    // Created first, so plain insertion order would pick it.
    const stale = login("stale-token", SAAS, "stale");
    seeOrg("shared-org", SAAS);
    const recent = login("recent-token", SAAS, "recent");
    seeOrg("shared-org", SAAS);
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    const setLastUsed = getDatabase().query(
      "UPDATE accounts SET last_used_at = ? WHERE account_id = ?",
    );
    setLastUsed.run(1000, stale);
    setLastUsed.run(2000, recent);

    selectAccountForOrg("shared-org");

    expect(getAuthToken()).toBe("recent-token");
  });

  test("an account the configured server picked yields to one on it that knows the org", () => {
    const peer = login("peer-token", ACME, "peer");
    seeOrg("acme-org", ACME);
    // More recently used on ACME, but has never seen the org.
    const other = login("other-token", ACME, "other");
    const saas = login("saas-token", SAAS, "saas");
    // Back-to-back logins can share a millisecond; pin the recency so the
    // configured server deterministically picks `other`.
    const setLastUsed = getDatabase().query(
      "UPDATE accounts SET last_used_at = ? WHERE account_id = ?",
    );
    setLastUsed.run(1000, peer);
    setLastUsed.run(2000, other);
    process.env.SENTRY_URL = ACME;
    expect(getAuthToken()).toBe("other-token");

    selectAccountForOrg("acme-org");

    expect(getAuthToken()).toBe("peer-token");
    expect(getEffectiveAccountRow()?.account_id).toBe(peer);
    expect(getActiveAccountId()).toBe(saas);
  });

  test("resolveOrgRegion routes through the org's account", async () => {
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS, "https://de.sentry.io");
    const personal = login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);

    await expect(resolveOrgRegion("work-org")).resolves.toBe(
      "https://de.sentry.io",
    );
    expect(getAuthToken()).toBe("work-token");
    expect(getActiveAccountId()).toBe(personal);
  });

  test("resolveOrgRegion routes a bare numeric DSN org id through its account", async () => {
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS, "https://de.sentry.io");
    getDatabase()
      .query("UPDATE org_regions SET org_id = '42' WHERE org_slug = 'work-org'")
      .run();
    const personal = login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);

    // DSN resolution can hand over the id without its `o` prefix. The
    // region lookup itself isn't under test: keep it off the network.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    try {
      await resolveOrgRegion("42").catch(() => undefined);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(getAuthToken()).toBe("work-token");
    expect(getActiveAccountId()).toBe(personal);
  });

  test("account switch keeps the org mapping for each account", () => {
    const work = login("work-token", SAAS, "work");
    seeOrgList(SAAS, ["work-org"]);
    const personal = login("personal-token", SAAS, "personal");
    seeOrg("personal-org", SAAS);

    setActiveAccount(work);
    selectAccountForOrg("personal-org");

    expect(getAuthToken()).toBe("personal-token");
    expect(personal).not.toBe(work);
  });
});

describe("the env token as an account", () => {
  // The env token's server is snapshotted once per env: start each case
  // from a fresh boot.
  beforeEach(resetHostScopingState);
  afterEach(resetHostScopingState);

  /** Cache `org` on `host` as seen by the env token `token`. */
  function envSeesOrg(token: string, org: string, host: string): void {
    setOrgRegion(org, host, host, host, hashIdentity("env", token));
  }

  test("is an account on SaaS when no server is configured", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";

    expect(getEnvAccount()).toEqual({
      envVar: "SENTRY_AUTH_TOKEN",
      host: SAAS,
      identity: hashIdentity("env", "env-token"),
    });
  });

  test("is an account on its org auth token's server", () => {
    process.env.SENTRY_TOKEN = ACME_ORG_TOKEN;
    process.env.SENTRY_URL = ACME;

    expect(getEnvAccount()?.host).toBe(ACME);
    expect(getEnvAccount()?.envVar).toBe("SENTRY_TOKEN");
  });

  test("is no account on a self-hosted server only the env names", () => {
    // In layered CI, SENTRY_URL can be injected without access to the
    // token: it alone must not make the token an account sent there.
    process.env.SENTRY_TOKEN = "env-token";
    process.env.SENTRY_URL = ACME;

    expect(getEnvAccount()).toBeUndefined();
  });

  test("is an account on a SaaS server named by the env", () => {
    process.env.SENTRY_TOKEN = "env-token";
    process.env.SENTRY_URL = "https://us.sentry.io";

    expect(getEnvAccount()?.host).toBe("https://us.sentry.io");
  });

  test("is no account when the token appeared after boot, e.g. from .sentryclirc", () => {
    login("saas-token", SAAS, "saas");
    // The boot snapshot saw no env token.
    getEnvTokenHost();
    process.env.SENTRY_AUTH_TOKEN = "rc-token";
    envSeesOrg("rc-token", "rc-org", SAAS);

    selectAccountForOrg("rc-org");

    expect(getEnvAccount()).toBeUndefined();
    expect(getAuthToken()).toBe("saas-token");
  });

  test("wins over the active account for an org both know", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    const saas = login("saas-token", SAAS, "saas");
    seeOrgList(SAAS, ["shared"]);
    envSeesOrg("env-token", "shared", SAAS);

    selectAccountForOrg("shared");

    expect(getAuthToken()).toBe("env-token");
    expect(getEffectiveAccountRow()).toBeUndefined();
    expect(getActiveAccountId()).toBe(saas);
  });

  test("wins over another stored account that knows the org", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("work-token", SAAS, "work");
    seeOrg("env-org", SAAS);
    login("personal-token", SAAS, "personal");
    envSeesOrg("env-token", "env-org", SAAS);

    selectAccountForOrg("env-org");

    expect(getAuthToken()).toBe("env-token");
  });

  test("matches DSN-style numeric org ids", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("saas-token", SAAS, "saas");
    setOrgRegions([
      {
        slug: "env-org",
        regionUrl: SAAS,
        sourceOrigin: SAAS,
        identity: hashIdentity("env", "env-token"),
        orgId: "4242",
        orgName: "Env Org",
      },
    ]);

    selectAccountForOrg("o4242", "4242");

    expect(getAuthToken()).toBe("env-token");
  });

  test("ignores orgs it saw while scoped to another server", () => {
    process.env.SENTRY_AUTH_TOKEN = ACME_ORG_TOKEN;
    process.env.SENTRY_URL = ACME;
    login("acme-token", ACME, "acme");
    seeOrg("shared", ACME);
    // Cached under the same identity on SaaS: ACME's `shared` is a
    // different org.
    envSeesOrg(ACME_ORG_TOKEN, "shared", SAAS);

    selectAccountForOrg("shared");

    expect(getEnvAccount()?.host).toBe(ACME);
    expect(getAuthToken()).toBe("acme-token");
  });

  test("matches orgs it saw on a SaaS region of its SaaS server", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("saas-token", SAAS, "saas");
    envSeesOrg("env-token", "eu-org", "https://de.sentry.io");

    selectAccountForOrg("eu-org");

    expect(getAuthToken()).toBe("env-token");
  });

  test("ignores orgs it saw on look-alike SaaS servers", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("saas-token", SAAS, "saas");
    envSeesOrg("env-token", "lookalike", "https://sentry.io.example.com");
    envSeesOrg("env-token", "lookalike", "https://notsentry.io");
    envSeesOrg("env-token", "lookalike", "http://us.sentry.io");

    selectAccountForOrg("lookalike");

    expect(getAuthToken()).toBe("saas-token");
  });

  test("leaves orgs it doesn't know to the stored login", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("saas-token", SAAS, "saas");
    envSeesOrg("env-token", "env-org", SAAS);

    selectAccountForOrg("other-org");

    expect(getAuthToken()).toBe("saas-token");
  });

  test("an explicit server set after boot on another server rules it out", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    // Boot: the env token is scoped to SaaS before `--url` or
    // `.sentryclirc` point the invocation at ACME.
    getEnvTokenHost();
    login("acme-token", ACME, "acme");
    seeOrg("shared", ACME);
    envSeesOrg("env-token", "shared", SAAS);
    process.env.SENTRY_URL = ACME;

    selectAccountForOrg("shared");

    expect(getAuthToken()).toBe("acme-token");
  });

  test("brings its server along when the persisted default URL is another", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    // Boot: the persisted default URL is applied after the snapshot.
    getEnvTokenHost();
    login("acme-token", ACME, "acme");
    envSeesOrg("env-token", "env-org", SAAS);
    process.env.SENTRY_URL = ACME;
    markPersistedDefaultUrl(ACME);

    selectAccountForOrg("env-org");

    expect(process.env.SENTRY_URL).toBe(SAAS);
    expect(getAuthToken()).toBe("env-token");
  });

  test("never mixes with a stored account within one invocation", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    login("personal-token", SAAS, "personal");
    envSeesOrg("env-token", "env-org", SAAS);

    selectAccountForOrg("env-org");
    selectAccountForOrg("work-org");

    expect(getAuthToken()).toBe("env-token");
  });

  test("a login during the invocation takes over from it", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("saas-token", SAAS, "saas");
    envSeesOrg("env-token", "env-org", SAAS);
    selectAccountForOrg("env-org");

    setAuthToken("fresh-token", undefined, undefined, { host: SAAS });

    expect(getAuthToken()).toBe("fresh-token");
  });

  test("serves its configured server when no stored account is on it", () => {
    process.env.SENTRY_AUTH_TOKEN = ACME_ORG_TOKEN;
    process.env.SENTRY_URL = ACME;
    login("saas-token", SAAS, "saas");

    expect(getAuthToken()).toBe(ACME_ORG_TOKEN);
  });

  test("never serves a self-hosted server only the env names", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_URL = ACME;
    login("saas-token", SAAS, "saas");

    expect(getAuthToken()).not.toBe("env-token");
  });

  test("yields its configured server to a stored account on it", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_URL = ACME;
    login("acme-token", ACME, "acme");
    login("saas-token", SAAS, "saas");

    expect(getAuthToken()).toBe("acme-token");
  });

  test("still yields to the active stored login by default", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    login("saas-token", SAAS, "saas");

    expect(getAuthToken()).toBe("saas-token");
  });
});

describe("logging in after an org picked the account", () => {
  function pinWorkAccount(): { work: string; personal: string } {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const personal = login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    selectAccountForOrg("work-org");
    expect(getAuthToken()).toBe("work-token");
    return { work, personal };
  }

  test("re-authenticating replaces the active account, not the picked one", () => {
    const { work, personal } = pinWorkAccount();

    // Automatic login / `--force`: replace the active account in place.
    setAuthToken("personal-new", undefined, undefined, { host: SAAS });
    setUserInfo({ userId: "personal", email: "personal@example.com" });

    expect(tokenOf(work)).toBe("work-token");
    expect(tokenOf(personal)).toBe("personal-new");
    expect(getAuthToken()).toBe("personal-new");
    expect(getUserInfo()?.userId).toBe("personal");
  });

  test("re-authenticating replaces the stored login for the login's server", () => {
    const acme = login("acme-token", ACME, "acme");
    const saas = login("saas-token", SAAS, "saas");

    // `sentry auth login --force --url <acme>` while SaaS is active.
    const replaced = setAuthToken("replaced-token", undefined, undefined, {
      host: ACME,
    });

    expect(replaced).toBe(acme);
    expect(tokenOf(acme)).toBe("replaced-token");
    expect(tokenOf(saas)).toBe("saas-token");
    expect(getActiveAccountId()).toBe(acme);
  });

  test("re-authenticating to a server with no stored login adds an account", () => {
    const saas = login("saas-token", SAAS, "saas");

    const added = setAuthToken("acme-token", undefined, undefined, {
      host: ACME,
    });

    expect(added).not.toBe(saas);
    expect(tokenOf(saas)).toBe("saas-token");
    expect(getActiveAccountId()).toBe(added);
  });

  test("a configured server never redirects re-authentication to its account", () => {
    const acme = login("acme-token", ACME, "acme");
    const saas = login("saas-token", SAAS, "saas");
    process.env.SENTRY_URL = ACME;
    expect(getAuthToken()).toBe("acme-token");

    // A SaaS login replaces the SaaS account, whatever SENTRY_URL says.
    setAuthToken("replaced-token", undefined, undefined, { host: SAAS });

    expect(tokenOf(acme)).toBe("acme-token");
    expect(tokenOf(saas)).toBe("replaced-token");
  });

  test("adding an account records its user on the new account", () => {
    const { work } = pinWorkAccount();

    const added = login("new-token", SAAS, "work");

    expect(getActiveAccountId()).toBe(added);
    expect(getAuthToken()).toBe("new-token");
    // Same user: the new login replaces the old work account.
    expect(tokenOf(work)).toBeUndefined();
  });
});

describe("re-authorizing the account an org picked", () => {
  function pinWorkAccount(): { work: string; personal: string } {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const personal = login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    selectAccountForOrg("work-org");
    expect(getAuthToken()).toBe("work-token");
    return { work, personal };
  }

  test("targets the picked account, which the retry then uses with the new grant", () => {
    const { work, personal } = pinWorkAccount();
    expect(getReauthorizationAccountId()).toBe(work);

    // Scope recovery: the new grant replaces the picked account in place.
    setAuthToken("work-new", undefined, undefined, {
      host: SAAS,
      accountId: work,
    });
    setUserInfo({ userId: "work", email: "work@example.com" });

    expect(tokenOf(work)).toBe("work-new");
    expect(tokenOf(personal)).toBe("personal-token");
    expect(getActiveAccountId()).toBe(personal);
    expect(getAuthToken()).toBe("work-new");

    // The retried command resolves the org again and gets the new grant.
    resetAccountSelection();
    selectAccountForOrg("work-org");
    expect(getAuthToken()).toBe("work-new");
  });

  test("only accepts a login approved as the picked account's user", () => {
    const { work } = pinWorkAccount();

    expect(() =>
      assertReauthorizingSameUser(work, { id: "work", email: null }),
    ).not.toThrow();
    // Signed in to the browser as the other user: nothing may be stored.
    expect(() =>
      assertReauthorizingSameUser(work, {
        id: "personal",
        email: "personal@example.com",
      }),
    ).toThrow(/not work@example.com/);
    expect(() => assertReauthorizingSameUser(work, undefined)).toThrow(
      /Could not confirm/,
    );
  });

  test("is not needed while the active account is in effect", () => {
    login("saas-token", SAAS, "saas");

    expect(getReauthorizationAccountId()).toBeUndefined();
  });

  test("refuses an account on another server and saves nothing", () => {
    const acme = login("acme-token", ACME, "acme");
    const saas = login("saas-token", SAAS, "saas");

    expect(() =>
      setAuthToken("new-token", undefined, undefined, {
        host: SAAS,
        accountId: acme,
      }),
    ).toThrow(AuthError);
    expect(tokenOf(acme)).toBe("acme-token");
    expect(tokenOf(saas)).toBe("saas-token");
  });
});

describe("credential invalidation", () => {
  test("drops org memberships cached under an earlier identity", async () => {
    login("personal-token", SAAS, "personal");
    seeOrgList(SAAS, ["personal-org"]);
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const db = getDatabase();
    // As if written before a refresh-token rotation.
    db.query(
      "UPDATE org_regions SET credential_identity = 'rotated-away' WHERE account_id = ?",
    ).run(work);
    db.query(
      "UPDATE accounts SET expires_at = ?, refresh_token = NULL WHERE account_id = ?",
    ).run(Date.now() - 1000, work);

    await refreshToken().catch(() => undefined);

    const left = db
      .query("SELECT COUNT(*) AS n FROM org_regions WHERE account_id = ?")
      .get(work) as { n: number };
    expect(left.n).toBe(0);
    expect(tokenOf(work)).toBeNull();
  });
});

describe("pasted Sentry URLs", () => {
  test("a URL for another stored account's server selects it", () => {
    login("acme-token", ACME, "acme");
    login("saas-token", SAAS, "saas");

    applySentryUrlContext(ACME);

    expect(getAuthToken()).toBe("acme-token");
  });

  test("a SaaS URL selects the SaaS account when self-hosted is active", () => {
    login("saas-token", SAAS, "saas");
    login("acme-token", ACME, "acme");
    process.env.SENTRY_URL = ACME;

    applySentryUrlContext("https://acme-org.sentry.io");

    expect(getAuthToken()).toBe("saas-token");
  });

  test("a SaaS URL pins the server so org selection can't switch to a self-hosted account", () => {
    login("acme-token", ACME, "acme");
    // The self-hosted account knows an org whose slug SaaS also uses.
    seeOrg("shared", ACME);
    login("saas-token", SAAS, "saas");
    // SaaS is active, with a fresh org list that doesn't include it yet.
    seeOrgList(SAAS, ["alpha"]);

    applySentryUrlContext("https://shared.sentry.io");
    selectAccountForOrg("shared");

    expect(process.env.SENTRY_URL).toBe(SAAS);
    expect(getAuthToken()).toBe("saas-token");
  });

  test("a SaaS URL pins the server even when the persisted default is already SaaS", () => {
    login("acme-token", ACME, "acme");
    seeOrg("shared", ACME);
    login("saas-token", SAAS, "saas");
    seeOrgList(SAAS, ["alpha"]);
    // `defaults.url` is SaaS and was applied at startup.
    process.env.SENTRY_URL = SAAS;
    markPersistedDefaultUrl(SAAS);

    applySentryUrlContext("https://shared.sentry.io");
    selectAccountForOrg("shared");

    expect(process.env.SENTRY_URL).toBe(SAAS);
    expect(getAuthToken()).toBe("saas-token");
  });

  test("a SaaS URL never routes to a self-hosted account when the SaaS login is logged out", () => {
    login("acme-token", ACME, "acme");
    seeOrg("shared", ACME);
    const saas = login("saas-token", SAAS, "saas");
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(saas);

    applySentryUrlContext("https://shared.sentry.io");
    selectAccountForOrg("shared");

    expect(process.env.SENTRY_URL).toBe(SAAS);
    expect(getAuthToken()).not.toBe("acme-token");
  });

  test("a SaaS URL never routes to a self-hosted account when no SaaS account is stored", () => {
    const OTHER = "https://sentry.other.com";
    login("other-token", OTHER, "other");
    seeOrg("shared", OTHER);
    login("acme-token", ACME, "acme");
    seeOrgList(ACME, ["alpha"]);

    applySentryUrlContext("https://shared.sentry.io");
    selectAccountForOrg("shared");

    // Pinned to SaaS: the self-hosted account that knows the slug is never
    // picked; the active one stays and the SaaS host check refuses it.
    expect(process.env.SENTRY_URL).toBe(SAAS);
    expect(getAuthToken()).toBe("acme-token");
  });

  test("a SaaS URL with a single self-hosted login keeps using that login", () => {
    login("acme-token", ACME, "acme");
    process.env.SENTRY_URL = ACME;

    applySentryUrlContext("https://acme-org.sentry.io");

    expect(process.env.SENTRY_URL).toBeUndefined();
    expect(getAuthToken()).toBe("acme-token");
  });

  test("a SaaS URL never snapshots an env token's host", () => {
    login("saas-token", SAAS, "saas");
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_FORCE_ENV_TOKEN = "1";
    process.env.SENTRY_URL = ACME;

    applySentryUrlContext("https://acme-org.sentry.io");

    // Had the URL handling read the env token's host after clearing the
    // URL, it would be pinned to SaaS; captured now, it is still ACME.
    process.env.SENTRY_URL = ACME;
    expect(getEnvTokenHost()).toBe(ACME);
  });

  test("a URL for a server with no stored account is still refused", () => {
    login("saas-token", SAAS, "saas");

    expect(() => applySentryUrlContext("https://evil.example.com")).toThrow();
  });
});

describe(".sentryclirc URLs", () => {
  async function withRcUrl(url: string, run: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "account-routing-rc-"));
    try {
      writeFileSync(join(dir, ".sentryclirc"), `[defaults]\nurl = ${url}\n`);
      clearSentryCliRcCache();
      await applySentryCliRcEnvShim(dir);
      await run(dir);
    } finally {
      clearSentryCliRcCache();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a logged-out active account on the rc server defers to a usable peer that knows the org", async () => {
    login("peer-token", ACME, "peer");
    seeOrg("acme-org", ACME);
    const active = login("active-token", ACME, "active");
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(active);

    await withRcUrl(ACME, async (dir) => {
      await expect(assertRcUrlTrusted(dir)).resolves.toBeUndefined();
      selectAccountForOrg("acme-org");
      expect(getAuthToken()).toBe("peer-token");
    });
  });

  test("an rc server with no usable stored account is still refused", async () => {
    login("saas-token", SAAS, "saas");

    await withRcUrl("https://evil.example.com", async (dir) => {
      await expect(assertRcUrlTrusted(dir)).rejects.toThrow();
    });
  });
});

describe("schema v19 migration", () => {
  test("tags cached orgs with the account whose credentials wrote them", () => {
    const work = login("work-token", SAAS, "work");
    seeOrg("work-org", SAAS);
    const db = getDatabase();
    db.query("UPDATE org_regions SET account_id = NULL").run();
    db.query("UPDATE schema_version SET version = 18").run();
    closeDatabase();

    const reopened = getDatabase();
    expect(reopened.query("SELECT version FROM schema_version").get()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
    });
    expect(
      reopened
        .query("SELECT account_id FROM org_regions WHERE org_slug = 'work-org'")
        .get(),
    ).toEqual({ account_id: work });
  });
});
