/** Token commands select an account before inspecting scopes or calling the API. */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand } from "../../../src/commands/token/create.js";
import { deleteCommand } from "../../../src/commands/token/delete.js";
import { listCommand } from "../../../src/commands/token/list.js";
import {
  getActiveAccountId,
  setActiveAccount,
  setAuthToken,
  withStoredAccount,
} from "../../../src/lib/db/auth.js";
import { setOrgRegion, setOrgRegions } from "../../../src/lib/db/regions.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import { OAUTH_SCOPES } from "../../../src/lib/oauth.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

const getConfigDir = useTestConfigDir("token-accounts-", {
  isolateProjectRoot: true,
});
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
]);

const WORK_HOST = "https://work.example.invalid";
const TOKEN_PATH = "/api/0/organizations/work-org/org-auth-tokens/";
const token = {
  id: "7",
  name: "ci",
  scopes: ["org:ci"],
  tokenLastCharacters: "abcd",
  dateCreated: "2026-01-01T00:00:00Z",
  dateLastUsed: null,
};

let activeAccountId: string;
let requests: { method: string; url: string; authorization: string | null }[];

function addAccount(credential: string, host: string): string {
  const id = setAuthToken(credential, undefined, undefined, {
    host,
    newAccount: true,
  });
  setUserInfo({ userId: credential });
  return id;
}

beforeEach(async () => {
  await resetHostScopingState();
  resetAuthenticatedFetch();
  addAccount("work-token", WORK_HOST);
  setOrgRegion("work-org", WORK_HOST, WORK_HOST);
  activeAccountId = addAccount("personal-token", "https://sentry.io");
  setOrgRegions([
    {
      slug: "personal-org",
      regionUrl: "https://us.sentry.io",
      sourceOrigin: "https://sentry.io",
      orgId: "12",
      orgName: "personal-org",
    },
  ]);

  requests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("Authorization"),
    });
    const path = new URL(request.url).pathname;
    if (path === "/api/0/") {
      return Promise.resolve(
        Response.json({
          auth: {
            scopes: [...OAUTH_SCOPES, "org:tokens", "org:ci", "org:write"],
          },
        }),
      );
    }
    if (path === TOKEN_PATH) {
      return Promise.resolve(
        Response.json(
          request.method === "POST"
            ? { ...token, token: "sntrys_synthetic_created_token" }
            : [token],
        ),
      );
    }
    if (path === `${TOKEN_PATH}7/` && request.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      Response.json({ detail: "Not found" }, { status: 404 }),
    );
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetAuthenticatedFetch();
  await resetHostScopingState();
});

async function runCommand(
  command: typeof listCommand,
  target: string,
  name = "list",
): Promise<void> {
  const func = await command.loader();
  await func.call(
    {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      cwd: getConfigDir(),
      commandPrefix: ["sentry", "token", name],
    },
    { json: true, yes: true, force: false, "dry-run": false },
    target,
  );
}

describe("token command accounts", () => {
  test.each([
    {
      name: "list",
      command: listCommand,
      target: "work-org",
      methods: ["GET"],
    },
    {
      name: "create",
      command: createCommand,
      target: "work-org/ci",
      methods: ["POST"],
    },
    {
      name: "delete",
      command: deleteCommand,
      target: "work-org/7",
      methods: ["GET", "DELETE"],
    },
  ])(
    "$name uses the target account for scopes and the action",
    async ({ name, command, target, methods }) => {
      await runCommand(command, target, name);

      expect(requests).toEqual(
        [
          { method: "GET", url: `${WORK_HOST}/api/0/` },
          ...methods.map((method) => ({
            method,
            url: `${WORK_HOST}${TOKEN_PATH}${method === "DELETE" ? "7/" : ""}`,
          })),
        ].map((request) => ({
          ...request,
          authorization: "Bearer work-token",
        })),
      );
      expect(getActiveAccountId()).toBe(activeAccountId);
    },
  );

  test("keeps an explicitly pinned account on the same server", async () => {
    const pinned = addAccount("pinned-token", WORK_HOST);
    setActiveAccount(activeAccountId);

    await withStoredAccount({ id: pinned, host: WORK_HOST }, () =>
      runCommand(listCommand, "work-org"),
    );

    expect(requests).toEqual([
      {
        method: "GET",
        url: `${WORK_HOST}/api/0/`,
        authorization: "Bearer pinned-token",
      },
      {
        method: "GET",
        url: `${WORK_HOST}${TOKEN_PATH}`,
        authorization: "Bearer pinned-token",
      },
    ]);
    expect(getActiveAccountId()).toBe(activeAccountId);
  });
});
