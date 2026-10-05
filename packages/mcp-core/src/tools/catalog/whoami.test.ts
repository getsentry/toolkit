import { http, HttpResponse } from "msw";
import { mswServer } from "@sentry/mcp-server-mocks";
import { describe, it, expect } from "vitest";
import whoami, { whoamiOutputSchema } from "./whoami.js";
import {
  createTestContext,
  createTestContextWithConstraints,
} from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";

describe("whoami", () => {
  it.each([
    ["sentry.io", "sentry.io"],
    ["us.sentry.io", "sentry.io"],
    ["de.sentry.io", "sentry.io"],
    ["example.us.sentry.io", "sentry.io"],
    ["example.my.sentry.io", "example.my.sentry.io"],
    ["sentry.example.com", "sentry.example.com"],
  ])(
    "queries %s identity through %s despite regional constraints",
    async (host, expectedHost) => {
      const requests: { url: string; authorization: string | null }[] = [];
      const user = { id: 123456, name: "Test User", email: "test@example.com" };
      const constraints = { regionUrl: "https://de.sentry.io" };
      mswServer.use(
        http.get("*", ({ request }) => {
          requests.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          return HttpResponse.json(user);
        }),
      );

      const result = await whoami.handler(
        {},
        createTestContextWithConstraints(constraints, {
          sentryHost: host,
          accessToken: "test-token",
        }),
      );

      expect(requests).toEqual([
        {
          url: `https://${expectedHost}/api/0/auth/`,
          authorization: "Bearer test-token",
        },
      ]);
      expect(getStructuredContent(result)).toEqual({
        user: { ...user, id: String(user.id) },
        sessionConstraints: constraints,
      });
    },
  );

  it("serializes without constraints", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/auth/", () =>
        HttpResponse.json({
          id: 123456,
          name: "Test User",
          email: "test@example.com",
          backendOnlyField: "do-not-leak",
        }),
      ),
    );

    const result = await whoami.handler(
      {},
      createTestContext({
        constraints: {},
        accessToken: "access-token",
        userId: "123456",
      }),
    );
    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(whoami.outputSchema).toBe(whoamiOutputSchema);
    expect(whoamiOutputSchema.safeParse(structuredContent).success).toBe(true);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "sessionConstraints": null,
        "user": {
          "email": "test@example.com",
          "id": "123456",
          "name": "Test User",
        },
      }
    `);
  });

  it("serializes with constraints", async () => {
    const result = await whoami.handler(
      {},
      createTestContextWithConstraints(
        {
          organizationSlug: "sentry",
          projectSlug: "mcp-server",
          regionUrl: "https://us.sentry.io",
        },
        {
          accessToken: "access-token",
          userId: "123456",
        },
      ),
    );
    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(whoamiOutputSchema.safeParse(structuredContent).success).toBe(true);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "sessionConstraints": {
          "organizationSlug": "sentry",
          "projectSlug": "mcp-server",
          "regionUrl": "https://us.sentry.io",
        },
        "user": {
          "email": "test@example.com",
          "id": "123456",
          "name": "Test User",
        },
      }
    `);
  });

  it("serializes with partial constraints", async () => {
    const result = await whoami.handler(
      {},
      createTestContextWithConstraints(
        {
          organizationSlug: "sentry",
        },
        {
          accessToken: "access-token",
          userId: "123456",
        },
      ),
    );
    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(whoamiOutputSchema.safeParse(structuredContent).success).toBe(true);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "sessionConstraints": {
          "organizationSlug": "sentry",
        },
        "user": {
          "email": "test@example.com",
          "id": "123456",
          "name": "Test User",
        },
      }
    `);
  });
});
