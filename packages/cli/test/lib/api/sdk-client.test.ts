import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getOrgSentryClient,
  getSentryClient,
} from "../../../src/lib/api/infrastructure.js";
import { listTeams, listTeamsPaginated } from "../../../src/lib/api/teams.js";
import { getAuthConfig, setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { withEnv } from "../../../src/lib/env.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

const REGION = "https://us.sentry.io";
const ORG = "example-org";
const TEAM_PATH = { organization_id_or_slug: ORG };

describe("invocation API client", () => {
  const configDir = useTestConfigDir("api-sdk-client-");
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_CLIENT_ID",
  ]);

  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    resetAuthenticatedFetch();
    await resetHostScopingState();
    setAuthToken("example-access-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    setOrgRegion(ORG, REGION);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetAuthenticatedFetch();
    await resetHostScopingState();
  });

  test("reuses a client for the same invocation, deployment, and identity", async () => {
    await withEnv({ ...process.env }, async () => {
      const sentry = getSentryClient(REGION);

      expect(getSentryClient(`${REGION}/`)).toBe(sentry);
      expect(await getOrgSentryClient(ORG)).toBe(sentry);
      expect(getSentryClient("https://de.sentry.io")).not.toBe(sentry);
    });
  });

  test("does not share mutable clients between invocation environments", () => {
    const first = withEnv({ ...process.env }, () => getSentryClient(REGION));
    const second = withEnv({ ...process.env }, () => getSentryClient(REGION));

    expect(second).not.toBe(first);
  });

  test("selects a new client after the credential identity changes", () => {
    withEnv({ ...process.env }, () => {
      const first = getSentryClient(REGION);
      setAuthToken("another-access-token");

      expect(getSentryClient(REGION)).not.toBe(first);
    });
  });

  test("keeps clients separate when the config store changes", () => {
    const env = { ...process.env };
    withEnv(env, () => {
      const first = getSentryClient(REGION);
      env.SENTRY_CONFIG_DIR = join(configDir(), "another-config");
      setAuthToken("example-access-token", undefined, undefined, {
        host: "https://sentry.io",
      });

      expect(getSentryClient(REGION)).not.toBe(first);
    });
  });

  test("keeps simultaneous deployments and tokens in their invocation", async () => {
    const requests: { origin: string; authorization: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      await Promise.resolve();
      requests.push({
        origin: new URL(request.url).origin,
        authorization: request.headers.get("authorization"),
      });
      return Response.json([]);
    });

    const deployments = [
      { host: "https://sentry.io", token: "saas-token" },
      { host: "https://sentry.example", token: "self-hosted-token" },
      { host: "https://tenant.example", token: "single-tenant-token" },
    ];
    await Promise.all(
      deployments.map(({ host, token }) =>
        withEnv(
          {
            ...process.env,
            SENTRY_HOST: host,
            SENTRY_AUTH_TOKEN: token,
            SENTRY_FORCE_ENV_TOKEN: "1",
          },
          async () => {
            const sentry = getSentryClient(host);
            await Promise.resolve();
            await sentry.listOrganizationTeams({
              path: TEAM_PATH,
              throwOnError: true,
            });
          },
        ),
      ),
    );

    expect(requests).toHaveLength(3);
    expect(requests).toEqual(
      expect.arrayContaining(
        deployments.map(({ host, token }) => ({
          origin: host,
          authorization: `Bearer ${token}`,
        })),
      ),
    );
  });

  test("a held client uses the refreshed token on subsequent requests", async () => {
    process.env.SENTRY_CLIENT_ID = "example-client";
    setAuthToken("old-access", 3600, "stable-refresh-token");
    const authorizations: (string | null)[] = [];
    let refreshes = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/oauth/token/")) {
        refreshes += 1;
        return Response.json({
          access_token: "new-access",
          refresh_token: "stable-refresh-token",
          expires_in: 3600,
          token_type: "bearer",
        });
      }
      const authorization = request.headers.get("authorization");
      authorizations.push(authorization);
      return authorization === "Bearer old-access"
        ? Response.json({ detail: "Token expired" }, { status: 401 })
        : Response.json([]);
    });

    await withEnv({ ...process.env }, async () => {
      const sentry = getSentryClient(REGION);
      await sentry.listOrganizationTeams({
        path: TEAM_PATH,
        throwOnError: true,
      });
      await sentry.listOrganizationTeams({
        path: TEAM_PATH,
        throwOnError: true,
      });

      expect(getSentryClient(REGION)).toBe(sentry);
      expect(getAuthConfig()?.token).toBe("new-access");
    });

    expect(refreshes).toBe(1);
    expect(authorizations).toEqual([
      "Bearer old-access",
      "Bearer new-access",
      "Bearer new-access",
    ]);
  });

  test("keeps the shared CLI error mapping for bound team calls", async () => {
    const detail = "You are missing the required scope team:read.";
    globalThis.fetch = vi.fn(async () =>
      Response.json({ detail }, { status: 403, statusText: "Forbidden" }),
    );

    await withEnv({ ...process.env }, async () => {
      await expect(listTeams(ORG)).rejects.toMatchObject({
        status: 403,
        message: "Failed to list teams: 403 Forbidden",
        detail: expect.stringContaining("--scope team:read"),
        enriched403: true,
      });
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("keeps CLI pagination cursors and the HTTP response", async () => {
    const requests: URL[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(new URL(request.url));
      return Response.json([{ id: "1", slug: "backend", name: "Backend" }], {
        headers: {
          link:
            '<https://us.sentry.io/api/0/teams/>; rel="previous"; results="true"; cursor="25:0:1", ' +
            '<https://us.sentry.io/api/0/teams/>; rel="next"; results="true"; cursor="25:2:0"',
          "x-request-id": "example-request",
        },
      });
    });

    await withEnv({ ...process.env }, async () => {
      const sentry = await getOrgSentryClient(ORG);
      const page = await listTeamsPaginated(ORG, { cursor: "25:1:0" });

      expect(await getOrgSentryClient(ORG)).toBe(sentry);
      expect(page).toMatchObject({
        data: [{ id: "1", slug: "backend", name: "Backend" }],
        nextCursor: "25:2:0",
        prevCursor: "25:0:1",
      });
      expect(page.response?.headers.get("x-request-id")).toBe(
        "example-request",
      );
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("per_page")).toBe("25");
    expect(requests[0]?.searchParams.get("cursor")).toBe("25:1:0");
  });
});
