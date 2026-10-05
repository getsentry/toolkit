/**
 * Release Set-Commits Command Tests
 *
 * Tests the --commit flag parsing (single SHA, ranges, validation)
 * and mode mutual exclusivity.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setCommitsCommand } from "../../../src/commands/release/set-commits.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

import { NO_REPO_INTEGRATIONS_MESSAGE } from "../../../src/lib/api/releases.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as gitLib from "../../../src/lib/git.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { SentryRelease } from "../../../src/types/index.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("release-set-commits-");

const sampleRelease: SentryRelease = {
  id: 1,
  version: "1.0.0",
  shortVersion: "1.0.0",
  status: "open",
  dateCreated: "2025-01-01T00:00:00Z",
  dateReleased: null,
  commitCount: 3,
  deployCount: 0,
  newGroups: 0,
  authors: [],
  projects: [],
  data: {},
  versionInfo: null,
};

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd,
    },
    stdoutWrite,
    stderrWrite,
  };
}

describe("release set-commits --commit", () => {
  let setCommitsWithRefsSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setCommitsWithRefsSpy = vi.spyOn(apiClient, "setCommitsWithRefs");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    setCommitsWithRefsSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("parses single REPO@SHA", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsWithRefsSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: "owner/repo@abc123",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsWithRefsSpy).toHaveBeenCalledWith("my-org", "1.0.0", [
      { repository: "owner/repo", commit: "abc123" },
    ]);
  });

  test("parses REPO@PREV..SHA range", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsWithRefsSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: "owner/repo@abc123..def456",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsWithRefsSpy).toHaveBeenCalledWith("my-org", "1.0.0", [
      {
        repository: "owner/repo",
        commit: "def456",
        previousCommit: "abc123",
      },
    ]);
  });

  test("parses comma-separated refs", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsWithRefsSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: "repo-a@sha1,repo-b@prev..sha2",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsWithRefsSpy).toHaveBeenCalledWith("my-org", "1.0.0", [
      { repository: "repo-a", commit: "sha1" },
      { repository: "repo-b", commit: "sha2", previousCommit: "prev" },
    ]);
  });

  test("throws on invalid format (no @)", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext();
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: "invalid-no-at-sign",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("Invalid commit format");
  });

  test("throws when --commit used with --auto", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext();
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: true,
          local: false,
          clear: false,
          commit: "repo@sha",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("Only one of --auto, --local, or --commit");
  });
});

describe("release set-commits --clear", () => {
  let setCommitsWithRefsSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setCommitsWithRefsSpy = vi.spyOn(apiClient, "setCommitsWithRefs");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    setCommitsWithRefsSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  // The server only clears commits when it receives an explicitly-empty
  // `refs` array; an empty `commits` list silently no-ops. This guards
  // against regressing back to the `updateRelease({ commits: [] })` path.
  test("sends an empty refs array to clear commits", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsWithRefsSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: true,
        commit: undefined,
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsWithRefsSpy).toHaveBeenCalledWith("my-org", "1.0.0", []);
  });
});

describe("release set-commits --auto", () => {
  let setCommitsAutoSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setCommitsAutoSpy = vi.spyOn(apiClient, "setCommitsAuto");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    setCommitsAutoSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("passes cwd to setCommitsAuto", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsAutoSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext("/my/project");
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: true,
        local: false,
        clear: false,
        commit: undefined,
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsAutoSpy).toHaveBeenCalledWith(
      "my-org",
      "1.0.0",
      "/my/project"
    );
  });
});

describe("release set-commits (default mode)", () => {
  let setCommitsAutoSpy: ReturnType<typeof spyOn>;
  let setCommitsLocalSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setCommitsAutoSpy = vi.spyOn(apiClient, "setCommitsAuto");
    setCommitsLocalSpy = vi.spyOn(apiClient, "setCommitsLocal");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    setCommitsAutoSpy.mockRestore();
    setCommitsLocalSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("propagates unrelated 400 errors from setCommitsAuto", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsAutoSpy.mockRejectedValue(
      new ApiError("Invalid commit SHA.", 400, undefined, "releases/1.0.0/")
    );

    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      ""
    );
    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: undefined,
          "initial-depth": 20,
          json: true,
        },
        "1.0.0"
      )
    ).rejects.toThrow("Invalid commit SHA.");

    expect(setCommitsAutoSpy).toHaveBeenCalled();
    expect(setCommitsLocalSpy).not.toHaveBeenCalled();
  });

  test("falls back to local only on the no-repo-integration 400", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsAutoSpy.mockRejectedValue(
      new ApiError(
        NO_REPO_INTEGRATIONS_MESSAGE,
        400,
        undefined,
        "releases/1.0.0/"
      )
    );
    setCommitsLocalSpy.mockResolvedValue(sampleRelease);

    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      ""
    );
    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: undefined,
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsAutoSpy).toHaveBeenCalled();
    expect(setCommitsLocalSpy).toHaveBeenCalled();
  });

  test("falls back to local on ValidationError from auto", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsAutoSpy.mockRejectedValue(
      new ValidationError(
        "No Sentry repository matching 'foo/bar'.",
        "repository"
      )
    );
    setCommitsLocalSpy.mockResolvedValue(sampleRelease);

    // Use the actual repo root as cwd so getCommitLog can read git history
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      ""
    );
    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: undefined,
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsAutoSpy).toHaveBeenCalled();
    expect(setCommitsLocalSpy).toHaveBeenCalled();
  });
});

describe("release set-commits --path", () => {
  let setCommitsAutoSpy: ReturnType<typeof spyOn>;
  let setCommitsLocalSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  // Use the actual repo root as cwd so getCommitLog can read git history
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    ""
  );

  beforeEach(() => {
    setCommitsAutoSpy = vi.spyOn(apiClient, "setCommitsAuto");
    setCommitsLocalSpy = vi.spyOn(apiClient, "setCommitsLocal");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    setCommitsAutoSpy.mockRestore();
    setCommitsLocalSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("implies local mode (no --auto needed)", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsLocalSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: undefined,
        path: "src",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsLocalSpy).toHaveBeenCalled();
    expect(setCommitsAutoSpy).not.toHaveBeenCalled();
  });

  test("accepts comma-separated paths in local mode", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsLocalSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: undefined,
        path: "src,test",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsLocalSpy).toHaveBeenCalled();
    expect(setCommitsAutoSpy).not.toHaveBeenCalled();
  });

  test("throws when --path has only empty/whitespace tokens", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: undefined,
          path: " , ",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--path requires at least one non-empty path");
  });

  test("throws when --path used with --auto", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: true,
          local: false,
          clear: false,
          commit: undefined,
          path: "apps/mobile",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--path cannot be combined with --auto or --commit");
  });

  test("throws when --path used with --commit", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: "repo@a..b",
          path: "apps/mobile",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--path cannot be combined with --auto or --commit");
  });
});

describe("release set-commits --from", () => {
  let setCommitsAutoSpy: ReturnType<typeof spyOn>;
  let setCommitsLocalSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;
  let getCommitLogSpy: ReturnType<typeof spyOn>;

  // Use the actual repo root as cwd so the git remote/shallow helpers resolve.
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    ""
  );

  beforeEach(() => {
    setCommitsAutoSpy = vi.spyOn(apiClient, "setCommitsAuto");
    setCommitsLocalSpy = vi.spyOn(apiClient, "setCommitsLocal");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    // Stub the git log so the range doesn't depend on real repo history —
    // CI checks out a shallow clone where HEAD~N does not exist.
    getCommitLogSpy = vi.spyOn(gitLib, "getCommitLog").mockReturnValue([
      {
        id: "abc123",
        message: "commit",
        author_name: "Jane",
        author_email: "jane@example.com",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  afterEach(() => {
    setCommitsAutoSpy.mockRestore();
    setCommitsLocalSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    getCommitLogSpy.mockRestore();
  });

  test("implies local mode and reads the <ref>..HEAD range", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsLocalSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: undefined,
        from: "HEAD~1",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsLocalSpy).toHaveBeenCalled();
    expect(setCommitsAutoSpy).not.toHaveBeenCalled();
    // A range is self-bounding, so depth 0 (no cap) is passed.
    expect(getCommitLogSpy).toHaveBeenCalledWith(
      repoRoot,
      expect.objectContaining({ from: "HEAD~1", depth: 0, paths: [] })
    );
  });

  test("combines with --path in local mode", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    setCommitsLocalSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();
    await func.call(
      context,
      {
        auto: false,
        local: false,
        clear: false,
        commit: undefined,
        from: "HEAD~3",
        path: "src,test",
        "initial-depth": 20,
        json: true,
      },
      "1.0.0"
    );

    expect(setCommitsLocalSpy).toHaveBeenCalled();
    expect(setCommitsAutoSpy).not.toHaveBeenCalled();
    expect(getCommitLogSpy).toHaveBeenCalledWith(
      repoRoot,
      expect.objectContaining({ from: "HEAD~3", paths: ["src", "test"] })
    );
  });

  test("throws when --from looks like an option", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: undefined,
          from: "--format=%H",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--from must be a git ref, not a CLI flag");
  });

  test("throws when --from is empty/whitespace", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: undefined,
          from: "  ",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--from requires a non-empty git ref");
  });

  test("throws when --from used with --auto", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: true,
          local: false,
          clear: false,
          commit: undefined,
          from: "v0.9.0",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--from cannot be combined with --auto or --commit");
  });

  test("throws when --from used with --commit", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext(repoRoot);
    const func = await setCommitsCommand.loader();

    await expect(
      func.call(
        context,
        {
          auto: false,
          local: false,
          clear: false,
          commit: "repo@a..b",
          from: "v0.9.0",
          "initial-depth": 20,
          json: false,
        },
        "1.0.0"
      )
    ).rejects.toThrow("--from cannot be combined with --auto or --commit");
  });
});
