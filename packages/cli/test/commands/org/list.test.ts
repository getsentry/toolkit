/**
 * `sentry org list` across stored accounts, against a real test database
 * and a fetch mock that answers per server and per token.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/org/list.js";
import {
  getActiveAccountId,
  getAuthToken,
  selectAccountForOrg,
  setActiveAccount,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { resetAccountScopes } from "../../../src/lib/db/account-scope.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import { AuthError, ResolutionError } from "../../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

type ListFunc = (
  this: unknown,
  flags: {
    limit: number;
    json: boolean;
    fresh: boolean;
    account?: string;
  },
  filter?: string,
) => Promise<void>;

useTestConfigDir("org-list-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const SAAS = "https://sentry.io";
const ACME = "https://sentry.acme.com";

type Org = { id: string; slug: string; name: string; regionUrl: string };

/** Orgs each token can see; a token missing here gets a 401. */
let orgsByToken: Record<string, Org[]>;
/** `<origin> <token>` for every org-list request, to check token routing. */
let requests: string[];
let originalFetch: typeof globalThis.fetch;

function org(slug: string, regionUrl = SAAS, id = slug): Org {
  return { id, slug, name: `${slug} name`, regionUrl };
}

beforeEach(() => {
  orgsByToken = {};
  requests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (!url.pathname.startsWith("/api/0/organizations/")) {
      return Response.json({ detail: "Not found" }, { status: 404 });
    }
    requests.push(`${url.origin} ${token}`);
    const orgs = token ? orgsByToken[token] : undefined;
    if (!orgs) {
      return Response.json({ detail: "Invalid token" }, { status: 401 });
    }
    return Response.json(
      orgs.map((o) => ({
        id: o.id,
        slug: o.slug,
        name: o.name,
        links: { organizationUrl: o.regionUrl, regionUrl: o.regionUrl },
      })),
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function addAccount(token: string, host: string, email: string): string {
  const id = setAuthToken(token, undefined, undefined, {
    host,
    newAccount: true,
  });
  setUserInfo({ userId: email, email });
  return id;
}

function createContext() {
  const chunks: string[] = [];
  return {
    context: {
      stdout: { write: vi.fn((s: string) => chunks.push(s)) },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    getOutput: () => chunks.join(""),
  };
}

async function runList(
  flags: { account?: string; limit?: number } = {},
  filter?: string,
): Promise<Record<string, unknown>[]> {
  const func = (await listCommand.loader()) as unknown as ListFunc;
  const { context, getOutput } = createContext();
  await func.call(
    context,
    {
      limit: flags.limit ?? 100,
      json: true,
      fresh: true,
      ...(flags.account ? { account: flags.account } : {}),
    },
    filter,
  );
  return JSON.parse(getOutput()) as Record<string, unknown>[];
}

async function runListHuman(filter?: string): Promise<string> {
  const func = (await listCommand.loader()) as unknown as ListFunc;
  const { context, getOutput } = createContext();
  await func.call(context, { limit: 100, json: false, fresh: true }, filter);
  return getOutput();
}

function slugsWithAccount(entries: Record<string, unknown>[]): string[][] {
  return entries.map((e) => [
    e.slug as string,
    ((e.account as { email?: string } | undefined)?.email ?? "") as string,
  ]);
}

describe("org list with one stored account", () => {
  test("lists that account's orgs without account info", async () => {
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha"), org("beta")];

    const entries = await runList();

    expect(entries.map((e) => e.slug)).toEqual(["alpha", "beta"]);
    expect(entries.every((e) => e.account === undefined)).toBe(true);
    expect(requests).toEqual([`${SAAS} saas-token`]);
  });
});

describe("org list across stored accounts", () => {
  test("lists every account's orgs, each fetched with its own token on its own server", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    const entries = await runList();

    expect(slugsWithAccount(entries)).toEqual([
      ["alpha", "jane@example.com"],
      ["acme-internal", "jane@acme.com"],
    ]);
    expect(entries[1]?.account).toEqual({
      id: expect.any(String),
      host: ACME,
      email: "jane@acme.com",
      label: "jane@acme.com on sentry.acme.com",
      selector: "jane@acme.com:sentry.acme.com",
    });
    expect(requests.sort()).toEqual(
      [`${SAAS} saas-token`, `${ACME} acme-token`].sort(),
    );
  });

  test("caches each account's orgs, so later commands route to the right account", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    await runList();
    resetAccountScopes();
    selectAccountForOrg("acme-internal");

    expect(getAuthToken()).toBe("acme-token");
  });

  test("never changes the stored active account", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    const saas = addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    await runList();

    expect(getActiveAccountId()).toBe(saas);
  });

  test("an org reachable from two accounts on the same server is listed once, under the active account", async () => {
    const work = addAccount("work-token", SAAS, "jane@work.com");
    addAccount("personal-token", SAAS, "jane@example.com");
    setActiveAccount(work);
    orgsByToken["work-token"] = [org("shared"), org("work-only")];
    orgsByToken["personal-token"] = [org("shared"), org("personal-only")];

    const entries = await runList();

    expect(slugsWithAccount(entries)).toEqual([
      ["shared", "jane@work.com"],
      ["work-only", "jane@work.com"],
      ["personal-only", "jane@example.com"],
    ]);
  });

  test("the same slug on different servers is listed for each", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("acme")];
    orgsByToken["acme-token"] = [org("acme", ACME)];

    const entries = await runList();

    expect(slugsWithAccount(entries)).toEqual([
      ["acme", "jane@example.com"],
      ["acme", "jane@acme.com"],
    ]);
  });

  test("an account whose login is rejected is skipped; the others are still listed", async () => {
    addAccount("revoked-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];

    const entries = await runList();

    expect(slugsWithAccount(entries)).toEqual([["alpha", "jane@example.com"]]);
    // Only the rejected account's credentials are touched.
    expect(getAuthToken()).toBe("saas-token");
  });

  test("fails when every account fails", async () => {
    addAccount("revoked-a", ACME, "jane@acme.com");
    addAccount("revoked-b", SAAS, "jane@example.com");

    await expect(runList()).rejects.toThrow();
  });

  test("an explicit server limits the list to accounts on it", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];
    process.env.SENTRY_URL = ACME;

    const entries = await runList();

    expect(entries.map((e) => e.slug)).toEqual(["acme-internal"]);
    expect(requests).toEqual([`${ACME} acme-token`]);
  });

  test("skips accounts that are logged out", async () => {
    const acme = addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(acme);
    orgsByToken["saas-token"] = [org("alpha")];

    const entries = await runList();

    expect(entries.map((e) => e.slug)).toEqual(["alpha"]);
    expect(requests).toEqual([`${SAAS} saas-token`]);
  });

  test("lists the one usable account when the active login is logged out", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    const saas = addAccount("saas-token", SAAS, "jane@example.com");
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(saas);
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    const entries = await runList();

    expect(entries.map((e) => e.slug)).toEqual(["acme-internal"]);
    expect(requests).toEqual([`${ACME} acme-token`]);
    expect(getActiveAccountId()).toBe(saas);
  });

  test("--limit applies to the merged list", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha"), org("beta")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    const entries = await runList({ limit: 2 });

    expect(entries.map((e) => e.slug)).toEqual(["alpha", "beta"]);
  });

  test("human output adds an ACCOUNT column", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    const out = await runListHuman();

    expect(out).toContain("ACCOUNT");
    // The notation --account and `sentry auth login` accept.
    expect(out).toContain("jane@acme.com:sentry.acme.com");
    expect(out).toContain("jane@example.com:sentry.io");
    expect(out).not.toContain("REGION");
  });
});

describe("org list filter", () => {
  beforeEach(() => {
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [
      { id: "1", slug: "acme-prod", name: "Acme Production", regionUrl: SAAS },
      { id: "2", slug: "acme-dev", name: "Acme Dev", regionUrl: SAAS },
      { id: "3", slug: "globex", name: "Globex Corp", regionUrl: SAAS },
    ];
  });

  test("plain text matches anywhere in the slug or name, ignoring case", async () => {
    expect((await runList({}, "PROD")).map((e) => e.slug)).toEqual([
      "acme-prod",
    ]);
    expect((await runList({}, "corp")).map((e) => e.slug)).toEqual(["globex"]);
  });

  test("a glob must match the whole slug or name", async () => {
    expect((await runList({}, "acme-*")).map((e) => e.slug)).toEqual([
      "acme-prod",
      "acme-dev",
    ]);
    expect((await runList({}, "acme")).map((e) => e.slug)).toEqual([
      "acme-prod",
      "acme-dev",
    ]);
    expect(await runList({}, "acme?")).toEqual([]);
  });

  test("--limit applies after filtering", async () => {
    expect((await runList({ limit: 1 }, "acme")).map((e) => e.slug)).toEqual([
      "acme-prod",
    ]);
  });

  test("no match says how many organizations were filtered out", async () => {
    const out = await runListHuman("initech");

    expect(out).toContain("No organizations found.");
    expect(out).toContain("None of your 3 organizations match 'initech'");
  });
});

describe("org list --account", () => {
  test("lists only that account's orgs, with its own token", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    const entries = await runList({ account: "jane@acme.com" });

    expect(entries.map((e) => e.slug)).toEqual(["acme-internal"]);
    expect(entries[0]?.account).toBeUndefined();
    expect(requests).toEqual([`${ACME} acme-token`]);
  });

  test("uses the account's own token even when an env token is forced", async () => {
    addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    process.env.SENTRY_FORCE_ENV_TOKEN = "1";
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];
    orgsByToken["env-token"] = [org("env-org")];

    const entries = await runList({ account: "jane@acme.com" });

    expect(entries.map((e) => e.slug)).toEqual(["acme-internal"]);
    expect(requests).toEqual([`${ACME} acme-token`]);
  });

  test("<email>:<server> picks one of the same email's accounts", async () => {
    addAccount("acme-token", ACME, "jane@example.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    orgsByToken["saas-token"] = [org("alpha")];
    orgsByToken["acme-token"] = [org("acme-internal", ACME)];

    await expect(runList({ account: "jane@example.com" })).rejects.toThrow(
      ResolutionError,
    );
    const entries = await runList({
      account: "jane@example.com:sentry.acme.com",
    });

    expect(entries.map((e) => e.slug)).toEqual(["acme-internal"]);
    expect(requests).toEqual([`${ACME} acme-token`]);
  });

  test("an unknown account is an error", async () => {
    addAccount("saas-token", SAAS, "jane@example.com");

    await expect(runList({ account: "nobody@nowhere.dev" })).rejects.toThrow(
      ResolutionError,
    );
  });

  test("a logged-out account is an auth error naming how to log back in", async () => {
    const acme = addAccount("acme-token", ACME, "jane@acme.com");
    addAccount("saas-token", SAAS, "jane@example.com");
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(acme);

    const error = await runList({ account: "jane@acme.com" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AuthError);
    // `<email>:<server>` logs in to that account's server.
    expect((error as AuthError).message).toContain(
      "sentry auth login jane@acme.com:sentry.acme.com",
    );
    expect(requests).toEqual([]);
  });
});
