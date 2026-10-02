/** Contract tests for installed app callbacks, singleton protection, and regional discovery. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AppIssueLink,
  findAppIssueLink,
  linkAppIssue,
  listAppIssueLinks,
  resolveAppIssueLink,
} from "../../../src/lib/api/issue-app-links.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("issue-app-links-");

const ORG = "example-org";
const ISSUE = "123";
const URL = "https://linear.app/example/issue/ENG-42/fix-crash";
const OPTIONS = { orgSlug: ORG, issueId: ISSUE, url: URL, projectId: "77" };
const LINK: AppIssueLink = {
  id: "99",
  issueId: ISSUE,
  serviceType: "linear",
  displayName: "ENG-42",
  webUrl: URL,
};
const INSTALLATION = {
  uuid: "install-uuid",
  status: "installed",
  organization: { slug: ORG },
  app: { uuid: "app-uuid", slug: "linear", sentryAppId: 12 },
};
const FORM = {
  uri: "/hooks/sentry/issues/link",
  required_fields: [
    { name: "issueId", type: "select", uri: "/hooks/sentry/issues/search" },
  ],
};
const COMPONENT = {
  uuid: "component-uuid",
  type: "issue-link",
  error: "",
  sentryApp: { uuid: "app-uuid", slug: "linear", name: "Linear", avatars: [] },
  schema: { link: FORM },
};

let originalFetch: typeof globalThis.fetch;
let calls: Request[];
let links: AppIssueLink[];
let choices: [string, string][];
let form: unknown;
let installation: typeof INSTALLATION;
let actionStatus: number;
let actionLink: AppIssueLink;

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  setOrgRegion(ORG, "https://de.sentry.io");
  resetAuthenticatedFetch();
  calls = [];
  links = [];
  choices = [["linear-uuid", "ENG-42: Fix the crash"]];
  form = FORM;
  installation = INSTALLATION;
  actionStatus = 201;
  actionLink = LINK;
  globalThis.fetch = mockFetch(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    const path = new globalThis.URL(request.url).pathname;
    if (path.endsWith("/external-issues/") && request.method === "GET") {
      return json(links);
    }
    if (path.endsWith("/sentry-app-installations/")) {
      return json([installation]);
    }
    if (path.endsWith("/sentry-app-components/")) {
      return json([{ ...COMPONENT, schema: { link: form } }]);
    }
    if (path.endsWith("/external-requests/")) {
      return json({ choices });
    }
    if (path.endsWith("/external-issue-actions/")) {
      return json(
        actionStatus < 300 ? actionLink : { detail: "Provider failed" },
        actionStatus
      );
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

function writes(): Request[] {
  return calls.filter((request) => request.method !== "GET");
}

describe("app issue-link action", () => {
  test("resolves Linear key to UUID read-only, then sends the schema URI and fields top-level", async () => {
    const prepared = await resolveAppIssueLink(OPTIONS);
    expect(writes()).toHaveLength(0);
    expect(prepared.fields).toEqual({ issueId: "linear-uuid" });
    const search = calls.find((request) =>
      request.url.includes("external-requests")
    );
    expect(search?.url).toContain(
      "https://sentry.io/api/0/sentry-app-installations/install-uuid/"
    );
    expect(search?.url).toContain("query=ENG-42");
    expect(search?.url).toContain("projectId=77");
    expect(calls[0]?.url).toContain(
      "https://de.sentry.io/api/0/organizations/"
    );
    expect(await linkAppIssue(prepared)).toEqual({ changed: true, link: LINK });
    expect(writes()).toHaveLength(1);
    expect(
      new globalThis.URL(writes()[0]!.url).searchParams.get(
        "expectedExternalIssueUrl"
      )
    ).toBe(URL);
    expect(await writes()[0]?.json()).toEqual({
      groupId: ISSUE,
      action: "link",
      uri: FORM.uri,
      issueId: "linear-uuid",
    });
    expect(
      calls.filter((request) => request.url.includes("/external-issues/"))
    ).toHaveLength(1);
  });

  test.each([
    "ENG-420: Other issue",
    "ENG-99: Follow up on ENG-42",
  ])("rejects a nonmatching Linear label: %s", async (label) => {
    choices = [["wrong", label]];
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "did not return an exact match"
    );
    expect(writes()).toHaveLength(0);
  });

  test("rejects multiple exact matches rather than selecting the first", async () => {
    choices.push(["another-uuid", "ENG-42: Another issue"]);
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "multiple exact issue matches"
    );
    expect(writes()).toHaveLength(0);
  });

  test.each([
    200, 201,
  ])("guards an existing Linear link with its canonical URL (HTTP %s)", async (status) => {
    links = [
      { ...LINK, webUrl: "https://linear.app/example/issue/eng-42/new-title" },
    ];
    const prepared = await resolveAppIssueLink(OPTIONS);
    expect(prepared.existing?.id).toBe(LINK.id);
    expect(prepared.fields).toEqual({ issueId: "linear-uuid" });
    actionStatus = status;
    actionLink = links[0]!;
    expect(await linkAppIssue(prepared)).toEqual({
      changed: status === 201,
      link: links[0],
    });
    expect(
      new globalThis.URL(writes()[0]!.url).searchParams.get(
        "expectedExternalIssueUrl"
      )
    ).toBe(links[0]!.webUrl);
    expect(await writes()[0]?.json()).toMatchObject({
      uri: FORM.uri,
      issueId: "linear-uuid",
    });
    expect(writes()).toHaveLength(1);
  });

  test("refuses to replace another issue linked to the same app", async () => {
    links = [
      { ...LINK, webUrl: "https://linear.app/example/issue/ENG-99/other" },
    ];
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "Unlink it before"
    );
    expect(writes()).toHaveLength(0);
  });

  test("uses the backend guard when another association appears after preflight", async () => {
    const prepared = await resolveAppIssueLink(OPTIONS);
    actionStatus = 409;
    await expect(linkAppIssue(prepared)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(1);
  });

  test("reports a backend no-op when the same association appears after preflight", async () => {
    const prepared = await resolveAppIssueLink(OPTIONS);
    actionStatus = 200;
    expect(await linkAppIssue(prepared)).toEqual({
      changed: false,
      link: LINK,
    });
    expect(writes()).toHaveLength(1);
  });

  test.each([
    "static",
    "search",
  ])("links an explicit generic issue ID from %s choices", async (source) => {
    const url = "https://tracker.example/tasks/123";
    installation = {
      ...INSTALLATION,
      app: { ...INSTALLATION.app, slug: "custom" },
    };
    choices = [["123", "An Issue"]];
    form = {
      uri: "/sentry/tasks/link",
      required_fields: [
        {
          name: "task_id",
          type: "select",
          ...(source === "static"
            ? { options: choices }
            : { uri: "/sentry/tasks" }),
        },
      ],
    };
    const prepared = await resolveAppIssueLink({
      ...OPTIONS,
      url,
      appSlug: "custom",
      fields: { task_id: "123" },
    });
    expect(prepared.fields).toEqual({ task_id: "123" });
    actionLink = { ...LINK, serviceType: "custom", webUrl: url };
    expect(await linkAppIssue(prepared)).toEqual({
      changed: true,
      link: actionLink,
    });
    expect(await writes()[0]?.json()).toMatchObject({ task_id: "123" });
    expect(writes()).toHaveLength(1);
  });

  test("preserves query and fragment identity in the backend URL guard", async () => {
    const url = "https://tracker.example/view?id=42#issue";
    installation = {
      ...INSTALLATION,
      app: { ...INSTALLATION.app, slug: "custom" },
    };
    form = { uri: "/link", required_fields: [{ name: "url", type: "text" }] };
    actionLink = { ...LINK, serviceType: "custom", webUrl: url };
    const prepared = await resolveAppIssueLink({
      ...OPTIONS,
      appSlug: "custom",
      url,
    });
    await linkAppIssue(prepared);
    expect(
      new globalThis.URL(writes()[0]!.url).searchParams.get(
        "expectedExternalIssueUrl"
      )
    ).toBe(url);
  });

  test("requires an installation in the requested organization", async () => {
    installation = { ...INSTALLATION, organization: { slug: "other-org" } };
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "not installed in this organization"
    );
    expect(writes()).toHaveLength(0);
  });

  test("finds the installed app on later SDK cursor pages", async () => {
    const defaultFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      const parsed = new globalThis.URL(request.url);
      if (!parsed.pathname.endsWith("/sentry-app-installations/")) {
        return defaultFetch(input, init);
      }
      calls.push(request);
      if (parsed.searchParams.get("cursor") === "install-page-2") {
        return json([INSTALLATION]);
      }
      return json([], 200, {
        Link: '<https://untrusted.invalid/>; rel="next"; results="true"; cursor="install-page-2"',
      });
    });
    const prepared = await resolveAppIssueLink(OPTIONS);
    expect(prepared.installationUuid).toBe(INSTALLATION.uuid);
    const pages = calls.filter((request) =>
      request.url.includes("/sentry-app-installations/?")
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.url).toBe(
      "https://sentry.io/api/0/organizations/example-org/sentry-app-installations/?cursor=install-page-2"
    );
    expect(writes()).toHaveLength(0);
  });

  test("propagates SDK installation errors without attempting the callback", async () => {
    const defaultFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.includes("/sentry-app-installations/")) {
        return defaultFetch(input, init);
      }
      calls.push(request);
      return json({ detail: "Installation access denied" }, 403);
    });
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toBeInstanceOf(ApiError);
    expect(writes()).toHaveLength(0);
  });

  test("rejects unsupported app link forms instead of using direct registration", async () => {
    form = undefined;
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "does not expose"
    );
    expect(writes()).toHaveLength(0);
  });

  test("does not allow user fields to override the action URI or target", async () => {
    await expect(
      resolveAppIssueLink({ ...OPTIONS, fields: { uri: "/create" } })
    ).rejects.toThrow("reserved app link field");
    await expect(
      resolveAppIssueLink({ ...OPTIONS, fields: { issueId: "different-uuid" } })
    ).rejects.toThrow("conflicts");
    expect(writes()).toHaveLength(0);
  });

  test("uses a supplied ID to disambiguate matching labels without accepting another issue", async () => {
    choices = [
      ["linear-uuid", "ENG-42: Fix"],
      ["another-uuid", "ENG-42: Fix"],
      ["wrong", "ENG-99: Other"],
    ];
    const prepared = await resolveAppIssueLink({
      ...OPTIONS,
      fields: { issueId: "linear-uuid" },
    });
    expect(prepared.fields).toEqual({ issueId: "linear-uuid" });
    await expect(
      resolveAppIssueLink({
        ...OPTIONS,
        fields: { issueId: "wrong" },
      })
    ).rejects.toThrow("conflicts");
    expect(writes()).toHaveLength(0);
  });

  test.each([
    "ENG-42",
    "ENG-99",
  ])("uses Linear choice ID %s before the label's key", async (id) => {
    choices = [
      [
        id,
        id === "ENG-42"
          ? "ENG-99 mentioned in title"
          : "ENG-42 misleading label",
      ],
    ];
    const result = resolveAppIssueLink({ ...OPTIONS, fields: { issueId: id } });
    if (id === "ENG-42") {
      expect((await result).fields).toEqual({ issueId: id });
    } else {
      await expect(result).rejects.toThrow("conflicts");
    }
    expect(writes()).toHaveLength(0);
  });

  test("keeps the query guard separate from an app field with the same name", async () => {
    form = {
      ...FORM,
      optional_fields: [{ name: "expectedExternalIssueUrl", type: "text" }],
    };
    const prepared = await resolveAppIssueLink({
      ...OPTIONS,
      fields: { expectedExternalIssueUrl: "provider-field" },
    });
    await linkAppIssue(prepared);
    expect(
      new globalThis.URL(writes()[0]!.url).searchParams.get(
        "expectedExternalIssueUrl"
      )
    ).toBe(URL);
    expect(await writes()[0]?.json()).toMatchObject({
      expectedExternalIssueUrl: "provider-field",
    });
  });

  test("resolves dependent choices using validated field values", async () => {
    form = {
      ...FORM,
      required_fields: [
        { ...FORM.required_fields[0], depends_on: ["team"] },
        {
          name: "team",
          type: "select",
          choices: [["team-uuid", "Engineering"]],
        },
      ],
    };
    const prepared = await resolveAppIssueLink({
      ...OPTIONS,
      fields: { team: "Engineering" },
    });
    expect(prepared.fields).toEqual({
      team: "team-uuid",
      issueId: "linear-uuid",
    });
    const search = calls.find((request) =>
      request.url.includes("external-requests")
    );
    expect(
      new globalThis.URL(search?.url ?? "").searchParams.get("dependentData")
    ).toBe('{"team":"team-uuid"}');
  });

  test("resolves a required dependency from the App's remote default", async () => {
    form = {
      ...FORM,
      required_fields: [{ ...FORM.required_fields[0], depends_on: ["team"] }],
      optional_fields: [{ name: "team", type: "select", uri: "/teams" }],
    };
    const defaultFetch = globalThis.fetch;
    globalThis.fetch = mockFetch((input, init) => {
      const request = new Request(input, init);
      const query = new globalThis.URL(request.url).searchParams;
      if (query.get("uri") === "/teams") {
        calls.push(request);
        expect(query.has("query")).toBe(false);
        return Promise.resolve(
          json({
            choices: [["team-uuid", "Engineering"]],
            defaultValue: "team-uuid",
          })
        );
      }
      return defaultFetch(input, init);
    });
    const prepared = await resolveAppIssueLink(OPTIONS);
    expect(prepared.fields).toEqual({
      team: "team-uuid",
      issueId: "linear-uuid",
    });
    const search = calls.find((request) =>
      new globalThis.URL(request.url).searchParams.has("dependentData")
    );
    expect(
      new globalThis.URL(search!.url).searchParams.get("dependentData")
    ).toBe('{"team":"team-uuid"}');
  });

  test.each([
    { defaultValue: "", fields: undefined },
    { defaultValue: "preset", fields: { note: "" } },
  ])("omits empty optional fields ($defaultValue)", async ({
    defaultValue,
    fields,
  }) => {
    form = {
      ...FORM,
      optional_fields: [{ name: "note", type: "text", defaultValue }],
    };
    expect((await resolveAppIssueLink({ ...OPTIONS, fields })).fields).toEqual({
      issueId: "linear-uuid",
    });
  });

  test("reports required fields rather than sending a partial form", async () => {
    form = {
      ...FORM,
      required_fields: [
        ...FORM.required_fields,
        { name: "team", type: "text" },
      ],
    };
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "--field team=VALUE"
    );
    expect(writes()).toHaveLength(0);
  });

  test.each([
    undefined,
    { team: "" },
  ])("requires missing or empty dependencies (%j)", async (fields) => {
    form = {
      ...FORM,
      required_fields: [
        { ...FORM.required_fields[0], depends_on: ["team"] },
        { name: "team", type: "text" },
      ],
    };
    await expect(resolveAppIssueLink({ ...OPTIONS, fields })).rejects.toThrow(
      "Missing app link fields: --field team=VALUE"
    );
    expect(
      calls.some((request) => request.url.includes("external-requests"))
    ).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  test("distinguishes actual dependency cycles from missing values", async () => {
    form = {
      ...FORM,
      required_fields: [
        { ...FORM.required_fields[0], depends_on: ["team"] },
        { name: "team", type: "text", depends_on: ["issueId"] },
      ],
    };
    await expect(
      resolveAppIssueLink({
        ...OPTIONS,
        fields: { team: "Engineering", issueId: "ENG-42" },
      })
    ).rejects.toThrow("App link fields have circular dependencies");
    expect(writes()).toHaveLength(0);
  });

  test("accepts numeric labels in the app's static select options", async () => {
    form = {
      ...FORM,
      required_fields: [
        ...FORM.required_fields,
        { name: "team", type: "select", options: [["team-uuid", 42]] },
      ],
    };
    const prepared = await resolveAppIssueLink({
      ...OPTIONS,
      fields: { team: "42" },
    });
    expect(prepared.fields).toEqual({
      team: "team-uuid",
      issueId: "linear-uuid",
    });
    expect(writes()).toHaveLength(0);
  });
});

describe("list and match app associations", () => {
  test("follows cursor pages and never uses a pagination URL as a request target", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (new globalThis.URL(request.url).searchParams.has("cursor")) {
        return json([{ ...LINK, id: "100", serviceType: "another-app" }]);
      }
      return json([LINK], 200, {
        Link: '<https://untrusted.invalid/>; rel="next"; results="true"; cursor="next-page"',
      });
    });
    expect(await listAppIssueLinks(ORG, ISSUE)).toHaveLength(2);
    expect(calls[1]?.url).toContain(
      "https://de.sentry.io/api/0/organizations/example-org/issues/123/external-issues/?cursor=next-page"
    );
  });

  test("fails on cursor loops instead of returning incomplete links", async () => {
    globalThis.fetch = mockFetch(async () =>
      json([LINK], 200, {
        Link: '<https://sentry.io/>; rel="next"; results="true"; cursor="same"',
      })
    );
    await expect(listAppIssueLinks(ORG, ISSUE)).rejects.toThrow(
      "repeated a cursor"
    );
  });

  test("matches generic URLs and refuses ambiguity across apps", () => {
    const link = {
      ...LINK,
      webUrl: "https://tracker.example/issues/42/",
      serviceType: "custom",
    };
    expect(findAppIssueLink([link], "https://tracker.example/issues/42")).toBe(
      link
    );
    expect(() =>
      findAppIssueLink(
        [link, { ...link, serviceType: "other" }],
        "https://tracker.example/issues/42"
      )
    ).toThrow(ValidationError);
    expect(
      findAppIssueLink([link], "https://tracker.example/issues/42", "other")
    ).toBeUndefined();
  });

  test.each([
    "invalid",
    "https://linear.app/example/settings",
    "javascript:alert(1)",
  ])("ignores malformed stored sibling %s when matching a valid target", (webUrl) => {
    const sibling = { ...LINK, id: "100", webUrl };
    expect(findAppIssueLink([sibling, LINK], URL)).toBe(LINK);
    expect(() => findAppIssueLink([LINK], webUrl)).toThrow(ValidationError);
  });

  test("still refuses replacement of a corrupt link belonging to the selected app", async () => {
    links = [{ ...LINK, webUrl: "invalid" }];
    await expect(resolveAppIssueLink(OPTIONS)).rejects.toThrow(
      "Unlink it before"
    );
    expect(writes()).toHaveLength(0);
  });

  test("keeps query and fragment identifiers distinct for generic apps", () => {
    const link = {
      ...LINK,
      serviceType: "custom",
      webUrl: "https://tracker.example/view?id=1#issue/42",
    };
    expect(findAppIssueLink([link], link.webUrl, "custom")).toBe(link);
    expect(
      findAppIssueLink(
        [link],
        "https://tracker.example/view?id=2#issue/42",
        "custom"
      )
    ).toBeUndefined();
    expect(
      findAppIssueLink(
        [link],
        "https://tracker.example/view?id=1#issue/43",
        "custom"
      )
    ).toBeUndefined();
  });
});
