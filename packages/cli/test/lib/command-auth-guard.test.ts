/**
 * The command auth guard with several stored accounts: a logged-out active
 * account must not stop a command whose target selects another stored
 * account that can still authenticate.
 */

import { buildApplication, type CommandContext, run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import { buildCommand } from "../../src/lib/command.js";
import {
  getAuthToken,
  selectAccountForOrg,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import { getDatabase } from "../../src/lib/db/index.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import { setUserInfo } from "../../src/lib/db/user.js";
import { buildRouteMap } from "../../src/lib/route-map.js";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("command-auth-guard-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const SAAS = "https://sentry.io";
const ACME = "https://sentry.acme.com";

type TestContext = CommandContext & {
  process: { stdout: { write: (s: string) => boolean } };
  stdout: { write: (s: string) => boolean };
};

function login(token: string, host: string, userId: string): string {
  const id = setAuthToken(token, undefined, undefined, {
    host,
    newAccount: true,
  });
  setUserInfo({ userId, email: `${userId}@example.com` });
  return id;
}

function logOut(accountId: string): void {
  getDatabase()
    .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
    .run(accountId);
}

/** Run an auth-required command that targets `org`; returns the token it used. */
async function runTargeting(org: string): Promise<string | undefined> {
  const seen: (string | undefined)[] = [];
  const command = buildCommand<Record<string, never>, [], TestContext>({
    docs: { brief: "Targets an org" },
    parameters: { flags: {} },
    // oxlint-disable-next-line require-yield -- test command only observes auth state
    async *func() {
      selectAccountForOrg(org);
      seen.push(getAuthToken());
    },
  });
  const app = buildApplication(
    buildRouteMap({ routes: { cmd: command }, docs: { brief: "Test" } }),
    { name: "test" },
  );
  const write = () => true;
  const stdout = { write };
  await run(app, ["cmd"], {
    process: { stdout, stderr: { write } },
    stdout,
  } as unknown as TestContext);
  return seen.length > 0 ? (seen[0] ?? "<none>") : undefined;
}

describe("command auth guard", () => {
  test("a logged-out active account still lets the target select a usable stored account", async () => {
    login("acme-token", ACME, "acme");
    setOrgRegion("acme-internal", ACME, ACME);
    const saas = login("saas-token", SAAS, "saas");
    logOut(saas);

    expect(await runTargeting("acme-internal")).toBe("acme-token");
  });

  test("still stops the command when no stored account can authenticate", async () => {
    const acme = login("acme-token", ACME, "acme");
    setOrgRegion("acme-internal", ACME, ACME);
    logOut(acme);

    expect(await runTargeting("acme-internal")).toBeUndefined();
  });
});
