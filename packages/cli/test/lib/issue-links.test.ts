/** Exercise provider routing, dry runs and association-only mutation outcomes. */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  linkAppIssue,
  resolveAppIssueLink,
} from "../../src/lib/api/issue-app-links.js";
import {
  linkNativeIssue,
  resolveNativeIssueLink,
} from "../../src/lib/api/issue-integrations.js";
import { ApiError } from "../../src/lib/errors.js";
import { linkExternalIssue } from "../../src/lib/issue-links.js";
import { invalidateCachedResponsesMatching } from "../../src/lib/response-cache.js";

vi.mock("../../src/lib/api/issue-app-links.js");
vi.mock("../../src/lib/api/issue-integrations.js");
vi.mock("../../src/lib/response-cache.js");
vi.mock("../../src/lib/region.js", () => ({
  resolveOrgRegion: vi.fn().mockResolvedValue("https://de.sentry.io"),
}));
vi.mock("../../src/lib/sentry-client.js", () => ({
  getApiBaseUrl: () => "https://sentry.io",
}));

const nativeLink = {
  id: "810",
  integrationId: "20",
  provider: "github",
  key: "example/app#42",
  displayName: "example/app#42",
  url: "https://github.com/example/app/issues/42",
};
const appLink = {
  id: "910",
  issueId: "123",
  serviceType: "linear",
  displayName: "APP-42",
  webUrl: "https://linear.app/example/issue/APP-42/fix-error",
};
const options = {
  orgSlug: "example",
  issueId: "123",
  url: nativeLink.url,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveNativeIssueLink).mockResolvedValue({
    ...options,
    regionUrl: "https://de.sentry.io",
    integrationId: nativeLink.integrationId,
    provider: nativeLink.provider,
  });
  vi.mocked(linkNativeIssue).mockResolvedValue({
    link: nativeLink,
    changed: true,
  });
  vi.mocked(resolveAppIssueLink).mockResolvedValue({
    ...options,
    url: appLink.webUrl,
    appSlug: "linear",
    installationUuid: "installation",
    uri: "/link",
    fields: { issueId: "remote-uuid" },
  });
  vi.mocked(linkAppIssue).mockResolvedValue({ link: appLink, changed: true });
});

describe("external issue associations", () => {
  test("native link returns the internal association ID and invalidates issue views", async () => {
    const result = await linkExternalIssue(options);
    expect(result).toMatchObject({
      action: "link",
      changed: true,
      linked: true,
      externalIssue: { id: "810", identifier: "example/app#42" },
    });
    expect(resolveAppIssueLink).not.toHaveBeenCalled();
    expect(invalidateCachedResponsesMatching).toHaveBeenCalledWith(
      "https://de.sentry.io/api/0/organizations/example/issues/123/"
    );
    expect(invalidateCachedResponsesMatching).toHaveBeenCalledWith(
      "https://sentry.io/api/0/issues/123/"
    );
  });

  test("Linear routes through the app workflow with project context", async () => {
    const appOptions = { ...options, url: appLink.webUrl, projectId: "456" };
    const result = await linkExternalIssue(appOptions);
    expect(resolveAppIssueLink).toHaveBeenCalledWith(appOptions);
    expect(linkNativeIssue).not.toHaveBeenCalled();
    expect(result.externalIssue).toEqual({
      id: appLink.id,
      identifier: "APP-42",
      url: appLink.webUrl,
      provider: "linear",
    });
  });

  test("an explicitly selected app accepts a non-Linear resource URL", async () => {
    await linkExternalIssue({ ...options, appSlug: "custom-tracker" });
    expect(resolveAppIssueLink).toHaveBeenCalledWith(
      expect.objectContaining({
        appSlug: "custom-tracker",
        url: nativeLink.url,
      })
    );
    expect(resolveNativeIssueLink).not.toHaveBeenCalled();
  });

  test.each([
    nativeLink.url,
    appLink.webUrl,
  ])("dry-run link submits no mutation: %s", async (url) => {
    const result = await linkExternalIssue({ ...options, url, dryRun: true });
    expect(result).toMatchObject({
      linked: false,
      changed: false,
      dryRun: true,
    });
    expect(linkNativeIssue).not.toHaveBeenCalled();
    expect(linkAppIssue).not.toHaveBeenCalled();
    expect(invalidateCachedResponsesMatching).not.toHaveBeenCalled();
  });

  test("dry-run link describes an existing app association", async () => {
    vi.mocked(resolveAppIssueLink).mockResolvedValue({
      ...options,
      url: appLink.webUrl,
      appSlug: "linear",
      installationUuid: "installation",
      uri: "/link",
      fields: { issueId: "remote-uuid" },
      existing: appLink,
    });
    const result = await linkExternalIssue({
      ...options,
      url: appLink.webUrl,
      dryRun: true,
    });
    expect(result).toMatchObject({ linked: true, changed: false });
    expect(result.externalIssue).toEqual({
      id: appLink.id,
      identifier: appLink.displayName,
      url: appLink.webUrl,
      provider: "linear",
    });
  });

  test("already-linked is a successful no-op, with no cache mutation", async () => {
    vi.mocked(linkNativeIssue).mockResolvedValue({
      link: nativeLink,
      changed: false,
    });
    const result = await linkExternalIssue(options);
    expect(result).toMatchObject({ linked: true, changed: false });
    expect(invalidateCachedResponsesMatching).not.toHaveBeenCalled();
  });

  test("a failed write propagates without claiming success or falling back to another provider", async () => {
    const error = new ApiError("Forbidden", 403);
    vi.mocked(linkNativeIssue).mockRejectedValue(error);
    await expect(linkExternalIssue(options)).rejects.toBe(error);
    expect(linkNativeIssue).toHaveBeenCalledTimes(1);
    expect(linkAppIssue).not.toHaveBeenCalled();
    expect(invalidateCachedResponsesMatching).not.toHaveBeenCalled();
  });

  test.each([
    "not-a-url",
    "file:///tmp/issue",
    "https://user:secret@example.com/issue/42",
  ])("invalid targets fail before API calls: %s", async (url) => {
    await expect(linkExternalIssue({ ...options, url })).rejects.toThrow();
    expect(resolveNativeIssueLink).not.toHaveBeenCalled();
    expect(resolveAppIssueLink).not.toHaveBeenCalled();
  });

  test("conflicting native and app selectors fail before API calls", async () => {
    await expect(
      linkExternalIssue({
        ...options,
        appSlug: "linear",
        integrationId: "20",
      })
    ).rejects.toThrow("--integration");
    expect(resolveAppIssueLink).not.toHaveBeenCalled();
  });
});
