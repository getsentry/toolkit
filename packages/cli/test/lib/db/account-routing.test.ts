/**
 * Automatic account selection tests.
 *
 * With several stored logins, commands use the account that matches what
 * they target — the configured server or the organization — without
 * `sentry auth switch`, and never change the stored active account.
 */

import { describe, expect, test } from "vitest";
import { markPersistedDefaultUrl } from "../../../src/lib/constants.js";
import {
  getActiveAccountId,
  getAuthToken,
  refreshToken,
  selectAccountForOrg,
  setActiveAccount,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { closeDatabase, getDatabase } from "../../../src/lib/db/index.js";
import {
  ORG_CACHE_TTL_MS,
  setOrgRegion,
  setOrgRegions,
} from "../../../src/lib/db/regions.js";
import { CURRENT_SCHEMA_VERSION } from "../../../src/lib/db/schema.js";
import { getUserInfo, setUserInfo } from "../../../src/lib/db/user.js";
import { resolveOrgRegion } from "../../../src/lib/region.js";
import { applySentryUrlContext } from "../../../src/lib/sentry-url-parser.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

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

  test("adding an account records its user on the new account", () => {
    const { work } = pinWorkAccount();

    const added = login("new-token", SAAS, "work");

    expect(getActiveAccountId()).toBe(added);
    expect(getAuthToken()).toBe("new-token");
    // Same user: the new login replaces the old work account.
    expect(tokenOf(work)).toBeUndefined();
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

  test("a URL for a server with no stored account is still refused", () => {
    login("saas-token", SAAS, "saas");

    expect(() => applySentryUrlContext("https://evil.example.com")).toThrow();
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
