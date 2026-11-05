import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createAlert,
  deleteAlert,
  getAlert,
  listAlertsPaginated,
  updateAlert,
} from "../../../src/lib/api/alerts.js";
import type { AlertCreateBody } from "../../../src/lib/api/alerts.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { workflow } from "../../fixtures/workflow.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("api-native-alerts-");
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

describe("native alert API", () => {
  test("lists attached and detached workflow documents without flattening or filtering", async () => {
    const documents = [
      workflow(),
      workflow({ id: "43", name: "Detached", detectorIds: [] }),
    ];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/workflows/");
      expect(url.searchParams.getAll("project")).toEqual(["-1"]);
      expect(url.searchParams.get("per_page")).toBe("2");
      expect(request.headers.get("Authorization")).toBe("Bearer test-token");
      return Response.json(documents, {
        headers: {
          Link: '<https://sentry.io/api/0/organizations/test-org/workflows/?cursor=next-page>; rel="next"; results="true"; cursor="next-page"',
        },
      });
    });
    const page = await listAlertsPaginated("test-org", { perPage: 2 });
    expect(page.data).toEqual(documents);
    expect(page.nextCursor).toBe("next-page");
    expect(page.data[0]).not.toHaveProperty("frequency");
    expect(page.data[0]).not.toHaveProperty("status");
  });

  test("forwards native search, project and connected monitor filters with the cursor", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.searchParams.get("query")).toBe('name:"Notify on-call"');
      expect(url.searchParams.getAll("project")).toEqual(["backend", "123"]);
      expect(url.searchParams.getAll("detector")).toEqual(["9", "10"]);
      expect(url.searchParams.get("cursor")).toBe("page-two");
      return Response.json([]);
    });
    await listAlertsPaginated("test-org", {
      query: 'name:"Notify on-call"',
      project: ["backend", "123"],
      monitor: ["9", "10"],
      cursor: "page-two",
    });
  });

  test("gets a detached alert directly by its organization-scoped workflow ID", async () => {
    const document = workflow({ detectorIds: [] });
    globalThis.fetch = mockFetch(async (input, init) => {
      expect(new Request(input!, init).url).toBe(
        `${DEFAULT_SENTRY_URL}/api/0/organizations/test-org/workflows/42/`,
      );
      return Response.json(document);
    });
    expect(await getAlert("test-org", "42")).toEqual(document);
  });

  test("creates with an exact native SDK body linked to any monitor", async () => {
    const body: AlertCreateBody = {
      name: "Metric notification",
      enabled: true,
      detectorIds: [9],
      config: { frequency: 0 },
      actionFilters: [
        {
          logicType: "all",
          conditions: [],
          actions: [
            {
              type: "email",
              data: {},
              config: { targetType: "team", targetIdentifier: "7" },
            },
          ],
        },
      ],
    };
    const document = workflow({
      name: body.name,
      enabled: true,
      config: body.config ?? {},
    });
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        "/api/0/organizations/test-org/workflows/",
      );
      expect(await request.json()).toEqual(body);
      return Response.json(document, { status: 201 });
    });
    expect(await createAlert("test-org", body)).toEqual(document);
  });

  test("updates without adding flattened fields or dropping explicitly preserved enabled state", async () => {
    const body = { name: "Renamed", enabled: false };
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe(
        "/api/0/organizations/test-org/workflows/42/",
      );
      expect(await request.json()).toEqual(body);
      return Response.json(workflow({ name: body.name }));
    });
    expect(await updateAlert("test-org", "42", body)).toEqual(
      workflow({ name: "Renamed" }),
    );
  });

  test("deletes only the workflow and accepts an empty 204 response", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).pathname).toBe(
        "/api/0/organizations/test-org/workflows/42/",
      );
      return new Response(null, { status: 204 });
    });
    await expect(deleteAlert("test-org", "42")).resolves.toBeUndefined();
  });
});
