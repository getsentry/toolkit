/**
 * Tests for VCS metadata collection.
 *
 * `git.js` is mocked so collection is deterministic (no dependency on the
 * checkout's real branch/remote). Covers flag precedence, GitHub Actions env
 * inference, the base==head skip, and the flattened body mapping.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const gitMock = vi.hoisted(() => ({
  getHeadCommit: vi.fn(() => "a".repeat(40)),
  getRemoteUrl: vi.fn(() => "https://github.com/acme/app.git"),
  getRepositoryName: vi.fn(() => "acme/app"),
  getCurrentBranch: vi.fn(() => "feature/x"),
  getMergeBase: vi.fn(() => "b".repeat(40)),
  getRemoteDefaultBranch: vi.fn(() => "main"),
}));

vi.mock("../../../src/lib/git.js", () => gitMock);

import { ValidationError } from "../../../src/lib/errors.js";
import {
  collectVcsMetadata,
  isCi,
  vcsInfoToBody,
} from "../../../src/lib/build/vcs.js";

// The git mock is shared across tests; clear call history (keeps default
// implementations) so `.not.toHaveBeenCalled()` assertions are per-test.
beforeEach(() => {
  vi.clearAllMocks();
});

/** Temp dirs holding GitHub event payloads, cleaned up after each test. */
const eventDirs: string[] = [];
afterEach(() => {
  while (eventDirs.length > 0) {
    const dir = eventDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("isCi", () => {
  test("true when a CI variable is set", () => {
    expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(true);
  });

  test("false with no CI variables (and ignores opt-out values)", () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
  });
});

describe("vcsInfoToBody", () => {
  test("flattens to snake_case and renames provider", () => {
    expect(
      vcsInfoToBody({
        headSha: "h",
        vcsProvider: "github",
        headRepoName: "o/r",
        prNumber: 5,
      })
    ).toEqual({
      head_sha: "h",
      provider: "github",
      head_repo_name: "o/r",
      pr_number: 5,
    });
  });

  test("omits empty fields", () => {
    expect(vcsInfoToBody({})).toEqual({});
  });

  test("keeps pr_number 0", () => {
    expect(vcsInfoToBody({ prNumber: 0 })).toEqual({ pr_number: 0 });
  });
});

describe("collectVcsMetadata", () => {
  test("uses explicit flags and skips git introspection when autoCollect is false", () => {
    const sha = "abcdef01".repeat(5); // 40 hex chars
    const vcs = collectVcsMetadata(
      { "head-sha": sha.toUpperCase(), "head-ref": "main", "pr-number": 7 },
      "/repo",
      {},
      false
    );

    expect(vcs.headSha).toBe(sha); // normalized to lowercase
    expect(vcs.headRef).toBe("main");
    expect(vcs.prNumber).toBe(7);
    expect(gitMock.getHeadCommit).not.toHaveBeenCalled();
    expect(gitMock.getRemoteUrl).not.toHaveBeenCalled();
  });

  test("infers metadata from a GitHub Actions pull_request run", () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/x",
      GITHUB_BASE_REF: "main",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_REF: "refs/pull/42/merge",
    };

    const vcs = collectVcsMetadata({}, "/repo", env, true);

    expect(vcs.headRef).toBe("feature/x");
    expect(vcs.baseRef).toBe("main");
    expect(vcs.headRepoName).toBe("acme/app");
    expect(vcs.prNumber).toBe(42);
    expect(vcs.vcsProvider).toBe("github");
    expect(vcs.headSha).toBe("a".repeat(40));
    expect(vcs.baseSha).toBe("b".repeat(40));
  });

  test("drops base_sha/base_ref when base equals head and both were auto-inferred", () => {
    gitMock.getHeadCommit.mockReturnValueOnce("c".repeat(40));
    gitMock.getMergeBase.mockReturnValueOnce("c".repeat(40));

    const vcs = collectVcsMetadata(
      {},
      "/repo",
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
      true
    );

    expect(vcs.headSha).toBe("c".repeat(40));
    expect(vcs.baseSha).toBeUndefined();
    expect(vcs.baseRef).toBeUndefined();
  });

  test("prefers head/base SHAs from the GitHub Actions event payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcs-event-"));
    eventDirs.push(dir);
    const eventPath = join(dir, "event.json");
    const headSha = "1".repeat(40);
    const baseSha = "2".repeat(40);
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { head: { sha: headSha }, base: { sha: baseSha } },
      })
    );

    const vcs = collectVcsMetadata(
      {},
      "/repo",
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
      true
    );

    // Event payload wins over `git rev-parse HEAD` / merge-base.
    expect(vcs.headSha).toBe(headSha);
    expect(vcs.baseSha).toBe(baseSha);
    expect(gitMock.getHeadCommit).not.toHaveBeenCalled();
    expect(gitMock.getMergeBase).not.toHaveBeenCalled();
  });

  test("an empty --head-sha explicitly clears and suppresses auto-inference", () => {
    const vcs = collectVcsMetadata({ "head-sha": "" }, "/repo", {}, true);
    expect(vcs.headSha).toBeUndefined();
    expect(gitMock.getHeadCommit).not.toHaveBeenCalled();
  });

  test("rejects a malformed --head-sha", () => {
    expect(() =>
      collectVcsMetadata({ "head-sha": "not-a-sha" }, "/repo", {}, false)
    ).toThrow(ValidationError);
  });

  test("lowercases an auto merge-base base SHA", () => {
    gitMock.getMergeBase.mockReturnValueOnce("D".repeat(40));
    const vcs = collectVcsMetadata(
      {},
      "/repo",
      { GITHUB_EVENT_NAME: "push" },
      true
    );
    expect(vcs.baseSha).toBe("d".repeat(40));
  });

  test("computes base_sha via merge-base with an explicit --base-ref", () => {
    gitMock.getMergeBase.mockReturnValueOnce("e".repeat(40));
    const vcs = collectVcsMetadata(
      { "base-ref": "release/2.0" },
      "/repo",
      {},
      true
    );
    expect(vcs.baseRef).toBe("release/2.0");
    expect(vcs.baseSha).toBe("e".repeat(40));
    expect(gitMock.getMergeBase).toHaveBeenCalledWith(
      "origin/release/2.0",
      "/repo"
    );
  });

  test("derives provider from an SCP-style remote and GHE hosts", () => {
    gitMock.getRemoteUrl.mockReturnValueOnce("git@github.com:acme/app.git");
    expect(collectVcsMetadata({}, "/repo", {}, true).vcsProvider).toBe("github");

    gitMock.getRemoteUrl.mockReturnValueOnce("https://acme.ghe.com/o/r.git");
    expect(collectVcsMetadata({}, "/repo", {}, true).vcsProvider).toBe(
      "github_enterprise"
    );
  });
});
