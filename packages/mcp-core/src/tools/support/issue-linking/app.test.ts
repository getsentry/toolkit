import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { SentryApiService } from "../../../api-client";
import { linkAppIssue, unlinkAppIssue } from "./app";

const api = new SentryApiService({ accessToken: "test-token" });
const base = "https://sentry.io/api/0";
const url = "https://linear.app/example/issue/ENG-123/fix-the-error";
const params = {
  organizationSlug: "example",
  issueId: "123",
  projectId: "7",
  externalIssueUrl: url,
};
const association = {
  id: "42",
  issueId: "123",
  serviceType: "linear",
  displayName: "ENG-123",
  webUrl: url,
};
const linkForm = {
  uri: "/issues/link",
  required_fields: [{ name: "issueId", type: "select", uri: "/issues/search" }],
};

function mockDiscovery({
  slug = "linear",
  form = linkForm as Record<string, unknown>,
  links = [] as (typeof association)[],
} = {}) {
  mswServer.use(
    http.get(`${base}/organizations/example/sentry-app-installations/`, () =>
      HttpResponse.json([
        {
          uuid: "installation",
          status: "installed",
          app: { uuid: "app", slug },
        },
      ]),
    ),
    http.get(
      `${base}/organizations/example/sentry-app-components/`,
      ({ request }) => {
        expect(new URL(request.url).searchParams.get("filter")).toBe(
          "issue-link",
        );
        return HttpResponse.json([
          {
            type: "issue-link",
            sentryApp: { uuid: "app", slug },
            schema: { link: form },
          },
        ]);
      },
    ),
    http.get(`${base}/organizations/example/issues/123/external-issues/`, () =>
      HttpResponse.json(links),
    ),
  );
}

describe("linkAppIssue", () => {
  it.each([
    {
      slug: "linear",
      targetUrl: url,
      key: "ENG-123",
      choice: "linear-issue",
      fields: undefined,
      appSlug: undefined,
    },
    {
      slug: "shortcut",
      targetUrl: "https://app.shortcut.com/example/story/123/fix-the-error",
      key: "123",
      choice: 123,
      fields: undefined,
      appSlug: undefined,
    },
  ])(
    "links through the installed $slug callback with the original URL guard",
    async ({ slug, targetUrl, key, choice, fields, appSlug }) => {
      mockDiscovery({ slug });
      let actions = 0;
      mswServer.use(
        http.get(
          `${base}/sentry-app-installations/installation/external-requests/`,
          ({ request }) => {
            const query = new URL(request.url).searchParams;
            expect(query.get("uri")).toBe("/issues/search");
            expect(query.get("query")).toBe(key);
            expect(query.get("projectId")).toBe("7");
            return HttpResponse.json({
              choices: [[choice, `${key} Fix the error`]],
            });
          },
        ),
        http.post(
          `${base}/sentry-app-installations/installation/external-issue-actions/`,
          async ({ request }) => {
            actions++;
            expect(
              new URL(request.url).searchParams.get("expectedExternalIssueUrl"),
            ).toBe(targetUrl);
            expect(await request.json()).toEqual({
              groupId: "123",
              action: "link",
              uri: "/issues/link",
              issueId: choice,
            });
            return HttpResponse.json(
              { ...association, serviceType: slug, webUrl: targetUrl },
              { status: 201 },
            );
          },
        ),
      );
      await expect(
        linkAppIssue(api, {
          ...params,
          externalIssueUrl: targetUrl,
          fields,
          appSlug,
        }),
      ).resolves.toEqual({
        url: targetUrl,
        provider: slug,
        displayName: "ENG-123",
        status: "linked",
      });
      expect(actions).toBe(1);
    },
  );

  it("resolves defaults and dependent choices before submitting the form", async () => {
    mockDiscovery({
      form: {
        uri: "/issues/link",
        required_fields: [
          {
            name: "issueId",
            type: "select",
            uri: "/issues/search",
            depends_on: ["team"],
          },
          { name: "team", type: "select", uri: "/teams" },
        ],
        optional_fields: [
          {
            name: "priority",
            type: "select",
            options: [[0, "None"]],
            defaultValue: 0,
          },
        ],
      },
    });
    const searches: string[] = [];
    mswServer.use(
      http.get(
        `${base}/sentry-app-installations/installation/external-requests/`,
        ({ request }) => {
          const query = new URL(request.url).searchParams;
          const uri = query.get("uri")!;
          searches.push(uri);
          if (uri === "/teams")
            return HttpResponse.json({
              choices: [["team-id", "Engineering"]],
              defaultValue: "team-id",
            });
          expect(query.get("dependentData")).toBe('{"team":"team-id"}');
          expect(query.get("query")).toBe("ENG-123");
          return HttpResponse.json({
            choices: [["issue-id", "ENG-123 Fix the error"]],
          });
        },
      ),
      http.post(
        `${base}/sentry-app-installations/installation/external-issue-actions/`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            groupId: "123",
            action: "link",
            uri: "/issues/link",
            team: "team-id",
            issueId: "issue-id",
            priority: 0,
          });
          return HttpResponse.json(association, { status: 201 });
        },
      ),
    );
    await expect(linkAppIssue(api, params)).resolves.toMatchObject({
      status: "linked",
    });
    expect(searches).toEqual(["/teams", "/issues/search"]);
  });

  it.each([
    { source: "default", defaultValue: "", fields: undefined },
    { source: "supplied value", defaultValue: "preset", fields: { note: "" } },
  ])("omits an empty optional $source", async ({ defaultValue, fields }) => {
    mockDiscovery({
      form: {
        uri: "/issues/link",
        required_fields: [{ name: "issueId", type: "text" }],
        optional_fields: [{ name: "note", type: "text", defaultValue }],
      },
    });
    mswServer.use(
      http.post(
        `${base}/sentry-app-installations/installation/external-issue-actions/`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            groupId: "123",
            action: "link",
            uri: "/issues/link",
            issueId: "ENG-123",
          });
          return HttpResponse.json(association, { status: 201 });
        },
      ),
    );
    await expect(
      linkAppIssue(api, { ...params, fields }),
    ).resolves.toMatchObject({
      status: "linked",
    });
  });

  it("still requires an empty optional field when the target depends on it", async () => {
    mockDiscovery({
      form: {
        uri: "/issues/link",
        required_fields: [
          { name: "issueId", type: "text", depends_on: ["team"] },
        ],
        optional_fields: [{ name: "team", type: "text", defaultValue: "" }],
      },
    });
    await expect(linkAppIssue(api, params)).rejects.toThrow(
      "Provide required App link field 'team' in fields.",
    );
  });

  it("guards a repeat with its stored canonical URL and prepares fields for a concurrent unlink", async () => {
    mockDiscovery({ links: [association] });
    let searches = 0;
    let actions = 0;
    mswServer.use(
      http.get(
        `${base}/sentry-app-installations/installation/external-requests/`,
        () => {
          searches++;
          return HttpResponse.json({
            choices: [["issue-id", "ENG-123 Fix the error"]],
          });
        },
      ),
      http.post(
        `${base}/sentry-app-installations/installation/external-issue-actions/`,
        async ({ request }) => {
          actions++;
          expect(
            new URL(request.url).searchParams.get("expectedExternalIssueUrl"),
          ).toBe(url);
          expect(await request.json()).toEqual({
            groupId: "123",
            action: "link",
            uri: "/issues/link",
            issueId: "issue-id",
          });
          return HttpResponse.json(association, { status: 200 });
        },
      ),
    );
    await expect(
      linkAppIssue(api, {
        ...params,
        externalIssueUrl:
          "https://linear.app/example/issue/ENG-123/old-title?utm_source=test",
      }),
    ).resolves.toMatchObject({ status: "already_linked", url });
    expect(actions).toBe(1);
    expect(searches).toBe(1);
  });

  it("requires a valid installed callback even for an existing association", async () => {
    mockDiscovery({
      links: [association],
      form: { ...linkForm, uri: "https://other.example/link" },
    });
    await expect(linkAppIssue(api, params)).rejects.toThrow(
      "invalid callback URI",
    );
  });

  it("requires an explicit unlink before replacing an App association", async () => {
    mockDiscovery({
      links: [
        {
          ...association,
          webUrl: "https://linear.app/example/issue/ENG-999/other",
        },
      ],
    });
    await expect(linkAppIssue(api, params)).rejects.toThrow(
      "Unlink it explicitly",
    );
  });

  it.each(["action", "unknownField"])(
    "rejects caller field %s before invoking the App",
    async (name) => {
      mockDiscovery();
      await expect(
        linkAppIssue(api, { ...params, fields: { [name]: "override" } }),
      ).rejects.toThrow("not allowed");
    },
  );

  it.each(["select", "text"])(
    "rejects a conflicting %s target before invoking the callback",
    async (type) => {
      mockDiscovery({
        form: {
          uri: "/issues/link",
          required_fields: [
            {
              name: "issueId",
              type,
              choices: [
                ["requested-id", "ENG-123 Requested"],
                ["other-id", "ENG-999 Other"],
              ],
            },
          ],
        },
      });
      let actions = 0;
      mswServer.use(
        http.post(
          `${base}/sentry-app-installations/installation/external-issue-actions/`,
          () => {
            actions++;
            return HttpResponse.json(association, { status: 201 });
          },
        ),
      );
      await expect(
        linkAppIssue(api, {
          ...params,
          fields: { issueId: type === "select" ? "other-id" : "ENG-999" },
        }),
      ).rejects.toThrow("conflicts with externalIssueUrl");
      expect(actions).toBe(0);
    },
  );

  it.each([123, 456])(
    "matches a Shortcut numeric choice value before its title (%s)",
    async (choice) => {
      const targetUrl =
        "https://app.shortcut.com/example/story/123/fix-the-error";
      mockDiscovery({
        slug: "shortcut",
        form: {
          uri: "/issues/link",
          required_fields: [
            {
              name: "issueId",
              type: "select",
              choices: [[choice, "2026 planning"]],
            },
          ],
        },
      });
      let actions = 0;
      mswServer.use(
        http.post(
          `${base}/sentry-app-installations/installation/external-issue-actions/`,
          () => {
            actions++;
            return HttpResponse.json(
              { ...association, serviceType: "shortcut", webUrl: targetUrl },
              { status: 201 },
            );
          },
        ),
      );
      const result = linkAppIssue(api, {
        ...params,
        externalIssueUrl: targetUrl,
        fields: { issueId: choice },
      });
      if (choice === 123) {
        await expect(result).resolves.toMatchObject({ status: "linked" });
        expect(actions).toBe(1);
      } else {
        await expect(result).rejects.toThrow("conflicts with externalIssueUrl");
        expect(actions).toBe(0);
      }
    },
  );

  it("reports canonical URL and concurrent replacement conflicts without an unguarded retry", async () => {
    mockDiscovery({
      form: {
        uri: "/issues/link",
        required_fields: [{ name: "issueId", type: "text" }],
      },
    });
    let actions = 0;
    mswServer.use(
      http.post(
        `${base}/sentry-app-installations/installation/external-issue-actions/`,
        ({ request }) => {
          actions++;
          expect(
            new URL(request.url).searchParams.get("expectedExternalIssueUrl"),
          ).toBe(url);
          return HttpResponse.json(
            { detail: "External issue URL does not match expected URL" },
            { status: 409 },
          );
        },
      ),
    );
    await expect(linkAppIssue(api, params)).rejects.toThrow(
      "exact canonical issue URL",
    );
    expect(actions).toBe(1);
  });
});

describe("unlinkAppIssue", () => {
  it.each([true, false])(
    "removes only the matching association (present: %s)",
    async (present) => {
      mockDiscovery({ links: present ? [association] : [] });
      let deletes = 0;
      mswServer.use(
        http.delete(
          `${base}/organizations/example/issues/123/external-issues/42/`,
          () => {
            deletes++;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );
      await expect(
        unlinkAppIssue(api, {
          ...params,
          externalIssueUrl:
            "https://linear.app/example/issue/ENG-123/old-title",
        }),
      ).resolves.toMatchObject({ status: "not_linked" });
      expect(deletes).toBe(present ? 1 : 0);
    },
  );
});
