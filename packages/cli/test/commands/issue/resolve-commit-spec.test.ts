/**
 * Tests for resolveCommitSpec — converts `@commit` / `@commit:<repo>@<sha>`
 * specs into the concrete `{commit, repository}` payload the Sentry API
 * expects. Every failure mode must throw a ValidationError (never silently
 * fall back to a different resolution mode).
 */

import { describe, expect, test, vi } from "vitest";
import { resolveCommitSpec } from "../../../src/commands/issue/resolve-commit-spec.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import { ValidationError } from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as gitLib from "../../../src/lib/git.js";
import type { SentryRepository } from "../../../src/types/sentry.js";

function makeRepo(overrides: Partial<SentryRepository>): SentryRepository {
  return {
    id: "1",
    name: "getsentry/cli",
    url: "https://github.com/getsentry/cli",
    provider: { id: "integrations:github", name: "GitHub" },
    status: "active",
    externalSlug: "getsentry/cli",
    ...overrides,
  } as SentryRepository;
}

describe("resolveCommitSpec — explicit mode", () => {
  test("returns {commit, repository} when repo is registered in Sentry", async () => {
    const repos = [makeRepo({ name: "getsentry/cli" })];
    const listSpy = vi
      .spyOn(apiClient, "listRepositoriesCached")
      .mockResolvedValue(repos);
    try {
      const result = await resolveCommitSpec(
        { kind: "explicit", repository: "getsentry/cli", commit: "abc123" },
        "sentry",
        "/tmp"
      );
      expect(result).toEqual({
        commit: "abc123",
        repository: "getsentry/cli",
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  test("matches on externalSlug as a fallback when name differs", async () => {
    const repos = [
      makeRepo({
        name: "Sentry Monolith",
        externalSlug: "getsentry/sentry",
      }),
    ];
    const listSpy = vi
      .spyOn(apiClient, "listRepositoriesCached")
      .mockResolvedValue(repos);
    try {
      const result = await resolveCommitSpec(
        { kind: "explicit", repository: "getsentry/sentry", commit: "abc" },
        "sentry",
        "/tmp"
      );
      // API expects the canonical `name`, not the externalSlug
      expect(result.repository).toBe("Sentry Monolith");
    } finally {
      listSpy.mockRestore();
    }
  });

  test("throws ValidationError when repo is not registered in Sentry", async () => {
    const listSpy = vi
      .spyOn(apiClient, "listRepositoriesCached")
      .mockResolvedValue([makeRepo({ name: "getsentry/sentry" })]);
    try {
      await expect(
        resolveCommitSpec(
          { kind: "explicit", repository: "unknown/repo", commit: "abc" },
          "sentry",
          "/tmp"
        )
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe("resolveCommitSpec — auto-detect mode", () => {
  test("throws when not inside a git work tree", async () => {
    const gitSpy = vi
      .spyOn(gitLib, "isInsideGitWorkTree")
      .mockReturnValue(false);
    try {
      await expect(
        resolveCommitSpec({ kind: "auto" }, "sentry", "/tmp")
      ).rejects.toThrow(/requires a git repository/);
    } finally {
      gitSpy.mockRestore();
    }
  });

  test("throws when HEAD cannot be read", async () => {
    const gitSpy = vi
      .spyOn(gitLib, "isInsideGitWorkTree")
      .mockReturnValue(true);
    const headSpy = vi.spyOn(gitLib, "getHeadCommit").mockImplementation(() => {
      throw new Error("fresh repo, no commits");
    });
    try {
      await expect(
        resolveCommitSpec({ kind: "auto" }, "sentry", "/tmp")
      ).rejects.toThrow(/could not read HEAD/);
    } finally {
      gitSpy.mockRestore();
      headSpy.mockRestore();
    }
  });

  test("resolves HEAD + matching Sentry repo (happy path)", async () => {
    // Exercises the full success path: work-tree check → HEAD read →
    // parseRemoteUrl parses the origin → listRepositoriesCached returns
    // a repo whose externalSlug matches → resolved payload returned.
    const gitSpy = vi
      .spyOn(gitLib, "isInsideGitWorkTree")
      .mockReturnValue(true);
    const headSpy = vi
      .spyOn(gitLib, "getHeadCommit")
      .mockReturnValue("abc123def456");
    // parseRemoteUrl runs on the output of `git remote get-url origin`,
    // which resolveCommitSpec fetches internally via execFileSync. We can
    // stub parseRemoteUrl to skip the real git call and return a known
    // owner/repo.
    const parseSpy = vi
      .spyOn(gitLib, "parseRemoteUrl")
      .mockReturnValue("getsentry/cli");
    const listSpy = vi
      .spyOn(apiClient, "listRepositoriesCached")
      .mockResolvedValue([
        makeRepo({ name: "getsentry/cli", externalSlug: "getsentry/cli" }),
      ]);

    try {
      // Use a cwd that actually has a git origin (the repo root) so the
      // internal `git remote get-url origin` call succeeds and the stubbed
      // parseRemoteUrl takes over from there.
      const result = await resolveCommitSpec(
        { kind: "auto" },
        "sentry",
        process.cwd()
      );
      expect(result).toEqual({
        commit: "abc123def456",
        repository: "getsentry/cli",
      });
    } finally {
      gitSpy.mockRestore();
      headSpy.mockRestore();
      parseSpy.mockRestore();
      listSpy.mockRestore();
    }
  });
});

describe("resolveCommitSpec — error messages are actionable", () => {
  test("explicit-mode miss lists available repos to help the user correct", async () => {
    const listSpy = vi
      .spyOn(apiClient, "listRepositoriesCached")
      .mockResolvedValue([
        makeRepo({ name: "getsentry/cli" }),
        makeRepo({ name: "getsentry/sentry" }),
      ]);
    try {
      const err = await resolveCommitSpec(
        { kind: "explicit", repository: "typo/repo", commit: "abc" },
        "sentry",
        "/tmp"
      ).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toContain("getsentry/cli");
      expect(err.message).toContain("getsentry/sentry");
    } finally {
      listSpy.mockRestore();
    }
  });
});
