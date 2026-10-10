/**
 * Event View Command Tests
 *
 * Tests for positional argument parsing, project resolution,
 * and viewCommand func() body in src/commands/event/view.ts
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  collectEventIds,
  expandNewlineArgs,
  fetchEventWithContext,
  fetchMultipleEvents,
  formatEventView,
  jsonTransformEventView,
  parsePositionalArgs,
  resolveAutoDetectTarget,
  resolveEventTarget,
  resolveOrgAllTarget,
  viewCommand,
} from "../../../src/commands/event/view.js";
import type { ProjectWithOrg } from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as apiClient from "../../../src/lib/api-client.js";
import { ProjectSpecificationType } from "../../../src/lib/arg-parsing.js";

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  ApiError,
  AuthError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { resolveProjectBoundSlug } from "../../../src/lib/resolve-target.js";

vi.mock("../../../src/lib/span-tree.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/span-tree.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as spanTree from "../../../src/lib/span-tree.js";
import type { SentryEvent } from "../../../src/types/index.js";

describe("parsePositionalArgs", () => {
  describe("single argument (event ID only)", () => {
    test("parses single arg as event ID", () => {
      const result = parsePositionalArgs(["abc123def456"]);
      expect(result.eventId).toBe("abc123def456");
      expect(result.targetArg).toBeUndefined();
    });

    test("parses UUID-like event ID", () => {
      const result = parsePositionalArgs([
        "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      ]);
      expect(result.eventId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      expect(result.targetArg).toBeUndefined();
    });

    test("parses short event ID", () => {
      const result = parsePositionalArgs(["abc"]);
      expect(result.eventId).toBe("abc");
      expect(result.targetArg).toBeUndefined();
    });

    test("detects issue short ID and sets issueShortId", () => {
      const result = parsePositionalArgs(["BRUNCHIE-APP-29"]);
      expect(result.eventId).toBe("@latest");
      expect(result.targetArg).toBeUndefined();
      expect(result.issueShortId).toBe("BRUNCHIE-APP-29");
    });

    test("detects short issue ID like CLI-G", () => {
      const result = parsePositionalArgs(["CLI-G"]);
      expect(result.eventId).toBe("@latest");
      expect(result.issueShortId).toBe("CLI-G");
    });

    test("does not detect lowercase slug as issue short ID", () => {
      const result = parsePositionalArgs(["my-project"]);
      expect(result.eventId).toBe("my-project");
      expect(result.issueShortId).toBeUndefined();
    });

    test("detects org/ISSUE-SHORT-ID pattern (CLI-9K)", () => {
      const result = parsePositionalArgs(["figma/FULLSCREEN-2RN"]);
      expect(result.eventId).toBe("@latest");
      // Trailing slash signals OrgAll mode so downstream resolves org correctly
      expect(result.targetArg).toBe("figma/");
      expect(result.issueShortId).toBe("FULLSCREEN-2RN");
    });

    test("detects org/CLI-G pattern", () => {
      const result = parsePositionalArgs(["sentry/CLI-G"]);
      expect(result.eventId).toBe("@latest");
      expect(result.targetArg).toBe("sentry/");
      expect(result.issueShortId).toBe("CLI-G");
    });

    test("detects SHORT-ID/EVENT-ID pattern (CLI-HV)", () => {
      const result = parsePositionalArgs([
        "CLI-G5/abc123def456abc123def456abc123de",
      ]);
      expect(result.eventId).toBe("abc123def456abc123def456abc123de");
      expect(result.targetArg).toBeUndefined();
      expect(result.issueShortId).toBe("CLI-G5");
    });

    test("detects multi-dash SHORT-ID/EVENT-ID pattern", () => {
      const result = parsePositionalArgs([
        "PHP-SYMFONY-HY/7388f6a62b7d436ab77bb5365f97a1ac",
      ]);
      expect(result.eventId).toBe("7388f6a62b7d436ab77bb5365f97a1ac");
      expect(result.targetArg).toBeUndefined();
      expect(result.issueShortId).toBe("PHP-SYMFONY-HY");
    });

    test("normalizes UUID-format event ID in SHORT-ID/EVENT-ID", () => {
      const result = parsePositionalArgs([
        "CLI-G5/7388f6a6-2b7d-436a-b77b-b5365f97a1ac",
      ]);
      expect(result.eventId).toBe("7388f6a62b7d436ab77bb5365f97a1ac");
      expect(result.issueShortId).toBe("CLI-G5");
    });

    test("org/SHORT-ID takes precedence over SHORT-ID/EVENT-ID", () => {
      // "figma/FULLSCREEN-2RN" → org + issue, not issue + event
      const result = parsePositionalArgs(["figma/FULLSCREEN-2RN"]);
      expect(result.eventId).toBe("@latest");
      expect(result.targetArg).toBe("figma/");
      expect(result.issueShortId).toBe("FULLSCREEN-2RN");
    });

    test("does not detect org/lowercase-slug as issue short ID", () => {
      // "my-org/my-project" is a normal org/project target, not an issue short ID.
      // parseSlashSeparatedArg will throw ContextError as expected.
      expect(() => parsePositionalArgs(["my-org/my-project"])).toThrow(
        "Event ID",
      );
    });
  });

  describe("two arguments (target + event ID)", () => {
    test("parses org/project target and event ID", () => {
      const result = parsePositionalArgs(["my-org/frontend", "abc123def456"]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.eventId).toBe("abc123def456");
    });

    test("parses project-only target and event ID", () => {
      const result = parsePositionalArgs(["frontend", "abc123def456"]);
      expect(result.targetArg).toBe("frontend");
      expect(result.eventId).toBe("abc123def456");
    });

    test("parses org/ target (all projects) and event ID", () => {
      const result = parsePositionalArgs(["my-org/", "abc123def456"]);
      expect(result.targetArg).toBe("my-org/");
      expect(result.eventId).toBe("abc123def456");
    });

    test("auto-redirects issue short ID in first arg to issueShortId (CLI-MP)", () => {
      // "JAVASCRIPT-NUXT-52" matches looksLikeIssueShortId → redirect to issue's
      // latest event instead of treating it as a project slug (which would fail).
      const result = parsePositionalArgs([
        "JAVASCRIPT-NUXT-52",
        "abc123def456",
      ]);
      expect(result.issueShortId).toBe("JAVASCRIPT-NUXT-52");
      expect(result.eventId).toBe("@latest");
      expect(result.targetArg).toBeUndefined();
      expect(result.warning).toContain("issue short ID");
    });

    test("auto-redirects simple issue short ID like CAM-82X", () => {
      const result = parsePositionalArgs(["CAM-82X", "95fd7f5a"]);
      expect(result.issueShortId).toBe("CAM-82X");
      expect(result.eventId).toBe("@latest");
      expect(result.targetArg).toBeUndefined();
      expect(result.warning).toContain("issue short ID");
    });
  });

  describe("error cases", () => {
    test("throws ContextError for empty args", () => {
      expect(() => parsePositionalArgs([])).toThrow(ContextError);
    });

    test("throws ContextError with usage hint", () => {
      try {
        parsePositionalArgs([]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Event ID");
      }
    });
  });

  describe("numeric issue IDs and bare 'latest'", () => {
    test("bare numeric ID maps to issueId + latest sentinel", () => {
      const result = parsePositionalArgs(["17370"]);
      expect(result.eventId).toBe("@latest");
      expect(result.issueId).toBe("17370");
      expect(result.targetArg).toBeUndefined();
    });

    test("org/numeric-ID maps to org-all target + issueId (CLI-1F5)", () => {
      const result = parsePositionalArgs(["my-org/17370"]);
      expect(result.eventId).toBe("@latest");
      expect(result.issueId).toBe("17370");
      // Trailing slash signals org-all so the org resolves downstream.
      expect(result.targetArg).toBe("my-org/");
    });

    test("org/project + numeric second arg maps to issueId", () => {
      const result = parsePositionalArgs(["my-org/frontend", "17370"]);
      expect(result.eventId).toBe("@latest");
      expect(result.issueId).toBe("17370");
      expect(result.targetArg).toBe("my-org/frontend");
    });

    test("bare 'latest' (single arg) throws ContextError", () => {
      expect(() => parsePositionalArgs(["latest"])).toThrow(ContextError);
    });

    test("'latest' as second arg throws ContextError", () => {
      expect(() => parsePositionalArgs(["my-org/frontend", "latest"])).toThrow(
        ContextError,
      );
    });

    test("bare 'latest' error mentions Issue ID", () => {
      try {
        parsePositionalArgs(["latest"]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Issue ID");
      }
    });

    test("'LATEST' is case-insensitive", () => {
      expect(() => parsePositionalArgs(["LATEST"])).toThrow(ContextError);
    });
  });

  describe("slash-separated org/project/eventId (single arg)", () => {
    test("parses org/project/eventId as target + event ID", () => {
      const result = parsePositionalArgs(["sentry/cli/abc123def"]);
      expect(result.targetArg).toBe("sentry/cli");
      expect(result.eventId).toBe("abc123def");
    });

    test("parses with long hex event ID", () => {
      const result = parsePositionalArgs([
        "my-org/frontend/a1b2c3d4e5f67890abcdef1234567890",
      ]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.eventId).toBe("a1b2c3d4e5f67890abcdef1234567890");
    });

    test("handles hyphenated org and project slugs", () => {
      const result = parsePositionalArgs(["my-org/my-project/deadbeef"]);
      expect(result.targetArg).toBe("my-org/my-project");
      expect(result.eventId).toBe("deadbeef");
    });

    test("one slash (org/project, missing event ID) throws ContextError", () => {
      expect(() => parsePositionalArgs(["sentry/cli"])).toThrow(ContextError);
    });

    test("trailing slash (org/project/) throws ContextError", () => {
      expect(() => parsePositionalArgs(["sentry/cli/"])).toThrow(ContextError);
    });

    test("one-slash ContextError mentions Event ID", () => {
      try {
        parsePositionalArgs(["sentry/cli"]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Event ID");
      }
    });
  });

  describe("edge cases", () => {
    test("collects extra args as additional event IDs", () => {
      const result = parsePositionalArgs([
        "my-org/frontend",
        "abc123",
        "extra-arg",
      ]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.eventId).toBe("abc123");
      expect(result.extraEventIds).toEqual(["extra-arg"]);
    });

    test("handles empty string event ID in two-arg case", () => {
      const result = parsePositionalArgs(["my-org/frontend", ""]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.eventId).toBe("");
    });
  });

  describe("newline-separated IDs (CLI-1HT)", () => {
    test("expands newline-separated IDs from single structured arg", () => {
      const multiLineArg =
        "perzimo/perzimo-server/189945b37884462cb9134bd5cabeaa3d\n60c277e6c73f41c58ca46231b46dc0f8\n722e1158dfa147ec90ed831c4d096ae7";
      const expanded = expandNewlineArgs([multiLineArg]);
      expect(expanded).toEqual([
        "perzimo/perzimo-server/189945b37884462cb9134bd5cabeaa3d",
        "60c277e6c73f41c58ca46231b46dc0f8",
        "722e1158dfa147ec90ed831c4d096ae7",
      ]);

      // First arg has 2+ slashes → routed through single-arg path to correctly
      // extract org/project and first event ID, remaining become extraEventIds.
      const result = parsePositionalArgs(expanded);
      expect(result.targetArg).toBe("perzimo/perzimo-server");
      expect(result.eventId).toBe("189945b37884462cb9134bd5cabeaa3d");
      expect(result.extraEventIds).toEqual([
        "60c277e6c73f41c58ca46231b46dc0f8",
        "722e1158dfa147ec90ed831c4d096ae7",
      ]);
    });

    test("single arg with newlines goes through single-arg path after expansion", () => {
      // When there's only one line (no newlines), single-arg path works normally
      const result = parsePositionalArgs([
        "perzimo/perzimo-server/189945b37884462cb9134bd5cabeaa3d",
      ]);
      expect(result.eventId).toBe("189945b37884462cb9134bd5cabeaa3d");
      expect(result.targetArg).toBe("perzimo/perzimo-server");
      expect(result.extraEventIds).toBeUndefined();
    });

    test("first arg with 2+ slashes routes through single-arg path and collects extras", () => {
      // Simulates expanded "org/project/id1\nid2\nid3" → 3 args
      const result = parsePositionalArgs([
        "perzimo/perzimo-server/189945b37884462cb9134bd5cabeaa3d",
        "60c277e6c73f41c58ca46231b46dc0f8",
        "722e1158dfa147ec90ed831c4d096ae7",
      ]);
      expect(result.eventId).toBe("189945b37884462cb9134bd5cabeaa3d");
      expect(result.targetArg).toBe("perzimo/perzimo-server");
      expect(result.extraEventIds).toEqual([
        "60c277e6c73f41c58ca46231b46dc0f8",
        "722e1158dfa147ec90ed831c4d096ae7",
      ]);
    });

    test("collects multiple extra event IDs", () => {
      const result = parsePositionalArgs([
        "my-org/frontend",
        "abc123",
        "def456",
        "789abc",
      ]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.eventId).toBe("abc123");
      expect(result.extraEventIds).toEqual(["def456", "789abc"]);
    });

    test("no extra IDs when only two args", () => {
      const result = parsePositionalArgs(["my-org/frontend", "abc123"]);
      expect(result.extraEventIds).toBeUndefined();
    });
  });

  // URL integration tests — applySentryUrlContext may set SENTRY_HOST/SENTRY_URL as a side effect.
  // Host-scoping: self-hosted URLs now require the token to be scoped to the
  // same host. Tests seed SENTRY_HOST before parsing so env-token-host matches.
  describe("Sentry URL inputs", () => {
    let savedSentryUrl: string | undefined;
    let savedSentryHost: string | undefined;

    beforeEach(async () => {
      savedSentryUrl = process.env.SENTRY_URL;
      savedSentryHost = process.env.SENTRY_HOST;
      delete process.env.SENTRY_URL;
      delete process.env.SENTRY_HOST;
      const { resetEnvTokenHostForTesting } =
        await import("../../../src/lib/env-token-host.js");
      resetEnvTokenHostForTesting();
    });

    afterEach(async () => {
      if (savedSentryUrl !== undefined) {
        process.env.SENTRY_URL = savedSentryUrl;
      } else {
        delete process.env.SENTRY_URL;
      }
      if (savedSentryHost !== undefined) {
        process.env.SENTRY_HOST = savedSentryHost;
      } else {
        delete process.env.SENTRY_HOST;
      }
      const { resetEnvTokenHostForTesting } =
        await import("../../../src/lib/env-token-host.js");
      resetEnvTokenHostForTesting();
    });

    test("event URL extracts eventId and passes org as OrgAll target", () => {
      const result = parsePositionalArgs([
        "https://sentry.io/organizations/my-org/issues/32886/events/abc123def456/",
      ]);
      expect(result.eventId).toBe("abc123def456");
      expect(result.targetArg).toBe("my-org/");
    });

    test("self-hosted event URL extracts eventId, passes org, sets SENTRY_URL (requires matching token host)", () => {
      process.env.SENTRY_HOST = "https://sentry.example.com";
      const result = parsePositionalArgs([
        "https://sentry.example.com/organizations/acme/issues/999/events/deadbeef/",
      ]);
      expect(result.eventId).toBe("deadbeef");
      expect(result.targetArg).toBe("acme/");
      expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");
    });

    test("issue URL without event ID returns issueId for latest event fetch", () => {
      const result = parsePositionalArgs([
        "https://sentry.io/organizations/my-org/issues/32886/",
      ]);
      expect(result.issueId).toBe("32886");
      expect(result.eventId).toBe("@latest");
      expect(result.targetArg).toBe("my-org/");
    });

    test("org-only URL throws ContextError", () => {
      expect(() =>
        parsePositionalArgs(["https://sentry.io/organizations/my-org/"]),
      ).toThrow(ContextError);
    });
  });
});

describe("resolveProjectBoundSlug", () => {
  const HINT = "sentry event view <org>/<project> <event-id>";
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let listProjectsSpy: ReturnType<typeof spyOn>;
  let getProjectSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    listProjectsSpy = vi.spyOn(apiClient, "listProjects");
    getProjectSpy = vi.spyOn(apiClient, "getProject");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
    listProjectsSpy.mockRestore();
    getProjectSpy.mockRestore();
  });

  describe("no projects found", () => {
    test("throws ResolutionError when project not found", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      await expect(resolveProjectBoundSlug("my-project", HINT)).rejects.toThrow(
        ResolutionError,
      );
    });

    test("includes project name in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      try {
        await resolveProjectBoundSlug("frontend", HINT);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        expect((error as ResolutionError).message).toContain(
          'Project "frontend"',
        );
        expect((error as ResolutionError).message).toContain(
          "Check that you have access",
        );
        // Message says "not found", not "is required"
        expect((error as ResolutionError).message).toContain("not found");
      }
    });
  });

  test("throws ResolutionError with org hint when slug matches an organization", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme-corp", name: "Acme Corp" }],
    });

    try {
      await resolveProjectBoundSlug("acme-corp", HINT);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("is an organization, not a project");
      expect(msg).toContain("acme-corp/<project>");
    }
  });

  test("org hint replaces <org>/<project> placeholder, not slug in command name", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "sentry", name: "Sentry" }],
    });

    try {
      await resolveProjectBoundSlug("sentry", HINT);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      // Should substitute the <org>/<project> placeholder, not the "sentry" in the command name
      expect(msg).toContain("sentry event view sentry/<project>");
      // "sentry" command prefix should still be intact
      expect(msg).not.toContain("sentry/<project> event view");
    }
  });

  test("fetches full project data after fuzzy recovery", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme", name: "Acme" }],
    });
    listProjectsSpy.mockResolvedValue([
      { id: "1", slug: "app-frontend", name: "App Frontend" },
    ]);
    getProjectSpy.mockResolvedValue({
      id: "1",
      slug: "app-frontend",
      name: "App Frontend",
      platform: "javascript",
    });

    const result = await resolveProjectBoundSlug("app-front", HINT);

    expect(getProjectSpy).toHaveBeenCalledWith("acme", "app-frontend");
    expect(result.projectData.platform).toBe("javascript");
  });

  describe("multiple projects found", () => {
    test("throws ValidationError when project exists in multiple orgs", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "frontend", orgSlug: "org-a", id: "1", name: "Frontend" },
          { slug: "frontend", orgSlug: "org-b", id: "2", name: "Frontend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      await expect(resolveProjectBoundSlug("frontend", HINT)).rejects.toThrow(
        ValidationError,
      );
    });

    test("includes all orgs in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "frontend", orgSlug: "acme-corp", id: "1", name: "Frontend" },
          { slug: "frontend", orgSlug: "beta-inc", id: "2", name: "Frontend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      try {
        await resolveProjectBoundSlug(
          "frontend",
          HINT,
          "sentry event view <org>/frontend event-456",
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const message = (error as ValidationError).message;
        expect(message).toContain("exists in multiple organizations");
        expect(message).toContain("acme-corp/frontend");
        expect(message).toContain("beta-inc/frontend");
        expect(message).toContain("event-456");
      }
    });

    test("includes usage example in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "api", orgSlug: "org-1", id: "1", name: "API" },
          { slug: "api", orgSlug: "org-2", id: "2", name: "API" },
          { slug: "api", orgSlug: "org-3", id: "3", name: "API" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      try {
        await resolveProjectBoundSlug(
          "api",
          HINT,
          "sentry event view <org>/api abc123",
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const message = (error as ValidationError).message;
        expect(message).toContain(
          "Example: sentry event view <org>/api abc123",
        );
      }
    });
  });

  describe("single project found", () => {
    test("returns resolved target for single match", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "backend", orgSlug: "my-company", id: "42", name: "Backend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("backend", HINT);

      expect(result).toMatchObject({
        org: "my-company",
        project: "backend",
      });
      expect(result.projectData).toBeDefined();
    });

    test("uses orgSlug from project result", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "mobile-app",
            orgSlug: "acme-industries",
            id: "100",
            name: "Mobile App",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("mobile-app", HINT);

      expect(result.org).toBe("acme-industries");
    });

    test("preserves project slug in result", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "web-frontend",
            orgSlug: "org",
            id: "1",
            name: "Web Frontend",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("web-frontend", HINT);

      expect(result.project).toBe("web-frontend");
    });
  });

  describe("numeric project ID", () => {
    test("uses numeric-ID-specific error when not found", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      try {
        await resolveProjectBoundSlug("7275560680", HINT);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        const message = (error as ResolutionError).message;
        expect(message).toContain('Project "7275560680"');
        expect(message).toContain("No project with this ID was found");
        // Message says "not found", not "is required"
        expect(message).toContain("not found");
      }
    });

    test("resolves numeric ID to correct slug", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "my-frontend",
            orgSlug: "acme",
            id: "7275560680",
            name: "Frontend",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("7275560680", HINT);
      expect(result).toMatchObject({ org: "acme", project: "my-frontend" });
      expect(result.projectData).toBeDefined();
    });
  });
});

describe("resolveEventTarget", () => {
  let resolveEventInOrgSpy: ReturnType<typeof spyOn>;
  let findEventAcrossOrgsSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;
  let resolveProjectBoundSlugSpy: ReturnType<typeof spyOn>;
  let setTagSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    resolveEventInOrgSpy = vi.spyOn(apiClient, "resolveEventInOrg");
    findEventAcrossOrgsSpy = vi.spyOn(apiClient, "findEventAcrossOrgs");
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    resolveProjectBoundSlugSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundSlug",
    );
    setTagSpy = vi.spyOn(Sentry, "setTag");
    setOrgRegion("acme", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    resolveEventInOrgSpy.mockRestore();
    findEventAcrossOrgsSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
    resolveProjectBoundSlugSpy.mockRestore();
    setTagSpy.mockRestore();
  });

  test("returns explicit target directly", async () => {
    const result = await resolveEventTarget({
      parsed: {
        type: ProjectSpecificationType.Explicit,
        org: "acme",
        project: "cli",
      },
      eventId: "abc123",
      cwd: "/tmp",
    });

    expect(result).toEqual({
      org: "acme",
      project: "cli",
      orgDisplay: "acme",
      projectDisplay: "cli",
    });
  });

  test("resolves project search via resolveProjectBoundSlug", async () => {
    resolveProjectBoundSlugSpy.mockResolvedValue({
      org: "acme",
      project: "frontend",
    });

    const result = await resolveEventTarget({
      parsed: {
        type: ProjectSpecificationType.ProjectSearch,
        projectSlug: "frontend",
      },
      eventId: "abc123",
      cwd: "/tmp",
    });

    expect(result).toEqual({
      org: "acme",
      project: "frontend",
      orgDisplay: "acme",
      projectDisplay: "frontend",
    });
  });

  test("delegates OrgAll to resolveOrgAllTarget", async () => {
    resolveEventInOrgSpy.mockResolvedValue({
      org: "acme",
      project: "backend",
      event: { eventID: "abc123" },
    });

    const result = await resolveEventTarget({
      parsed: { type: ProjectSpecificationType.OrgAll, org: "acme" },
      eventId: "abc123",
      cwd: "/tmp",
    });

    expect(result?.org).toBe("acme");
    expect(result?.project).toBe("backend");
    expect(result?.prefetchedEvent).toBeDefined();
    expect(setTagSpy).toHaveBeenCalledWith("sentry.org", "acme");
    expect(setTagSpy).toHaveBeenCalledWith("sentry.project", "backend");
  });

  test("delegates AutoDetect to resolveAutoDetectTarget", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "acme",
      project: "cli",
      orgDisplay: "acme",
      projectDisplay: "cli",
    });

    const result = await resolveEventTarget({
      parsed: { type: ProjectSpecificationType.AutoDetect },
      eventId: "abc123",
      cwd: "/tmp",
    });

    expect(result?.org).toBe("acme");
  });

  test("returns null for unknown parsed type", async () => {
    const result = await resolveEventTarget({
      parsed: { type: "unknown" as any },
      eventId: "abc123",
      cwd: "/tmp",
    });

    expect(result).toBeNull();
  });
});

describe("resolveOrgAllTarget", () => {
  let resolveEventInOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveEventInOrgSpy = vi.spyOn(apiClient, "resolveEventInOrg");
  });

  afterEach(() => {
    resolveEventInOrgSpy.mockRestore();
  });

  test("returns resolved target when event found in org", async () => {
    resolveEventInOrgSpy.mockResolvedValue({
      org: "acme",
      project: "frontend",
      event: { eventID: "abc123" },
    });

    const result = await resolveOrgAllTarget("acme", "abc123", "/tmp");

    expect(result).not.toBeNull();
    expect(result?.org).toBe("acme");
    expect(result?.project).toBe("frontend");
    expect(result?.prefetchedEvent?.eventID).toBe("abc123");
  });

  test("throws ResolutionError when event not found in explicit org", async () => {
    resolveEventInOrgSpy.mockResolvedValue(null);

    await expect(
      resolveOrgAllTarget("acme", "notfound", "/tmp"),
    ).rejects.toBeInstanceOf(ResolutionError);
  });

  test("propagates errors from resolveEventInOrg", async () => {
    const err = new Error("Auth failed");
    resolveEventInOrgSpy.mockRejectedValue(err);

    await expect(resolveOrgAllTarget("acme", "abc123", "/tmp")).rejects.toBe(
      err,
    );
  });
});

describe("resolveAutoDetectTarget", () => {
  let findEventAcrossOrgsSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findEventAcrossOrgsSpy = vi.spyOn(apiClient, "findEventAcrossOrgs");
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
  });

  afterEach(() => {
    findEventAcrossOrgsSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
  });

  test("returns auto-detect target when it resolves", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "acme",
      project: "cli",
      orgDisplay: "acme",
      projectDisplay: "cli",
    });

    const result = await resolveAutoDetectTarget("abc123", "/tmp");

    expect(result?.org).toBe("acme");
    expect(result?.project).toBe("cli");
    expect(findEventAcrossOrgsSpy).not.toHaveBeenCalled();
  });

  test("falls back to findEventAcrossOrgs when auto-detect returns null", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue(null);
    findEventAcrossOrgsSpy.mockResolvedValue({
      org: "other-org",
      project: "backend",
      event: { eventID: "abc123" },
    });

    const result = await resolveAutoDetectTarget("abc123", "/tmp");

    expect(result?.org).toBe("other-org");
    expect(result?.project).toBe("backend");
    expect(result?.prefetchedEvent?.eventID).toBe("abc123");
    expect(findEventAcrossOrgsSpy).toHaveBeenCalledWith("abc123");
  });

  test("returns resolved target when event found via cross-project search", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue(null);
    findEventAcrossOrgsSpy.mockResolvedValue({
      org: "acme",
      project: "frontend",
      event: { eventID: "abc123" },
    });

    const result = await resolveAutoDetectTarget("abc123", "/tmp");

    expect(result?.org).toBe("acme");
    expect(result?.project).toBe("frontend");
    expect(result?.prefetchedEvent?.eventID).toBe("abc123");
  });

  test("returns null when both auto-detect and cross-project fail", async () => {
    resolveOrgAndProjectSpy.mockResolvedValue(null);
    findEventAcrossOrgsSpy.mockResolvedValue(null);

    const result = await resolveAutoDetectTarget("abc123", "/tmp");

    expect(result).toBeNull();
  });
});

// ============================================================================
// viewCommand.func() — coverage for warning and normalized paths
// ============================================================================

describe("viewCommand.func", () => {
  let getEventSpy: ReturnType<typeof vi.spyOn>;
  let getSpanTreeLinesSpy: ReturnType<typeof vi.spyOn>;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;
  let resolveProjectBoundSlugSpy: ReturnType<typeof vi.spyOn>;
  let listEventAttachmentsSpy: ReturnType<typeof vi.spyOn>;
  let getIssueInOrgSpy: ReturnType<typeof vi.spyOn>;

  const VALID_EVENT_ID = "abc123def456abc123def456abc123de";
  const sampleEvent: SentryEvent = {
    eventID: VALID_EVENT_ID,
    title: "Error: test",
    metadata: {},
    contexts: {},
  } as unknown as SentryEvent;
  const attachment = {
    id: "attachment-1",
    event_id: VALID_EVENT_ID,
    type: "event.attachment",
    name: "screenshot.png",
    mimetype: "image/png",
    dateCreated: "2026-07-16T12:00:00Z",
    size: 2048,
    headers: {},
    sha1: null,
  };
  const attachmentDownloadUrl = `https://sentry.io/sentry/api/0/projects/test-org/test-proj/events/${VALID_EVENT_ID}/attachments/attachment-1/?download=1`;

  function createMockContext() {
    const stdoutWrite = vi.fn(() => true);
    return {
      context: {
        stdout: { write: stdoutWrite },
        stderr: { write: vi.fn(() => true) },
        cwd: "/tmp",
      },
      stdoutWrite,
    };
  }

  beforeEach(async () => {
    getEventSpy = vi.spyOn(apiClient, "getEvent");
    getSpanTreeLinesSpy = vi.spyOn(spanTree, "getSpanTreeLines");
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    resolveProjectBoundSlugSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundSlug",
    );
    listEventAttachmentsSpy = vi
      .spyOn(apiClient, "listEventAttachments")
      .mockResolvedValue([]);
    getIssueInOrgSpy = vi.spyOn(apiClient, "getIssueInOrg").mockResolvedValue({
      project: { slug: "test-proj" },
    } as never);
    setOrgRegion("test-org", `${DEFAULT_SENTRY_URL}/sentry`);
  });

  afterEach(() => {
    getEventSpy.mockRestore();
    getSpanTreeLinesSpy.mockRestore();
    openInBrowserSpy.mockRestore();
    resolveProjectBoundSlugSpy.mockRestore();
    listEventAttachmentsSpy.mockRestore();
    getIssueInOrgSpy.mockRestore();
  });

  test("logs warning when args appear swapped", async () => {
    // Swapped args: event ID first, then org/project target
    getEventSpy.mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    // Valid 32-char hex has no slash, "test-org/test-proj" has slash → swap detected
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      VALID_EVENT_ID,
      "test-org/test-proj",
    );

    // Command should complete without error (warning goes to consola, not stdout)
    expect(getEventSpy).toHaveBeenCalled();
  });

  test("returns undefined hint when there is no detection or replay hint", async () => {
    getEventSpy.mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    const result = await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "test-org/test-proj",
      VALID_EVENT_ID,
    );

    expect(result?.hint).toBeUndefined();
  });

  test("includes attachment metadata and download URLs in JSON", async () => {
    getEventSpy.mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });
    listEventAttachmentsSpy.mockResolvedValue([attachment]);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "test-org/test-proj",
      VALID_EVENT_ID,
    );

    expect(listEventAttachmentsSpy).toHaveBeenCalledWith(
      "test-org",
      "test-proj",
      VALID_EVENT_ID,
    );
    const output = JSON.parse(
      stdoutWrite.mock.calls.map((call) => call[0]).join(""),
    );
    expect(output.attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        name: "screenshot.png",
        download: attachmentDownloadUrl,
      }),
    ]);
  });

  test("shell-quotes the attachment download command", async () => {
    getEventSpy.mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });
    listEventAttachmentsSpy.mockResolvedValue([
      { ...attachment, name: "$(touch /tmp/pwned).png" },
    ]);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, spans: 0 },
      "test-org/test-proj",
      VALID_EVENT_ID,
    );

    const output = stdoutWrite.mock.calls
      .map((call) => String(call[0]))
      .join("");
    expect(output).toContain("sentry api");
    expect(output).toContain(`'${attachmentDownloadUrl}'`);
    expect(output).toContain("> '$(touch /tmp/pwned).png'");
  });

  test("keeps event output when attachment listing fails", async () => {
    getEventSpy.mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });
    listEventAttachmentsSpy.mockRejectedValue(
      new Error("attachments unavailable"),
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "test-org/test-proj",
      VALID_EVENT_ID,
    );

    const output = JSON.parse(
      stdoutWrite.mock.calls.map((call) => call[0]).join(""),
    );
    expect(output.eventID).toBe(VALID_EVENT_ID);
    expect(output.attachments).toEqual([]);
  });

  test("auto-redirects issue short ID in two-arg form via issueShortId path", async () => {
    // "CAM-82X" as first arg matches looksLikeIssueShortId → sets issueShortId,
    // NOT targetArg. The resolveIssueShortcut path fetches the latest event.
    const resolveOrgSpy = vi
      .spyOn(resolveTarget, "resolveOrg")
      .mockResolvedValue({
        org: "cam-org",
      });
    const getIssueByShortIdSpy = vi
      .spyOn(apiClient, "getIssueByShortId")
      .mockResolvedValue({ id: "999", shortId: "CAM-82X" } as never);
    const getLatestEventSpy = vi
      .spyOn(apiClient, "getLatestEvent")
      .mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    // First arg "CAM-82X" is an issue short ID, second arg "95fd7f5a" is ignored
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "CAM-82X",
      "95fd7f5a",
    );

    // Should NOT go through resolveProjectBoundSlug (the old buggy path)
    expect(resolveProjectBoundSlugSpy).not.toHaveBeenCalled();
    // Should resolve via issue short ID path
    expect(getIssueByShortIdSpy).toHaveBeenCalledWith("cam-org", "CAM-82X");
    expect(getLatestEventSpy).toHaveBeenCalled();

    resolveOrgSpy.mockRestore();
    getIssueByShortIdSpy.mockRestore();
    getLatestEventSpy.mockRestore();
  });

  test("numeric issue ID resolves org via resolveOrg then fetches latest event", async () => {
    // Regression: the numeric-issue-ID path must auto-detect the org via
    // resolveOrg (env/config/DSN) rather than resolveEffectiveOrg(""), which
    // skips auto-detection and fails when no org is on the command line.
    const resolveOrgSpy = vi
      .spyOn(resolveTarget, "resolveOrg")
      .mockResolvedValue({ org: "auto-org" });
    const getLatestEventSpy = vi
      .spyOn(apiClient, "getLatestEvent")
      .mockResolvedValue(sampleEvent);
    getIssueInOrgSpy.mockResolvedValue({
      project: { slug: "auto-project" },
    } as never);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false, spans: 0 }, "17370");

    expect(resolveOrgSpy).toHaveBeenCalled();
    expect(getLatestEventSpy).toHaveBeenCalledWith("auto-org", "17370");
    expect(listEventAttachmentsSpy).toHaveBeenCalledWith(
      "auto-org",
      "auto-project",
      VALID_EVENT_ID,
    );

    resolveOrgSpy.mockRestore();
    getLatestEventSpy.mockRestore();
  });

  test("org/numeric-ID passes explicit org through to resolveOrg", async () => {
    const resolveOrgSpy = vi
      .spyOn(resolveTarget, "resolveOrg")
      .mockResolvedValue({ org: "my-org" });
    const getLatestEventSpy = vi
      .spyOn(apiClient, "getLatestEvent")
      .mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "my-org/17370",
    );

    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: "my-org" }),
    );
    expect(getLatestEventSpy).toHaveBeenCalledWith("my-org", "17370");

    resolveOrgSpy.mockRestore();
    getLatestEventSpy.mockRestore();
  });

  test("org/project + short-ID second arg passes explicit org through to resolveOrg", async () => {
    // Regression: with an explicit "org/project" target and an issue short ID
    // as the second arg, the org must be forwarded to resolveOrg instead of
    // being dropped (which would fall back to auto-detection and miss/mishit).
    const resolveOrgSpy = vi
      .spyOn(resolveTarget, "resolveOrg")
      .mockResolvedValue({ org: "my-org" });
    const getIssueByShortIdSpy = vi
      .spyOn(apiClient, "getIssueByShortId")
      .mockResolvedValue({ id: "999", shortId: "CAM-82X" } as never);
    const getLatestEventSpy = vi
      .spyOn(apiClient, "getLatestEvent")
      .mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "my-org/my-project",
      "CAM-82X",
    );

    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: "my-org" }),
    );
    expect(getLatestEventSpy).toHaveBeenCalled();

    resolveOrgSpy.mockRestore();
    getIssueByShortIdSpy.mockRestore();
    getLatestEventSpy.mockRestore();
  });

  test("logs normalized slug warning when underscores present", async () => {
    getEventSpy.mockResolvedValue(sampleEvent);
    getSpanTreeLinesSpy.mockResolvedValue({
      lines: [],
      spans: null,
      traceId: null,
      success: false,
    });
    // Resolution looks up the raw slug before the command reports its normalized form.
    // Seed it so the warning test never attempts an unrelated network lookup.
    setOrgRegion("test_org", DEFAULT_SENTRY_URL);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    // Underscores in the slug trigger normalized warning
    await func.call(
      context,
      { json: true, web: false, spans: 0 },
      "test_org/test_proj",
      VALID_EVENT_ID,
    );

    // parseOrgProjectArg normalizes "test_org/test_proj" → "test-org/test-proj"
    // and sets normalized=true, triggering the warning path (line 343-345)
    expect(getEventSpy).toHaveBeenCalled();
  });

  test("throws error for flag-like event ID (--h)", async () => {
    // With recovery enabled, validation is deferred until after org
    // resolution. For a bare event ID in auto-detect mode, `resolveOrgAndProject`
    // runs first — in unit tests without a fixture it fails immediately,
    // and the original ValidationError re-emerges via the recovery path.
    // The behavior under test is "a malformed ID still produces an error",
    // not the exact class — that's covered by hex-id unit tests.
    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false, spans: 0 }, "--h"),
    ).rejects.toThrow();
  });

  test("throws error for non-hex event ID", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false, spans: 0 }, "not-a-hex-id"),
    ).rejects.toThrow();
  });
});

describe("fetchEventWithContext", () => {
  const mockEvent: SentryEvent = {
    eventID: "abc123def456abc123def456abc123de",
    id: "abc123def456abc123def456abc123de",
    groupID: "123",
    context: {},
    contexts: {},
    entries: [],
    tags: [],
    dateCreated: "2026-01-01T00:00:00Z",
    dateReceived: "2026-01-01T00:00:00Z",
  } as unknown as SentryEvent;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns prefetched event without making API calls", async () => {
    const getEventSpy = vi.spyOn(apiClient, "getEvent");
    const result = await fetchEventWithContext(
      mockEvent,
      "my-org",
      "my-project",
      "abc123",
    );
    expect(result).toEqual({
      org: "my-org",
      project: "my-project",
      event: mockEvent,
    });
    expect(getEventSpy).not.toHaveBeenCalled();
  });

  test("fetches event from project-scoped endpoint", async () => {
    const getEventSpy = vi
      .spyOn(apiClient, "getEvent")
      .mockResolvedValue(mockEvent);
    const result = await fetchEventWithContext(
      null,
      "my-org",
      "my-project",
      "abc123",
    );
    expect(result).toEqual({
      org: "my-org",
      project: "my-project",
      event: mockEvent,
    });
    expect(getEventSpy).toHaveBeenCalledWith("my-org", "my-project", "abc123");
  });

  test("falls back to org-wide search on 404 and finds event", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    const resolvedEvent = {
      ...mockEvent,
      eventID: "found-in-other-project",
    } as unknown as SentryEvent;
    vi.spyOn(apiClient, "resolveEventInOrg").mockResolvedValue({
      org: "my-org",
      project: "other-project",
      event: resolvedEvent,
    });

    const result = await fetchEventWithContext(
      null,
      "my-org",
      "my-project",
      "abc123",
    );
    expect(result).toEqual({
      org: "my-org",
      project: "other-project",
      event: resolvedEvent,
    });
  });

  test("throws ResolutionError when project-scoped, org-wide, and cross-org all fail", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    vi.spyOn(apiClient, "resolveEventInOrg").mockResolvedValue(null);
    vi.spyOn(apiClient, "findEventAcrossOrgs").mockResolvedValue(null);

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(ResolutionError);
  });

  test("falls back to cross-org search when org-wide returns null", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    vi.spyOn(apiClient, "resolveEventInOrg").mockResolvedValue(null);
    const crossOrgEvent = {
      ...mockEvent,
      eventID: "found-in-other-org",
    } as unknown as SentryEvent;
    vi.spyOn(apiClient, "findEventAcrossOrgs").mockResolvedValue({
      org: "other-org",
      project: "other-project",
      event: crossOrgEvent,
    });

    const result = await fetchEventWithContext(
      null,
      "my-org",
      "my-project",
      "abc123",
    );
    expect(result).toEqual({
      org: "other-org",
      project: "other-project",
      event: crossOrgEvent,
    });
  });

  test("cross-org fallback passes excludeOrgs when same-org search succeeded", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    // Same-org search completed successfully (returned null = definitive "not found")
    vi.spyOn(apiClient, "resolveEventInOrg").mockResolvedValue(null);
    const findSpy = vi
      .spyOn(apiClient, "findEventAcrossOrgs")
      .mockResolvedValue(null);

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(ResolutionError);

    expect(findSpy).toHaveBeenCalledWith("abc123", {
      excludeOrgs: ["my-org"],
    });
  });

  test("cross-org does not exclude org when same-org search threw", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    // Same-org search threw a transient error — org was NOT definitively searched
    vi.spyOn(apiClient, "resolveEventInOrg").mockRejectedValue(
      new Error("500 Internal Server Error"),
    );
    const findSpy = vi
      .spyOn(apiClient, "findEventAcrossOrgs")
      .mockResolvedValue(null);

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(ResolutionError);

    // excludeOrgs should be undefined so cross-org retries the same org
    expect(findSpy).toHaveBeenCalledWith("abc123", {
      excludeOrgs: undefined,
    });
  });

  test("cross-org excludes org when same-org search was rate-limited (429)", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    // Same-org search hit a rate limit — retrying it immediately is futile (CLI-2Y1)
    vi.spyOn(apiClient, "resolveEventInOrg").mockRejectedValue(
      new ApiError("Too Many Requests", 429),
    );
    const findSpy = vi
      .spyOn(apiClient, "findEventAcrossOrgs")
      .mockResolvedValue(null);

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(ResolutionError);

    // org must be excluded — re-querying a rate-limited endpoint immediately
    // produces consecutive identical HTTP requests (the Consecutive HTTP issue).
    expect(findSpy).toHaveBeenCalledWith("abc123", {
      excludeOrgs: ["my-org"],
    });
  });

  test("swallows non-auth cross-org errors and throws ResolutionError", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    vi.spyOn(apiClient, "resolveEventInOrg").mockResolvedValue(null);
    vi.spyOn(apiClient, "findEventAcrossOrgs").mockRejectedValue(
      new Error("Network timeout"),
    );

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(ResolutionError);
  });

  test("propagates AuthError from cross-org fallback", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    vi.spyOn(apiClient, "resolveEventInOrg").mockResolvedValue(null);
    vi.spyOn(apiClient, "findEventAcrossOrgs").mockRejectedValue(
      new AuthError("expired", "Token expired"),
    );

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(AuthError);
  });

  // Skip: vi.mocked on the barrel re-export doesn't intercept the binding
  // that event/view.ts captured at module load time. The resolveEventInOrg
  // mock doesn't take effect, so AuthError isn't thrown before cross-org
  // fallback. Tested via the Bun test suite.
  // oxlint-disable-next-line sentry-cli/no-skipped-tests -- vitest barrel-mock limitation — mock doesn't intercept module-load binding
  test.skip("propagates AuthError from same-org fallback", async () => {
    vi.mocked(apiClient.getEvent).mockRejectedValue(
      new ApiError("Not found", 404),
    );
    vi.mocked(apiClient.resolveEventInOrg).mockRejectedValue(
      new AuthError("expired", "Token expired"),
    );
    const findSpy = vi.mocked(apiClient.findEventAcrossOrgs);

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow(AuthError);
    // Cross-org should never be attempted when auth is broken
    expect(findSpy).not.toHaveBeenCalled();
  });

  test("tries cross-org fallback even when org-wide search throws", async () => {
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(
      new ApiError("Not found", 404),
    );
    vi.spyOn(apiClient, "resolveEventInOrg").mockRejectedValue(
      new Error("500 Internal Server Error"),
    );
    const crossOrgEvent = {
      ...mockEvent,
      eventID: "found-cross-org",
    } as unknown as SentryEvent;
    const findSpy = vi
      .spyOn(apiClient, "findEventAcrossOrgs")
      .mockResolvedValue({
        org: "other-org",
        project: "other-project",
        event: crossOrgEvent,
      });

    const result = await fetchEventWithContext(
      null,
      "my-org",
      "my-project",
      "abc123",
    );
    expect(result).toEqual({
      org: "other-org",
      project: "other-project",
      event: crossOrgEvent,
    });
    expect(findSpy).toHaveBeenCalled();
  });

  // Skip: same vitest barrel-mock limitation — getEvent mock doesn't
  // intercept the binding captured by event/view.ts at module load time.
  // oxlint-disable-next-line sentry-cli/no-skipped-tests -- vitest barrel-mock limitation — mock doesn't intercept module-load binding
  test.skip("propagates non-404 errors without fallback", async () => {
    vi.mocked(apiClient.getEvent).mockRejectedValue(
      new ApiError("Server error", 500),
    );
    const resolveEventSpy = vi.mocked(apiClient.resolveEventInOrg);

    await expect(
      fetchEventWithContext(null, "my-org", "my-project", "abc123"),
    ).rejects.toThrow("Server error");
    expect(resolveEventSpy).not.toHaveBeenCalled();
  });
});

// Note: splitNewlineArg is tested in test/lib/arg-parsing.test.ts

// ---------------------------------------------------------------------------
// expandNewlineArgs
// ---------------------------------------------------------------------------

describe("expandNewlineArgs", () => {
  test("expands newline-separated args into flat array", () => {
    expect(expandNewlineArgs(["org/proj/id1\nid2\nid3"])).toEqual([
      "org/proj/id1",
      "id2",
      "id3",
    ]);
  });

  test("passes through args without newlines", () => {
    expect(expandNewlineArgs(["org/proj", "eventid"])).toEqual([
      "org/proj",
      "eventid",
    ]);
  });

  test("handles mixed args with and without newlines", () => {
    expect(expandNewlineArgs(["org/proj", "id1\nid2"])).toEqual([
      "org/proj",
      "id1",
      "id2",
    ]);
  });

  test("handles empty array", () => {
    expect(expandNewlineArgs([])).toEqual([]);
  });

  test("real Codex pattern: org/project/id with many newline-separated IDs", () => {
    const codexArg = [
      "perzimo/perzimo-server/189945b37884462cb9134bd5cabeaa3d",
      "60c277e6c73f41c58ca46231b46dc0f8",
      "722e1158dfa147ec90ed831c4d096ae7",
    ].join("\n");
    expect(expandNewlineArgs([codexArg])).toEqual([
      "perzimo/perzimo-server/189945b37884462cb9134bd5cabeaa3d",
      "60c277e6c73f41c58ca46231b46dc0f8",
      "722e1158dfa147ec90ed831c4d096ae7",
    ]);
  });
});

// ---------------------------------------------------------------------------
// collectEventIds
// ---------------------------------------------------------------------------

describe("collectEventIds", () => {
  test("returns only primary ID when no extras", () => {
    expect(collectEventIds("abc123", undefined)).toEqual(["abc123"]);
  });

  test("returns only primary ID when extras is empty", () => {
    expect(collectEventIds("abc123", [])).toEqual(["abc123"]);
  });

  test("validates and collects valid extra hex IDs", () => {
    const ids = collectEventIds("abc123", [
      "60c277e6c73f41c58ca46231b46dc0f8",
      "722e1158dfa147ec90ed831c4d096ae7",
    ]);
    expect(ids).toEqual([
      "abc123",
      "60c277e6c73f41c58ca46231b46dc0f8",
      "722e1158dfa147ec90ed831c4d096ae7",
    ]);
  });

  test("skips invalid extra IDs silently", () => {
    const ids = collectEventIds("abc123", [
      "60c277e6c73f41c58ca46231b46dc0f8",
      "not-a-hex-id",
      "722e1158dfa147ec90ed831c4d096ae7",
    ]);
    expect(ids).toEqual([
      "abc123",
      "60c277e6c73f41c58ca46231b46dc0f8",
      "722e1158dfa147ec90ed831c4d096ae7",
    ]);
  });

  test("skips all invalid extras", () => {
    const ids = collectEventIds("abc123", ["bad1", "bad2"]);
    expect(ids).toEqual(["abc123"]);
  });

  test("deduplicates event IDs", () => {
    const ids = collectEventIds("60c277e6c73f41c58ca46231b46dc0f8", [
      "60c277e6c73f41c58ca46231b46dc0f8", // same as primary
      "722e1158dfa147ec90ed831c4d096ae7",
      "722e1158dfa147ec90ed831c4d096ae7", // duplicate extra
    ]);
    expect(ids).toEqual([
      "60c277e6c73f41c58ca46231b46dc0f8",
      "722e1158dfa147ec90ed831c4d096ae7",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parsePositionalArgs: extraEventIds collection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// formatEventView
// ---------------------------------------------------------------------------

describe("formatEventView", () => {
  const mockEvent = (id: string) =>
    ({
      eventID: id,
      title: `Error ${id}`,
      context: {},
      contexts: {},
      entries: [],
      tags: [],
    }) as unknown as import("../../../src/types/sentry.js").SentryEvent;

  test("renders single event", () => {
    const result = formatEventView({
      events: [{ event: mockEvent("abc123"), trace: null }],
      requestedCount: 1,
    });
    expect(result).toContain("abc123");
  });

  test("renders multiple events separated by horizontal rule", () => {
    const result = formatEventView({
      events: [
        { event: mockEvent("event1"), trace: null },
        { event: mockEvent("event2"), trace: null },
      ],
      requestedCount: 2,
    });
    expect(result).toContain("event1");
    expect(result).toContain("---");
    expect(result).toContain("event2");
  });

  test("includes span tree lines when present", () => {
    const result = formatEventView({
      events: [
        {
          event: mockEvent("abc123"),
          trace: null,
          spanTreeLines: ["  span-1 (50ms)", "    span-2 (20ms)"],
        },
      ],
      requestedCount: 1,
    });
    expect(result).toContain("span-1 (50ms)");
    expect(result).toContain("span-2 (20ms)");
  });
});

// ---------------------------------------------------------------------------
// jsonTransformEventView
// ---------------------------------------------------------------------------

describe("jsonTransformEventView", () => {
  const mockEvent = (id: string) =>
    ({
      eventID: id,
      title: `Error ${id}`,
    }) as unknown as import("../../../src/types/sentry.js").SentryEvent;

  test("returns flat object for single event", () => {
    const result = jsonTransformEventView({
      events: [{ event: mockEvent("abc123"), trace: null }],
      requestedCount: 1,
    });
    expect(result).toEqual(
      expect.objectContaining({ eventID: "abc123", trace: null }),
    );
    // Should NOT be an array
    expect(Array.isArray(result)).toBe(false);
  });

  test("returns array for multiple events", () => {
    const result = jsonTransformEventView({
      events: [
        { event: mockEvent("event1"), trace: null },
        { event: mockEvent("event2"), trace: null },
      ],
      requestedCount: 2,
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Record<string, unknown>[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual(expect.objectContaining({ eventID: "event1" }));
    expect(arr[1]).toEqual(expect.objectContaining({ eventID: "event2" }));
  });

  test("returns array when multiple requested but some failed", () => {
    // Requested 3, only 1 succeeded — still array (CLI-1HT deterministic shape)
    const result = jsonTransformEventView({
      events: [{ event: mockEvent("event1"), trace: null }],
      requestedCount: 3,
    });
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Record<string, unknown>[];
    expect(arr).toHaveLength(1);
  });

  test("applies field filtering for single event", () => {
    const result = jsonTransformEventView(
      {
        events: [{ event: mockEvent("abc123"), trace: null }],
        requestedCount: 1,
      },
      ["eventID"],
    );
    expect(result).toEqual({ eventID: "abc123" });
  });

  test("applies field filtering for multiple events", () => {
    const result = jsonTransformEventView(
      {
        events: [
          { event: mockEvent("event1"), trace: null },
          { event: mockEvent("event2"), trace: null },
        ],
        requestedCount: 2,
      },
      ["eventID"],
    );
    expect(result).toEqual([{ eventID: "event1" }, { eventID: "event2" }]);
  });
});

// ---------------------------------------------------------------------------
// fetchMultipleEvents
// ---------------------------------------------------------------------------

describe("fetchMultipleEvents", () => {
  const mockEvent = (id: string) =>
    ({
      eventID: id,
      title: `Error ${id}`,
    }) as unknown as import("../../../src/types/sentry.js").SentryEvent;

  test("fetches single event successfully", async () => {
    const event = mockEvent("abc123");
    vi.spyOn(apiClient, "getEvent").mockResolvedValue(event);

    const result = await fetchMultipleEvents({
      eventIds: ["abc123"],
      org: "my-org",
      project: "my-project",
      prefetchedEvent: null,
      primaryId: "abc123",
    });
    expect(result).toEqual([{ org: "my-org", project: "my-project", event }]);
  });

  test("uses prefetched event for primary ID", async () => {
    const prefetched = mockEvent("abc123");

    const result = await fetchMultipleEvents({
      eventIds: ["abc123"],
      org: "my-org",
      project: "my-project",
      prefetchedEvent: prefetched,
      primaryId: "abc123",
    });
    expect(result).toEqual([
      { org: "my-org", project: "my-project", event: prefetched },
    ]);
  });

  test("fetches multiple events in parallel", async () => {
    const event1 = mockEvent("event1");
    const event2 = mockEvent("event2");
    vi.spyOn(apiClient, "getEvent").mockImplementation(
      (_org: string, _proj: string, id: string) =>
        Promise.resolve(id === "event1" ? event1 : event2),
    );

    const result = await fetchMultipleEvents({
      eventIds: ["event1", "event2"],
      org: "my-org",
      project: "my-project",
      prefetchedEvent: null,
      primaryId: "event1",
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.event.eventID).toBe("event1");
    expect(result[1]?.event.eventID).toBe("event2");
  });

  test("warns on individual fetch failures and continues", async () => {
    const event1 = mockEvent("event1");
    vi.spyOn(apiClient, "getEvent").mockImplementation(
      (_org: string, _proj: string, id: string) =>
        id === "event1"
          ? Promise.resolve(event1)
          : Promise.reject(new Error("not found")),
    );

    const result = await fetchMultipleEvents({
      eventIds: ["event1", "event2"],
      org: "my-org",
      project: "my-project",
      prefetchedEvent: null,
      primaryId: "event1",
    });
    // Only the successful event is returned
    expect(result).toEqual([
      { org: "my-org", project: "my-project", event: event1 },
    ]);
  });

  test("re-throws primary event error when all fetches fail", async () => {
    const error = new ApiError("Server error", 500);
    vi.spyOn(apiClient, "getEvent").mockRejectedValue(error);

    await expect(
      fetchMultipleEvents({
        eventIds: ["event1", "event2"],
        org: "my-org",
        project: "my-project",
        prefetchedEvent: null,
        primaryId: "event1",
      }),
    ).rejects.toThrow("Server error");
  });
});

describe("parsePositionalArgs: extraEventIds", () => {
  test("no extras for single arg", () => {
    const result = parsePositionalArgs(["abc123"]);
    expect(result.extraEventIds).toBeUndefined();
  });

  test("no extras for two args", () => {
    const result = parsePositionalArgs(["my-org/proj", "abc123"]);
    expect(result.extraEventIds).toBeUndefined();
  });

  test("collects extras for three+ args", () => {
    const result = parsePositionalArgs([
      "my-org/proj",
      "abc123",
      "def456",
      "ghi789",
    ]);
    expect(result.extraEventIds).toEqual(["def456", "ghi789"]);
  });

  test("collects extras when args are swapped", () => {
    // When swap is detected: first looks like hex ID, second looks like target
    const result = parsePositionalArgs([
      "abc123def456abc123def456abc123de",
      "test-org/test-proj",
      "extra1",
    ]);
    expect(result.warning).toBeDefined();
    expect(result.extraEventIds).toEqual(["extra1"]);
  });
});
