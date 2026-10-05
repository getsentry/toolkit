/**
 * Argument Parsing Tests
 *
 * Note: Core invariants (return type determination, suffix normalization) are tested
 * via property-based tests in arg-parsing.property.test.ts. These tests focus on
 * error messages and edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  detectSwappedTrialArgs,
  detectSwappedViewArgs,
  looksLikeIssueShortId,
  normalizeSlug,
  parseIssueArg,
  parseOrgProjectArg,
  parseSlashSeparatedArg,
  rejectIssueCommandTokenListTarget,
  splitNewlineArg,
} from "../../src/lib/arg-parsing.js";
import { stripDsnOrgPrefix } from "../../src/lib/dsn/index.js";
import { ValidationError } from "../../src/lib/errors.js";

describe("stripDsnOrgPrefix", () => {
  test("strips 'o' prefix from DSN-style org IDs", () => {
    expect(stripDsnOrgPrefix("o1081365")).toBe("1081365");
    expect(stripDsnOrgPrefix("o123")).toBe("123");
    expect(stripDsnOrgPrefix("o0")).toBe("0");
    expect(stripDsnOrgPrefix("o9999999999")).toBe("9999999999");
  });

  test("preserves normal org slugs", () => {
    expect(stripDsnOrgPrefix("sentry")).toBe("sentry");
    expect(stripDsnOrgPrefix("my-org")).toBe("my-org");
    expect(stripDsnOrgPrefix("acme-corp")).toBe("acme-corp");
  });

  test("preserves slugs starting with 'o' that have non-digit chars", () => {
    expect(stripDsnOrgPrefix("organic")).toBe("organic");
    expect(stripDsnOrgPrefix("org-name")).toBe("org-name");
    expect(stripDsnOrgPrefix("o1abc")).toBe("o1abc");
    expect(stripDsnOrgPrefix("open123")).toBe("open123");
  });

  test("preserves pure numeric strings (no 'o' prefix)", () => {
    expect(stripDsnOrgPrefix("1081365")).toBe("1081365");
    expect(stripDsnOrgPrefix("123")).toBe("123");
  });

  test("preserves empty string and 'o' alone", () => {
    expect(stripDsnOrgPrefix("")).toBe("");
    expect(stripDsnOrgPrefix("o")).toBe("o");
  });
});

describe("parseOrgProjectArg", () => {
  // Representative examples for documentation (invariants covered by property tests)
  test("org/project returns explicit", () => {
    expect(parseOrgProjectArg("sentry/cli")).toEqual({
      type: "explicit",
      org: "sentry",
      project: "cli",
    });
  });

  test("handles multi-part project slugs", () => {
    expect(parseOrgProjectArg("sentry/spotlight-electron")).toEqual({
      type: "explicit",
      org: "sentry",
      project: "spotlight-electron",
    });
  });

  // Error case - verify specific message
  test("just slash throws error", () => {
    expect(() => parseOrgProjectArg("/")).toThrow(
      'Invalid format: "/" requires a project slug'
    );
  });

  // Parser preserves DSN-style org identifiers (normalization moved to resolution layer)
  describe("DSN-style org identifiers are preserved", () => {
    test("preserves 'o' prefix in org-all mode", () => {
      expect(parseOrgProjectArg("o1081365/")).toEqual({
        type: "org-all",
        org: "o1081365",
      });
    });

    test("preserves 'o' prefix in explicit mode", () => {
      expect(parseOrgProjectArg("o1081365/myproject")).toEqual({
        type: "explicit",
        org: "o1081365",
        project: "myproject",
      });
    });

    test("preserves normal org slugs", () => {
      expect(parseOrgProjectArg("organic/cli")).toEqual({
        type: "explicit",
        org: "organic",
        project: "cli",
      });
    });

    test("preserves slugs with mixed chars after 'o'", () => {
      expect(parseOrgProjectArg("o1abc/cli")).toEqual({
        type: "explicit",
        org: "o1abc",
        project: "cli",
      });
    });
  });

  // URL integration tests — applySentryUrlContext may set SENTRY_HOST/SENTRY_URL as a side effect.
  // Host-scoping: non-SaaS URLs now require the token to be scoped to the
  // same host. Tests that pass self-hosted URLs must set SENTRY_HOST before
  // running so the env-token-host snapshot matches.
  describe("Sentry URL inputs", () => {
    let savedSentryUrl: string | undefined;
    let savedSentryHost: string | undefined;

    beforeEach(async () => {
      savedSentryUrl = process.env.SENTRY_URL;
      savedSentryHost = process.env.SENTRY_HOST;
      delete process.env.SENTRY_URL;
      delete process.env.SENTRY_HOST;
      const { resetEnvTokenHostForTesting } = await import(
        "../../src/lib/env-token-host.js"
      );
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
      const { resetEnvTokenHostForTesting } = await import(
        "../../src/lib/env-token-host.js"
      );
      resetEnvTokenHostForTesting();
    });

    test("issue URL returns org-all", () => {
      expect(
        parseOrgProjectArg(
          "https://sentry.io/organizations/my-org/issues/12345/"
        )
      ).toEqual({
        type: "org-all",
        org: "my-org",
      });
    });

    test("project settings URL returns explicit", () => {
      expect(
        parseOrgProjectArg(
          "https://sentry.io/settings/my-org/projects/backend/"
        )
      ).toEqual({
        type: "explicit",
        org: "my-org",
        project: "backend",
      });
    });

    test("org-only URL returns org-all", () => {
      expect(
        parseOrgProjectArg("https://sentry.io/organizations/my-org/")
      ).toEqual({
        type: "org-all",
        org: "my-org",
      });
    });

    test("self-hosted URL extracts org when token is scoped to that host", () => {
      // Pin env-token to sentry.example.com so the URL-arg's host matches.
      process.env.SENTRY_HOST = "https://sentry.example.com";
      expect(
        parseOrgProjectArg(
          "https://sentry.example.com/organizations/acme-corp/issues/99/"
        )
      ).toEqual({
        type: "org-all",
        org: "acme-corp",
      });
    });

    test("self-hosted URL throws when token is scoped to a different host", () => {
      // No SENTRY_HOST set → env-token defaults to SaaS → mismatch on self-hosted URL.
      expect(() =>
        parseOrgProjectArg(
          "https://sentry.example.com/organizations/acme-corp/issues/99/"
        )
      ).toThrow(/does not match|sentry auth login --url/);
    });
  });

  describe("space handling (no normalization)", () => {
    test("bare project with spaces produces project-search with originalSlug", () => {
      const result = parseOrgProjectArg("My Project");
      expect(result).toEqual({
        type: "project-search",
        projectSlug: "My Project",
        originalSlug: "My Project",
      });
    });

    test("org with spaces in explicit mode throws ValidationError", () => {
      expect(() => parseOrgProjectArg("My Org/cli")).toThrow(ValidationError);
    });

    test("project with spaces in explicit mode produces project-search with org", () => {
      expect(parseOrgProjectArg("sentry/My Project")).toEqual({
        type: "project-search",
        projectSlug: "My Project",
        originalSlug: "My Project",
        org: "sentry",
      });
    });

    test("org with spaces in org-all mode throws ValidationError", () => {
      expect(() => parseOrgProjectArg("My Org/")).toThrow(ValidationError);
    });

    test("org with underscores and project with spaces produces project-search with org", () => {
      expect(parseOrgProjectArg("my_org/My Project")).toEqual({
        type: "project-search",
        projectSlug: "My Project",
        originalSlug: "My Project",
        org: "my_org",
      });
    });

    test("does not throw for auto-detect", () => {
      expect(parseOrgProjectArg(undefined)).toEqual({ type: "auto-detect" });
    });

    test("does not throw when no spaces present", () => {
      expect(parseOrgProjectArg("sentry/cli")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "cli",
      });
    });

    test("does not throw for underscored slug", () => {
      // Underscores are valid in Sentry slugs — no normalization, no error.
      expect(parseOrgProjectArg("selfbase_admin_backend")).toEqual({
        type: "project-search",
        projectSlug: "selfbase_admin_backend",
      });
    });
  });

  describe("@-selector rejection", () => {
    test("@latest throws with redirect to issue view", () => {
      expect(() => parseOrgProjectArg("@latest")).toThrow(
        "is an issue selector, not a project slug"
      );
      expect(() => parseOrgProjectArg("@latest")).toThrow(
        "sentry issue view @latest"
      );
    });

    test("@most_frequent throws with redirect to issue view", () => {
      expect(() => parseOrgProjectArg("@most_frequent")).toThrow(
        "is an issue selector, not a project slug"
      );
      expect(() => parseOrgProjectArg("@most_frequent")).toThrow(
        "sentry issue view @most_frequent"
      );
    });

    test("case-insensitive selector variants are rejected", () => {
      expect(() => parseOrgProjectArg("@Latest")).toThrow(
        "is an issue selector"
      );
      expect(() => parseOrgProjectArg("@LATEST")).toThrow(
        "is an issue selector"
      );
      expect(() => parseOrgProjectArg("@mostFrequent")).toThrow(
        "is an issue selector"
      );
    });

    test("unknown @-prefixed value throws as invalid slug", () => {
      expect(() => parseOrgProjectArg("@unknown")).toThrow("starts with '@'");
    });

    test("/@latest (leading slash) throws with redirect", () => {
      expect(() => parseOrgProjectArg("/@latest")).toThrow(
        "is an issue selector"
      );
    });

    test("sentry/@latest (org/selector) throws with redirect", () => {
      expect(() => parseOrgProjectArg("sentry/@latest")).toThrow(
        "is an issue selector"
      );
    });

    test("@latest/project (selector as org) throws", () => {
      expect(() => parseOrgProjectArg("@latest/cli")).toThrow(
        "is an issue selector, not an organization slug"
      );
    });

    test("@unknown/project (unknown @ as org) throws", () => {
      expect(() => parseOrgProjectArg("@unknown/cli")).toThrow(
        "starts with '@'"
      );
    });
  });
});

describe("parseIssueArg", () => {
  // Representative examples for documentation (invariants covered by property tests)
  describe("representative examples", () => {
    test("org/project-suffix returns explicit", () => {
      expect(parseIssueArg("sentry/cli-G")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "cli",
        suffix: "G",
      });
    });

    test("handles multi-part project slugs", () => {
      expect(parseIssueArg("sentry/spotlight-electron-4Y")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "spotlight-electron",
        suffix: "4Y",
      });
    });
  });

  // Multi-line input (CLI-1G1): agents and shells pass identifiers with
  // internal newlines (command substitution capturing extra output, an
  // appended note, or several newline-separated IDs). A bare trim() leaves the
  // internal newline, which previously threw a cryptic "contains a newline"
  // ValidationError. We keep the first non-blank line instead.
  describe("multi-line and whitespace input (CLI-1G1)", () => {
    const expected = {
      type: "explicit",
      org: "sentry",
      project: "cli",
      suffix: "G",
    };

    test("strips a trailing newline (CLI-16M regression)", () => {
      expect(parseIssueArg("sentry/cli-G\n")).toEqual(expected);
    });

    test("skips leading blank lines", () => {
      expect(parseIssueArg("\n\n  sentry/cli-G")).toEqual(expected);
    });

    test("keeps the first line when a note is appended after a newline", () => {
      expect(parseIssueArg("sentry/cli-G\nthe auth-token error")).toEqual(
        expected
      );
    });

    test("keeps the first identifier when several are newline-separated", () => {
      expect(parseIssueArg("sentry/cli-G\nsentry/cli-H")).toEqual(expected);
    });

    test("handles CRLF line endings", () => {
      expect(parseIssueArg("sentry/cli-G\r\ntrailing line")).toEqual(expected);
    });

    test("throws a clear error when input is only blank lines", () => {
      expect(() => parseIssueArg("\n   \n\t\n")).toThrow(ValidationError);
      expect(() => parseIssueArg("\n   \n\t\n")).toThrow(
        /empty after trimming/
      );
    });
  });

  // Error cases - verify specific error messages
  describe("error cases", () => {
    test("org/-suffix throws error", () => {
      expect(() => parseIssueArg("sentry/-G")).toThrow(
        "Cannot use trailing slash before suffix"
      );
    });

    test("-suffix (empty left) throws error", () => {
      expect(() => parseIssueArg("-G")).toThrow(
        "Missing project before suffix"
      );
    });

    test("trailing dash (empty suffix) throws error", () => {
      expect(() => parseIssueArg("cli-")).toThrow("Missing suffix after dash");
    });

    test("org/project with trailing dash (empty suffix) throws error", () => {
      expect(() => parseIssueArg("sentry/cli-")).toThrow(
        "Missing suffix after dash"
      );
    });

    test("org with trailing slash (empty issue ID) throws error", () => {
      expect(() => parseIssueArg("sentry/")).toThrow(
        "Missing issue ID after slash"
      );
    });

    test("issue-1 throws ValidationError for issue command token prefix", () => {
      expect(() => parseIssueArg("issue-1")).toThrow(ValidationError);
      expect(() => parseIssueArg("issue-1")).toThrow(
        "looks like a command token plus a suffix"
      );
    });

    test("my-org/issue-1 throws ValidationError for org-qualified issue command token", () => {
      expect(() => parseIssueArg("my-org/issue-1")).toThrow(ValidationError);
    });

    test("ISSUE-1 parses as project-search (uppercase short ID, not command token)", () => {
      expect(parseIssueArg("ISSUE-1")).toEqual({
        type: "project-search",
        projectSlug: "issue",
        suffix: "1",
      });
    });

    test("my-org/api-G parses as explicit org/project-suffix", () => {
      expect(parseIssueArg("my-org/api-G")).toEqual({
        type: "explicit",
        org: "my-org",
        project: "api",
        suffix: "G",
      });
    });

    test("api-G parses as project-search", () => {
      expect(parseIssueArg("api-G")).toEqual({
        type: "project-search",
        projectSlug: "api",
        suffix: "G",
      });
    });

    test("api-1 parses as project-search for projects named api", () => {
      expect(parseIssueArg("api-1")).toEqual({
        type: "project-search",
        projectSlug: "api",
        suffix: "1",
      });
    });

    test("release-123 parses as project-search for projects named release", () => {
      expect(parseIssueArg("release-123")).toEqual({
        type: "project-search",
        projectSlug: "release",
        suffix: "123",
      });
    });

    test("my-org/api-1 parses as explicit for org-qualified api project", () => {
      expect(parseIssueArg("my-org/api-1")).toEqual({
        type: "explicit",
        org: "my-org",
        project: "api",
        suffix: "1",
      });
    });

    test("cli-g still parses as project-search", () => {
      expect(parseIssueArg("cli-g")).toEqual({
        type: "project-search",
        projectSlug: "cli",
        suffix: "G",
      });
    });

    test("just slash throws error", () => {
      expect(() => parseIssueArg("/")).toThrow("Missing issue ID after slash");
    });

    test("invalid issue format throws ValidationError (not raw Error)", () => {
      // Ensures the fingerprint rule's `cli_error.class:"ValidationError"` tag
      // fires for these user-input errors, so they group under the canonical
      // ValidationError parent instead of as generic `Error` issues in Sentry.
      // Regression: CLI-1C9 was created because `parseIssueArg` used raw
      // `throw new Error(...)` instead of `ValidationError` for format errors.
      expect(() => parseIssueArg("XQUIK-")).toThrow(ValidationError);
      expect(() => parseIssueArg("cli-")).toThrow(ValidationError);
      expect(() => parseIssueArg("sentry/")).toThrow(ValidationError);
      expect(() => parseIssueArg("sentry/-G")).toThrow(ValidationError);
      expect(() => parseIssueArg("-G")).toThrow(ValidationError);
      expect(() => parseIssueArg("/")).toThrow(ValidationError);
    });
  });

  // URL integration tests — applySentryUrlContext may set SENTRY_HOST/SENTRY_URL as a side effect
  describe("Sentry URL inputs", () => {
    let savedSentryUrl: string | undefined;
    let savedSentryHost: string | undefined;

    beforeEach(() => {
      savedSentryUrl = process.env.SENTRY_URL;
      savedSentryHost = process.env.SENTRY_HOST;
      delete process.env.SENTRY_URL;
      delete process.env.SENTRY_HOST;
    });

    afterEach(() => {
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
    });

    test("issue URL with numeric ID returns explicit-org-numeric", () => {
      expect(
        parseIssueArg("https://sentry.io/organizations/my-org/issues/32886/")
      ).toEqual({
        type: "explicit-org-numeric",
        org: "my-org",
        numericId: "32886",
      });
    });

    test("issue URL with short ID returns explicit with lowercase project", () => {
      expect(
        parseIssueArg("https://sentry.io/organizations/my-org/issues/CLI-G/")
      ).toEqual({
        type: "explicit",
        org: "my-org",
        project: "cli",
        suffix: "G",
      });
    });

    test("issue URL with multi-part short ID returns explicit with lowercase project", () => {
      expect(
        parseIssueArg(
          "https://sentry.io/organizations/my-org/issues/SPOTLIGHT-ELECTRON-4Y/"
        )
      ).toEqual({
        type: "explicit",
        org: "my-org",
        project: "spotlight-electron",
        suffix: "4Y",
      });
    });

    test("self-hosted issue URL with query params (requires matching token host)", () => {
      process.env.SENTRY_HOST = "https://sentry.example.com";
      expect(
        parseIssueArg(
          "https://sentry.example.com/organizations/acme/issues/32886/?project=2"
        )
      ).toEqual({
        type: "explicit-org-numeric",
        org: "acme",
        numericId: "32886",
      });
    });

    test("event URL extracts issue ID (ignores event part)", () => {
      const result = parseIssueArg(
        "https://sentry.io/organizations/my-org/issues/32886/events/abc123/"
      );
      expect(result).toEqual({
        type: "explicit-org-numeric",
        org: "my-org",
        numericId: "32886",
      });
    });

    test("trace URL throws ValidationError (no issue ID in URL)", () => {
      expect(() =>
        parseIssueArg(
          "https://sentry.io/organizations/my-org/traces/a4d1aae7216b47ff/"
        )
      ).toThrow(ValidationError);
    });

    test("org-only URL throws ValidationError (no issue ID in URL)", () => {
      expect(() =>
        parseIssueArg("https://sentry.io/organizations/my-org/")
      ).toThrow(ValidationError);
    });

    test("project settings URL throws ValidationError (no issue ID in URL)", () => {
      expect(() =>
        parseIssueArg("https://sentry.io/settings/my-org/projects/backend/")
      ).toThrow(ValidationError);
    });

    test("non-issue URL error mentions issue URL format", () => {
      try {
        parseIssueArg("https://sentry.io/organizations/my-org/traces/abc/");
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain(
          "does not contain an issue ID"
        );
      }
    });

    test("SaaS subdomain share URL returns share type with org", () => {
      expect(
        parseIssueArg(
          "https://gibush-kq.sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5/"
        )
      ).toEqual({
        type: "share",
        shareId: "f1abd515c51346778384ff25dfb341e5",
        org: "gibush-kq",
        baseUrl: "https://gibush-kq.sentry.io",
      });
    });

    test("bare sentry.io share URL returns share type without org", () => {
      expect(
        parseIssueArg(
          "https://sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5/"
        )
      ).toEqual({
        type: "share",
        shareId: "f1abd515c51346778384ff25dfb341e5",
        org: undefined,
        baseUrl: "https://sentry.io",
      });
    });

    test("self-hosted share URL returns share type (requires matching token host)", () => {
      process.env.SENTRY_HOST = "https://sentry.example.com";
      expect(
        parseIssueArg(
          "https://sentry.example.com/share/issue/aabbccdd11223344aabbccdd11223344/"
        )
      ).toEqual({
        type: "share",
        shareId: "aabbccdd11223344aabbccdd11223344",
        org: undefined,
        baseUrl: "https://sentry.example.com",
      });
    });
  });

  // Parser preserves DSN-style org identifiers (normalization moved to resolution layer)
  describe("DSN-style org identifiers are preserved", () => {
    test("preserves 'o' prefix in explicit", () => {
      expect(parseIssueArg("o1081365/CLI-G")).toEqual({
        type: "explicit",
        org: "o1081365",
        project: "cli",
        suffix: "G",
      });
    });

    test("preserves 'o' prefix in explicit-org-numeric", () => {
      expect(parseIssueArg("o999/123456789")).toEqual({
        type: "explicit-org-numeric",
        org: "o999",
        numericId: "123456789",
      });
    });

    test("preserves 'o' prefix in explicit-org-suffix", () => {
      expect(parseIssueArg("o1081365/G")).toEqual({
        type: "explicit-org-suffix",
        org: "o1081365",
        suffix: "G",
      });
    });

    test("preserves normal org slugs in issue args", () => {
      expect(parseIssueArg("organic/cli-G")).toEqual({
        type: "explicit",
        org: "organic",
        project: "cli",
        suffix: "G",
      });
    });
  });

  // Multi-slash issue args (org/project/suffix)
  describe("multi-slash issue args", () => {
    test("org/project/numeric returns explicit-org-numeric", () => {
      expect(parseIssueArg("org/project/101149101")).toEqual({
        type: "explicit-org-numeric",
        org: "org",
        numericId: "101149101",
      });
    });

    test("org/project/short-numeric returns explicit-org-numeric", () => {
      expect(parseIssueArg("org/project/123456")).toEqual({
        type: "explicit-org-numeric",
        org: "org",
        numericId: "123456",
      });
    });

    test("org/project/PROJ-G where PROJ ≠ project returns explicit with combined suffix", () => {
      expect(parseIssueArg("org/project/PROJ-G")).toEqual({
        type: "explicit",
        org: "org",
        project: "project",
        suffix: "PROJ-G",
      });
    });

    test("org/project/PROJECT-G where prefix matches project strips prefix (CLI-KC)", () => {
      expect(parseIssueArg("sentry/cli/CLI-A1")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "cli",
        suffix: "A1",
      });
    });

    test("org/project/PROJECT-suffix is case-insensitive on prefix match", () => {
      expect(parseIssueArg("sentry/cli/cli-b6")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "cli",
        suffix: "B6",
      });
    });

    test("compound project slug with matching full short ID (CLI-KC)", () => {
      expect(
        parseIssueArg("org/spotlight-electron/SPOTLIGHT-ELECTRON-4Y")
      ).toEqual({
        type: "explicit",
        org: "org",
        project: "spotlight-electron",
        suffix: "4Y",
      });
    });

    test("org/project/numeric-id returns explicit-org-numeric (CLI-B6)", () => {
      expect(parseIssueArg("fever/cashless/6918259357")).toEqual({
        type: "explicit-org-numeric",
        org: "fever",
        numericId: "6918259357",
      });
    });

    test("org/project/G returns explicit with suffix", () => {
      expect(parseIssueArg("org/project/G")).toEqual({
        type: "explicit",
        org: "org",
        project: "project",
        suffix: "G",
      });
    });

    test("org/project/ (trailing slash, empty suffix) throws error", () => {
      expect(() => parseIssueArg("org/project/")).toThrow(
        "Missing project or issue ID segment"
      );
    });

    test("org//suffix (empty project) throws error", () => {
      expect(() => parseIssueArg("org//suffix")).toThrow(
        "Missing project or issue ID segment"
      );
    });
  });

  // Edge cases - document tricky behaviors
  describe("edge cases", () => {
    test("/suffix returns suffix-only", () => {
      // Leading slash with no org - treat as suffix
      expect(parseIssueArg("/G")).toEqual({
        type: "suffix-only",
        suffix: "G",
      });
    });

    test("/project-suffix returns project-search", () => {
      // Leading slash with project and suffix
      expect(parseIssueArg("/cli-G")).toEqual({
        type: "project-search",
        projectSlug: "cli",
        suffix: "G",
      });
    });

    test("/multi-part-project-suffix returns project-search", () => {
      // Leading slash with multi-part project slug
      expect(parseIssueArg("/spotlight-electron-4Y")).toEqual({
        type: "project-search",
        projectSlug: "spotlight-electron",
        suffix: "4Y",
      });
    });
  });

  // Colon-separated issue args — users type PROJECT:SHORTID or PROJECT:NUMERICID
  describe("colon-separated issue args (CLI-PH)", () => {
    test("PROJECT:SUFFIX returns project-search", () => {
      expect(parseIssueArg("CHATEX:W9")).toEqual({
        type: "project-search",
        projectSlug: "chatex",
        suffix: "W9",
      });
    });

    test("PROJECT:PROJECT-SUFFIX extracts suffix from last dash", () => {
      expect(parseIssueArg("CHATEX:CHATEX-W9")).toEqual({
        type: "project-search",
        projectSlug: "chatex",
        suffix: "W9",
      });
    });

    test("PROJECT:PROJECT-SUFFIX with multi-hyphen project", () => {
      expect(parseIssueArg("CHATEX:CHATEX-12A")).toEqual({
        type: "project-search",
        projectSlug: "chatex",
        suffix: "12A",
      });
    });

    test("MULTI-PROJECT:NUMERICID returns numeric", () => {
      expect(parseIssueArg("MYAH-FRONTEND:115562020")).toEqual({
        type: "numeric",
        id: "115562020",
      });
    });

    test("PROJECT:NUMERICID returns numeric", () => {
      expect(parseIssueArg("CLI:123456789")).toEqual({
        type: "numeric",
        id: "123456789",
      });
    });

    test("colon with empty project falls through to normal parsing", () => {
      // ":W9" has empty project part — parseWithColon returns null,
      // falls through to normal parsing (no slash, no dash → suffix-only)
      expect(parseIssueArg(":W9")).toEqual({
        type: "suffix-only",
        suffix: ":W9",
      });
    });

    test("colon with empty suffix falls through to normal parsing", () => {
      // "CLI:" has empty id part — parseWithColon returns null,
      // falls through to normal parsing (no slash, no dash → suffix-only)
      expect(parseIssueArg("CLI:")).toEqual({
        type: "suffix-only",
        suffix: "CLI:",
      });
    });

    test("multi-hyphen project with colon-separated short ID", () => {
      expect(parseIssueArg("ARES-BACKEND:4P")).toEqual({
        type: "project-search",
        projectSlug: "ares-backend",
        suffix: "4P",
      });
    });

    test("org/project:suffix falls through to slash parsing", () => {
      // When input has both slash and colon, slash parsing takes precedence
      // because parseWithColon returns null for slash-containing project parts.
      // "CLI:W9" has no dash, so parseAfterSlash returns explicit-org-suffix.
      expect(parseIssueArg("sentry/CLI:W9")).toEqual({
        type: "explicit-org-suffix",
        org: "sentry",
        suffix: "CLI:W9",
      });
    });
  });

  describe("magic @ selectors", () => {
    test("@latest returns selector type", () => {
      expect(parseIssueArg("@latest")).toEqual({
        type: "selector",
        selector: "@latest",
      });
    });

    test("@most_frequent returns selector type", () => {
      expect(parseIssueArg("@most_frequent")).toEqual({
        type: "selector",
        selector: "@most_frequent",
      });
    });

    test("case-insensitive: @LATEST and @Latest both work", () => {
      expect(parseIssueArg("@LATEST")).toEqual({
        type: "selector",
        selector: "@latest",
      });
      expect(parseIssueArg("@Latest")).toEqual({
        type: "selector",
        selector: "@latest",
      });
    });

    test("alternative spellings: @mostfrequent, @most-frequent", () => {
      expect(parseIssueArg("@mostfrequent")).toEqual({
        type: "selector",
        selector: "@most_frequent",
      });
      expect(parseIssueArg("@most-frequent")).toEqual({
        type: "selector",
        selector: "@most_frequent",
      });
    });

    test("org/@latest returns selector with org", () => {
      expect(parseIssueArg("sentry/@latest")).toEqual({
        type: "selector",
        selector: "@latest",
        org: "sentry",
      });
    });

    test("org/@most_frequent returns selector with org", () => {
      expect(parseIssueArg("my-org/@most_frequent")).toEqual({
        type: "selector",
        selector: "@most_frequent",
        org: "my-org",
      });
    });

    test("unrecognized @selector falls through to suffix-only", () => {
      // Unrecognized @ values are treated as suffix-only since @ is not
      // in the forbidden character set for resource IDs. They will fail
      // at the API level rather than at parse time.
      expect(parseIssueArg("@unknown")).toEqual({
        type: "suffix-only",
        suffix: "@UNKNOWN",
      });
    });
  });
});

describe("normalizeSlug", () => {
  test("preserves underscores (valid in Sentry slugs — #770)", () => {
    // Sentry accepts underscores in project slugs, so the CLI must not
    // rewrite them. Previously normalized to "selfbase-admin-backend"
    // which then failed API lookups.
    expect(normalizeSlug("selfbase_admin_backend")).toEqual({
      slug: "selfbase_admin_backend",
      normalized: false,
    });
  });

  test("preserves normal slugs (no spaces)", () => {
    expect(normalizeSlug("my-project")).toEqual({
      slug: "my-project",
      normalized: false,
    });
  });

  test("preserves multiple underscores", () => {
    expect(normalizeSlug("a_b_c_d")).toEqual({
      slug: "a_b_c_d",
      normalized: false,
    });
  });

  test("preserves leading underscore", () => {
    expect(normalizeSlug("_leading")).toEqual({
      slug: "_leading",
      normalized: false,
    });
  });

  test("preserves trailing underscore", () => {
    expect(normalizeSlug("trailing_")).toEqual({
      slug: "trailing_",
      normalized: false,
    });
  });

  test("preserves mixed case when no spaces (no lowercasing trigger)", () => {
    expect(normalizeSlug("My_Project")).toEqual({
      slug: "My_Project",
      normalized: false,
    });
  });

  test("handles empty string", () => {
    expect(normalizeSlug("")).toEqual({
      slug: "",
      normalized: false,
    });
  });

  test("passes through input with spaces unchanged (no-op)", () => {
    expect(normalizeSlug("My Project")).toEqual({
      slug: "My Project",
      normalized: false,
    });
  });

  test("passes through input with consecutive spaces unchanged (no-op)", () => {
    expect(normalizeSlug("My  Project")).toEqual({
      slug: "My  Project",
      normalized: false,
    });
  });

  test("passes through input with leading/trailing spaces unchanged (no-op)", () => {
    expect(normalizeSlug(" My Project ")).toEqual({
      slug: " My Project ",
      normalized: false,
    });
  });

  test("passes through input with underscores and spaces unchanged (no-op)", () => {
    // normalizeSlug is a no-op — spaces and underscores both pass through.
    expect(normalizeSlug("My_Project Name")).toEqual({
      slug: "My_Project Name",
      normalized: false,
    });
  });
});

describe("looksLikeIssueShortId", () => {
  describe("matches valid issue short IDs", () => {
    test("CAM-82X", () => {
      expect(looksLikeIssueShortId("CAM-82X")).toBe(true);
    });

    test("CLI-G", () => {
      expect(looksLikeIssueShortId("CLI-G")).toBe(true);
    });

    test("SPOTLIGHT-ELECTRON-4Y", () => {
      expect(looksLikeIssueShortId("SPOTLIGHT-ELECTRON-4Y")).toBe(true);
    });

    test("A-1", () => {
      expect(looksLikeIssueShortId("A-1")).toBe(true);
    });

    test("CLI-123", () => {
      expect(looksLikeIssueShortId("CLI-123")).toBe(true);
    });
  });

  describe("rejects non-issue strings", () => {
    test("my-project (lowercase)", () => {
      expect(looksLikeIssueShortId("my-project")).toBe(false);
    });

    test("a9b4ad2c (no dash)", () => {
      expect(looksLikeIssueShortId("a9b4ad2c")).toBe(false);
    });

    test("org/project (has slash)", () => {
      expect(looksLikeIssueShortId("org/project")).toBe(false);
    });

    test("CAM- (trailing dash, empty suffix)", () => {
      expect(looksLikeIssueShortId("CAM-")).toBe(false);
    });

    test("-82X (leading dash)", () => {
      expect(looksLikeIssueShortId("-82X")).toBe(false);
    });

    test("G (single char, no dash)", () => {
      expect(looksLikeIssueShortId("G")).toBe(false);
    });

    test("cam-82x (all lowercase)", () => {
      expect(looksLikeIssueShortId("cam-82x")).toBe(false);
    });

    test("123 (pure numeric)", () => {
      expect(looksLikeIssueShortId("123")).toBe(false);
    });
  });

  describe("with ignoreCase option", () => {
    test("cam-82x with ignoreCase is false (two-part lowercase slug)", () => {
      expect(looksLikeIssueShortId("cam-82x", { ignoreCase: true })).toBe(
        false
      );
    });

    test("CaM-82x with ignoreCase (mixed case short ID)", () => {
      expect(looksLikeIssueShortId("CaM-82x", { ignoreCase: true })).toBe(true);
    });

    test("javascript-react-mr-1b with ignoreCase", () => {
      expect(
        looksLikeIssueShortId("javascript-react-mr-1b", { ignoreCase: true })
      ).toBe(true);
    });

    test("my-frontend-app with ignoreCase is false (3-part project slug)", () => {
      expect(
        looksLikeIssueShortId("my-frontend-app", { ignoreCase: true })
      ).toBe(false);
    });

    test("my-app-2 with ignoreCase is false (versioned project slug)", () => {
      expect(looksLikeIssueShortId("my-app-2", { ignoreCase: true })).toBe(
        false
      );
    });

    test("my-app-2b with ignoreCase is true (lowercase multi-segment, alphanumeric final)", () => {
      expect(looksLikeIssueShortId("my-app-2b", { ignoreCase: true })).toBe(
        true
      );
    });

    test("my-apps-2b with ignoreCase is true (alphanumeric final, no length special-casing)", () => {
      expect(looksLikeIssueShortId("my-apps-2b", { ignoreCase: true })).toBe(
        true
      );
    });

    test("api-gateway-1 with ignoreCase is false (versioned project slug)", () => {
      expect(looksLikeIssueShortId("api-gateway-1", { ignoreCase: true })).toBe(
        false
      );
    });

    test("My-App-2 with ignoreCase is false (title-case project slug)", () => {
      expect(looksLikeIssueShortId("My-App-2", { ignoreCase: true })).toBe(
        false
      );
    });

    test("My-Frontend-App with ignoreCase is false (title-case project slug)", () => {
      expect(
        looksLikeIssueShortId("My-Frontend-App", { ignoreCase: true })
      ).toBe(false);
    });

    test("My-2 with ignoreCase is false (two-part title-case slug)", () => {
      expect(looksLikeIssueShortId("My-2", { ignoreCase: true })).toBe(false);
    });

    test("My-Project with ignoreCase is false (two-part title-case slug)", () => {
      expect(looksLikeIssueShortId("My-Project", { ignoreCase: true })).toBe(
        false
      );
    });

    test("My-2b with ignoreCase is false (title-case slug, alphanumeric suffix)", () => {
      expect(looksLikeIssueShortId("My-2b", { ignoreCase: true })).toBe(false);
    });

    test("Foo-3 with ignoreCase is false (two-part title-case slug)", () => {
      expect(looksLikeIssueShortId("Foo-3", { ignoreCase: true })).toBe(false);
    });

    test("CLI-5 with ignoreCase is true (all-uppercase prefix, numeric suffix)", () => {
      expect(looksLikeIssueShortId("CLI-5", { ignoreCase: true })).toBe(true);
    });

    test("P-1 with ignoreCase is true (single-letter short ID prefix)", () => {
      expect(looksLikeIssueShortId("P-1", { ignoreCase: true })).toBe(true);
    });

    test("A-1 with ignoreCase is true (single-letter short ID prefix)", () => {
      expect(looksLikeIssueShortId("A-1", { ignoreCase: true })).toBe(true);
    });

    test("spotlight-electron-4y with ignoreCase is true (lowercase multi-segment short ID)", () => {
      expect(
        looksLikeIssueShortId("spotlight-electron-4y", { ignoreCase: true })
      ).toBe(true);
    });

    test("SPOTLIGHT-ELECTRON-5 with ignoreCase is true (uppercase multi-segment numeric suffix)", () => {
      expect(
        looksLikeIssueShortId("SPOTLIGHT-ELECTRON-5", { ignoreCase: true })
      ).toBe(true);
    });

    test("JAVASCRIPT-NUXT-52 with ignoreCase is true (uppercase multi-segment numeric suffix)", () => {
      expect(
        looksLikeIssueShortId("JAVASCRIPT-NUXT-52", { ignoreCase: true })
      ).toBe(true);
    });

    test("my-project with ignoreCase is false (project slug)", () => {
      expect(looksLikeIssueShortId("my-project", { ignoreCase: true })).toBe(
        false
      );
    });

    test("acme-corp with ignoreCase is false (org/project slug)", () => {
      expect(looksLikeIssueShortId("acme-corp", { ignoreCase: true })).toBe(
        false
      );
    });
  });
});

describe("rejectIssueCommandTokenListTarget", () => {
  test("issue-1 throws ValidationError", () => {
    expect(() => rejectIssueCommandTokenListTarget("issue-1")).toThrow(
      ValidationError
    );
    expect(() => rejectIssueCommandTokenListTarget("issue-1")).toThrow(
      "looks like a command token plus a suffix"
    );
  });

  test("my-org/issue-1 throws ValidationError", () => {
    expect(() => rejectIssueCommandTokenListTarget("my-org/issue-1")).toThrow(
      ValidationError
    );
  });

  test("whitespace-padded issue-1 throws ValidationError", () => {
    expect(() => rejectIssueCommandTokenListTarget(" issue-1 ")).toThrow(
      ValidationError
    );
    expect(() =>
      rejectIssueCommandTokenListTarget(" my-org/issue-1\n")
    ).toThrow(ValidationError);
  });

  test("api-1 does not throw", () => {
    expect(() => rejectIssueCommandTokenListTarget("api-1")).not.toThrow();
  });

  test("my-org/cli does not throw", () => {
    expect(() => rejectIssueCommandTokenListTarget("my-org/cli")).not.toThrow();
  });

  test("ISSUE-1 does not throw (uppercase short ID, not command token)", () => {
    expect(() => rejectIssueCommandTokenListTarget("ISSUE-1")).not.toThrow();
  });
});

describe("detectSwappedViewArgs", () => {
  test("returns warning when second has slash but first does not (swapped)", () => {
    const result = detectSwappedViewArgs("a9b4ad2c", "mv-software/mvsoftware");
    expect(result).not.toBeNull();
    expect(result).toContain("mv-software/mvsoftware");
    expect(result).toContain("a9b4ad2c");
  });

  test("returns null when first has slash (correct order)", () => {
    expect(
      detectSwappedViewArgs("mv-software/mvsoftware", "a9b4ad2c")
    ).toBeNull();
  });

  test("returns null when neither has slash", () => {
    expect(detectSwappedViewArgs("a9b4ad2c", "deadbeef")).toBeNull();
  });

  test("returns null when both have slashes", () => {
    expect(detectSwappedViewArgs("org/project", "other/thing")).toBeNull();
  });
});

describe("detectSwappedTrialArgs", () => {
  const isKnown = (v: string) => ["seer", "replays", "performance"].includes(v);

  test("returns null when first arg is a known name (correct order)", () => {
    expect(detectSwappedTrialArgs("seer", "my-org", isKnown)).toBeNull();
  });

  test("returns swap result when second is known but first is not", () => {
    const result = detectSwappedTrialArgs("my-org", "seer", isKnown);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("seer");
    expect(result!.org).toBe("my-org");
    expect(result!.warning).toContain("reversed");
  });

  test("returns null when neither is a known name", () => {
    expect(detectSwappedTrialArgs("my-org", "other-org", isKnown)).toBeNull();
  });

  test("returns null when both are known names", () => {
    // If both are trial names, first is treated as the name (correct order)
    expect(detectSwappedTrialArgs("seer", "replays", isKnown)).toBeNull();
  });
});

describe("parseOrgProjectArg: underscores pass through", () => {
  // Sentry allows underscores in project slugs (the UI and API both accept
  // them at creation time), so the CLI must not rewrite them. Previously
  // these inputs were silently converted to dashes, causing "Project not
  // found" errors for customers with underscored slugs (see #770).

  test("preserves org slug underscores in explicit mode", () => {
    const result = parseOrgProjectArg("org_name/project");
    expect(result).toEqual({
      type: "explicit",
      org: "org_name",
      project: "project",
    });
    expect(result).not.toHaveProperty("normalized");
  });

  test("preserves project slug underscores in explicit mode", () => {
    const result = parseOrgProjectArg("org/project_name");
    expect(result).toEqual({
      type: "explicit",
      org: "org",
      project: "project_name",
    });
    expect(result).not.toHaveProperty("normalized");
  });

  test("preserves both org and project underscores", () => {
    const result = parseOrgProjectArg("org_name/project_name");
    expect(result).toEqual({
      type: "explicit",
      org: "org_name",
      project: "project_name",
    });
    expect(result).not.toHaveProperty("normalized");
  });

  test("preserves project-search underscores", () => {
    const result = parseOrgProjectArg("selfbase_admin_backend");
    expect(result).toEqual({
      type: "project-search",
      projectSlug: "selfbase_admin_backend",
    });
    expect(result).not.toHaveProperty("normalized");
  });

  test("normalized is absent for normal slugs (explicit)", () => {
    const result = parseOrgProjectArg("sentry/cli");
    expect(result.type).toBe("explicit");
    expect(result).not.toHaveProperty("normalized");
  });

  test("normalized is absent for normal slugs (project-search)", () => {
    const result = parseOrgProjectArg("my-project");
    expect(result.type).toBe("project-search");
    expect(result).not.toHaveProperty("normalized");
  });

  test("preserves org slug underscores in org-all mode", () => {
    const result = parseOrgProjectArg("org_name/");
    expect(result).toEqual({
      type: "org-all",
      org: "org_name",
    });
    expect(result).not.toHaveProperty("normalized");
  });
});

describe("parseOrgProjectArg space handling (no normalization)", () => {
  test("bare project with spaces produces project-search with raw input", () => {
    expect(parseOrgProjectArg("My Project")).toEqual({
      type: "project-search",
      projectSlug: "My Project",
      originalSlug: "My Project",
    });
  });

  test("org/project with spaces throws ValidationError (spaces in org)", () => {
    expect(() => parseOrgProjectArg("My Org/My Project")).toThrow(
      ValidationError
    );
  });

  test("consecutive spaces in bare project produces project-search with raw input", () => {
    expect(parseOrgProjectArg("My  Project")).toEqual({
      type: "project-search",
      projectSlug: "My  Project",
      originalSlug: "My  Project",
    });
  });

  test("org-all with spaces throws ValidationError (spaces in org)", () => {
    expect(() => parseOrgProjectArg("My Org/")).toThrow(ValidationError);
  });

  test("leading-slash with spaces produces project-search with raw input", () => {
    expect(parseOrgProjectArg("/My Project")).toEqual({
      type: "project-search",
      projectSlug: "My Project",
      originalSlug: "My Project",
    });
  });

  test("underscores with spaces in explicit mode produces project-search with org", () => {
    expect(parseOrgProjectArg("my_org/My Project")).toEqual({
      type: "project-search",
      projectSlug: "My Project",
      originalSlug: "My Project",
      org: "my_org",
    });
  });
});

// ---------------------------------------------------------------------------
// Input hardening against agent hallucinations (#350)
// ---------------------------------------------------------------------------

describe("parseOrgProjectArg: injection hardening", () => {
  test("rejects query injection in org slug", () => {
    expect(() => parseOrgProjectArg("my-org?query=foo/cli")).toThrow(
      ValidationError
    );
  });

  test("rejects query injection in project slug", () => {
    expect(() => parseOrgProjectArg("sentry/cli?extra=1")).toThrow(
      ValidationError
    );
  });

  test("rejects fragment injection in org slug", () => {
    expect(() => parseOrgProjectArg("my-org#anchor/cli")).toThrow(
      ValidationError
    );
  });

  test("rejects fragment injection in project slug", () => {
    expect(() => parseOrgProjectArg("sentry/my-project#anchor")).toThrow(
      ValidationError
    );
  });

  test("rejects pre-encoded space in project slug", () => {
    expect(() => parseOrgProjectArg("sentry/my%20project")).toThrow(
      ValidationError
    );
  });

  test("bare project slug with space produces project-search with raw input", () => {
    // Spaces in bare slugs are treated as display names — no normalization,
    // the resolution layer does a fuzzy name-based search.
    expect(parseOrgProjectArg("my project")).toEqual({
      type: "project-search",
      projectSlug: "my project",
      originalSlug: "my project",
    });
  });

  test("rejects tab character in org slug", () => {
    expect(() => parseOrgProjectArg("my-org\t/cli")).toThrow(ValidationError);
  });

  test("rejects null byte in project slug", () => {
    expect(() => parseOrgProjectArg("sentry/cli\x00extra")).toThrow(
      ValidationError
    );
  });
});

describe("parseIssueArg: injection hardening", () => {
  test("rejects query injection in issue arg", () => {
    expect(() => parseIssueArg("CLI-G?query=foo")).toThrow(ValidationError);
  });

  test("rejects forbidden characters inside a # fragment", () => {
    // A bare "#" is now a valid GitHub-style separator (CLI-1G1), but the
    // fragment after it is still validated against injection characters.
    expect(() => parseIssueArg("cli#an chor")).toThrow(ValidationError);
    expect(() => parseIssueArg("cli#an%20chor")).toThrow(ValidationError);
    expect(() => parseIssueArg("cli#G?extra")).toThrow(ValidationError);
  });

  test("rejects pre-encoded space in issue arg", () => {
    expect(() => parseIssueArg("CLI-G%20extra")).toThrow(ValidationError);
  });

  test("rejects control characters in issue arg", () => {
    expect(() => parseIssueArg("CLI-G\x00")).toThrow(ValidationError);
    // Tab in the middle is still rejected (trailing tab is trimmed like newlines)
    expect(() => parseIssueArg("CLI\tG")).toThrow(ValidationError);
  });

  test("rejects space in numeric ID", () => {
    expect(() => parseIssueArg("12345 6789")).toThrow(ValidationError);
  });

  test("rejects query string in org/issue format", () => {
    expect(() => parseIssueArg("sentry/CLI-G?extra")).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// GitHub-style "#" separator: org/project#SHORTID (CLI-1G1)
// ---------------------------------------------------------------------------

describe("parseIssueArg: GitHub-style # separator (CLI-1G1)", () => {
  describe("org/project#SHORTID", () => {
    test("full short ID whose prefix matches the project → explicit suffix", () => {
      expect(parseIssueArg("sentry/cli#CLI-G")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "cli",
        suffix: "G",
      });
    });

    test("numeric fragment → explicit-org-numeric", () => {
      expect(parseIssueArg("sentry/cli#123")).toEqual({
        type: "explicit-org-numeric",
        org: "sentry",
        numericId: "123",
      });
    });

    test("non-matching prefix → entire fragment becomes the suffix", () => {
      expect(parseIssueArg("sentry/cli#SUBPROJ-G")).toEqual({
        type: "explicit",
        org: "sentry",
        project: "cli",
        suffix: "SUBPROJ-G",
      });
    });

    test("bare suffix fragment → explicit suffix", () => {
      expect(parseIssueArg("my-org/my-project#G")).toEqual({
        type: "explicit",
        org: "my-org",
        project: "my-project",
        suffix: "G",
      });
    });
  });

  describe("project#SHORTID", () => {
    test("full short ID fragment → project-search with extracted suffix", () => {
      expect(parseIssueArg("cli#CLI-G")).toEqual({
        type: "project-search",
        projectSlug: "cli",
        suffix: "G",
      });
    });

    test("bare suffix fragment → project-search", () => {
      expect(parseIssueArg("cli#G")).toEqual({
        type: "project-search",
        projectSlug: "cli",
        suffix: "G",
      });
    });

    test("numeric fragment → numeric (project context redundant)", () => {
      expect(parseIssueArg("cli#123")).toEqual({
        type: "numeric",
        id: "123",
      });
    });

    test("lowercase fragment is uppercased into the suffix", () => {
      expect(parseIssueArg("cli#g")).toEqual({
        type: "project-search",
        projectSlug: "cli",
        suffix: "G",
      });
    });

    test("multi-hyphen project slug is preserved and lowercased", () => {
      expect(parseIssueArg("CLI-G#anchor")).toEqual({
        type: "project-search",
        projectSlug: "cli-g",
        suffix: "ANCHOR",
      });
    });
  });

  describe("bare #SHORTID", () => {
    test("full short ID → project-search", () => {
      expect(parseIssueArg("#CLI-G")).toEqual({
        type: "project-search",
        projectSlug: "cli",
        suffix: "G",
      });
    });

    test("numeric → numeric", () => {
      expect(parseIssueArg("#123")).toEqual({
        type: "numeric",
        id: "123",
      });
    });

    test("bare suffix → suffix-only", () => {
      expect(parseIssueArg("#G")).toEqual({
        type: "suffix-only",
        suffix: "G",
      });
    });
  });

  describe("error cases", () => {
    test("multiple # separators throw", () => {
      expect(() => parseIssueArg("a#b#c")).toThrow(ValidationError);
    });

    test("empty fragment throws", () => {
      expect(() => parseIssueArg("org/project#")).toThrow(ValidationError);
      expect(() => parseIssueArg("cli#")).toThrow(ValidationError);
      expect(() => parseIssueArg("#")).toThrow(ValidationError);
    });

    test("forbidden characters in fragment throw", () => {
      expect(() => parseIssueArg("cli#?bad")).toThrow(ValidationError);
      expect(() => parseIssueArg("cli#an chor")).toThrow(ValidationError);
      expect(() => parseIssueArg("cli#an%20chor")).toThrow(ValidationError);
    });

    test("colon mixed with # is rejected with a clear message", () => {
      expect(() => parseIssueArg("cli#frag:more")).toThrow(/'#' and ':'/);
    });

    test("forbidden characters in project prefix throw", () => {
      expect(() => parseIssueArg("bad%proj#G")).toThrow(ValidationError);
    });

    test("forbidden characters in org/project prefix throw", () => {
      expect(() => parseIssueArg("bad%org/project#G")).toThrow(ValidationError);
      expect(() => parseIssueArg("org/bad%proj#G")).toThrow(ValidationError);
    });

    test("multiple # error message suggests the correct format", () => {
      expect(() => parseIssueArg("a#b#c")).toThrow(/org\/project#PROJ-123/);
    });
  });
});

// ---------------------------------------------------------------------------
// Whitespace trimming for agent-injected newlines (CLI-16M)
// ---------------------------------------------------------------------------

describe("parseIssueArg: whitespace trimming", () => {
  test("trims trailing newline from issue short ID", () => {
    expect(parseIssueArg("CLI-G5\n")).toEqual({
      type: "project-search",
      projectSlug: "cli",
      suffix: "G5",
    });
  });

  test("trims trailing space from issue short ID", () => {
    expect(parseIssueArg("CLI-G5 ")).toEqual({
      type: "project-search",
      projectSlug: "cli",
      suffix: "G5",
    });
  });

  test("trims leading/trailing whitespace from numeric ID", () => {
    expect(parseIssueArg(" 123456789 ")).toEqual({
      type: "numeric",
      id: "123456789",
    });
  });

  test("trims carriage return + newline", () => {
    expect(parseIssueArg("CLI-G5\r\n")).toEqual({
      type: "project-search",
      projectSlug: "cli",
      suffix: "G5",
    });
  });

  test("trims trailing newline from org/issue format", () => {
    expect(parseIssueArg("sentry/CLI-G5\n")).toEqual({
      type: "explicit",
      org: "sentry",
      project: "cli",
      suffix: "G5",
    });
  });

  test("empty string after trimming throws", () => {
    expect(() => parseIssueArg("  \n  ")).toThrow(ValidationError);
  });
});

describe("parseSlashSeparatedArg: whitespace trimming", () => {
  test("trims trailing newline from plain ID", () => {
    const result = parseSlashSeparatedArg(
      "a9b4ad2c\n",
      "Event ID",
      "sentry event view <id>"
    );
    expect(result).toEqual({ id: "a9b4ad2c", targetArg: undefined });
  });

  test("trims trailing newline from structured arg", () => {
    const result = parseSlashSeparatedArg(
      "sentry/cli/a9b4ad2c\n",
      "Event ID",
      "sentry event view <id>"
    );
    expect(result).toEqual({ id: "a9b4ad2c", targetArg: "sentry/cli" });
  });

  test("trims leading/trailing whitespace from plain ID", () => {
    const result = parseSlashSeparatedArg(
      "  a9b4ad2c  ",
      "Event ID",
      "sentry event view <id>"
    );
    expect(result).toEqual({ id: "a9b4ad2c", targetArg: undefined });
  });

  test("preserves newlines in no-slash path (log view splits downstream)", () => {
    const result = parseSlashSeparatedArg(
      "abc123\ndef456",
      "Log ID",
      "sentry log view <id>"
    );
    // No-slash path must NOT strip newlines — log view splits them downstream
    expect(result.id).toBe("abc123\ndef456");
    expect(result.targetArg).toBeUndefined();
  });
});

describe("splitNewlineArg", () => {
  test("splits on newlines and trims each part", () => {
    expect(splitNewlineArg("abc\n def \nghi")).toEqual(["abc", "def", "ghi"]);
  });

  test("filters out empty lines", () => {
    expect(splitNewlineArg("abc\n\n\ndef")).toEqual(["abc", "def"]);
  });

  test("handles CRLF", () => {
    expect(splitNewlineArg("abc\r\ndef")).toEqual(["abc", "def"]);
  });

  test("returns single element for no newlines", () => {
    expect(splitNewlineArg("abc123")).toEqual(["abc123"]);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(splitNewlineArg("  \n  \n  ")).toEqual([]);
  });
});
