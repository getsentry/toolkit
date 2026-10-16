/**
 * Tests for the integration API helpers.
 *
 * Pins the request shape Sentry's integrations endpoints expect, in
 * particular `includeConfig=0`: the endpoint fetches third-party config
 * for any other value (including `false`).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deleteIntegration,
  getIntegration,
  listIntegrationsPaginated,
} from "../../../src/lib/api/integrations.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const integration = {
  id: "42",
  name: "getsentry",
  domainName: "github.com/getsentry",
  provider: { key: "github", name: "GitHub" },
  status: "active",
  organizationIntegrationStatus: "active",
  externalId: "123",
};

type Captured = { url: URL; method: string };

function capture(
  calls: Captured[],
  respond: () => Response,
): typeof globalThis.fetch {
  return mockFetch(async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: new URL(request.url), method: request.method });
    return respond();
  });
}

describe("integration API", () => {
  useTestConfigDir("integrations-api-");
  let originalFetch: typeof globalThis.fetch;
  let calls: Captured[];

  beforeEach(() => {
    setAuthToken("test-token", 3600, "test-refresh");
    setOrgRegion("my-org", "https://sentry.io");
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("list sends includeConfig=0 and pagination params", async () => {
    globalThis.fetch = capture(
      calls,
      () =>
        new Response(JSON.stringify([integration]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: '<https://sentry.io/next>; rel="next"; results="true"; cursor="0:25:0"',
          },
        }),
    );

    const page = await listIntegrationsPaginated("my-org", {
      cursor: "0:0:0",
      perPage: 25,
    });

    expect(page.data).toEqual([integration]);
    expect(page.nextCursor).toBe("0:25:0");
    expect(calls).toHaveLength(1);
    const { url, method } = calls[0]!;
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/0/organizations/my-org/integrations/");
    expect(url.searchParams.get("includeConfig")).toBe("0");
    expect(url.searchParams.get("cursor")).toBe("0:0:0");
    expect(url.searchParams.get("per_page")).toBe("25");
  });

  test("get fetches a single integration by ID", async () => {
    globalThis.fetch = capture(
      calls,
      () =>
        new Response(JSON.stringify(integration), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(getIntegration("my-org", "42")).resolves.toEqual(integration);
    expect(calls[0]?.url.pathname).toBe(
      "/api/0/organizations/my-org/integrations/42/",
    );
  });

  test("delete issues DELETE and accepts 204", async () => {
    globalThis.fetch = capture(
      calls,
      () => new Response(null, { status: 204 }),
    );

    await deleteIntegration("my-org", "42");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe(
      "/api/0/organizations/my-org/integrations/42/",
    );
  });

  test("delete surfaces 403 as ApiError", async () => {
    globalThis.fetch = capture(
      calls,
      () =>
        new Response(
          JSON.stringify({
            detail: "You do not have permission to perform this action.",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
    );

    const error = await deleteIntegration("my-org", "42").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});
