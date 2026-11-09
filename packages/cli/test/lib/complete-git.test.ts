/**
 * Completers of flags that take git refs, commits, and repositories. Git
 * is read from the shell's working directory, so its helpers are mocked
 * with a known repository (`test/lib/git-completion.test.ts` covers them).
 */

import { describe, expect, test, vi } from "vitest";

vi.mock("../../src/lib/git.js", () => ({
  listLocalRefs: () => [
    { name: "main", subject: "Latest" },
    { name: "origin/main", subject: "Latest" },
  ],
  listVcsRefs: () => [
    { name: "main", subject: "Latest" },
    { name: "v1.0.0", subject: "Release" },
  ],
  listRecentCommits: () => [
    { name: "abc123", subject: "Latest" },
    { name: "def456", subject: "Older" },
  ],
  listRemoteRepositories: () => [{ name: "acme/app", subject: "origin" }],
}));

import { getCompletions } from "../../src/lib/complete.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-complete-git-");

async function values(words: string[], partial: string): Promise<string[]> {
  return (await getCompletions(words, partial)).map((c) => c.value);
}

describe("getCompletions: git", () => {
  test("refs sent to Sentry complete as the remote names them", async () => {
    expect(await values(["build", "upload", "--base-ref"], "")).toEqual([
      "main",
      "v1.0.0",
    ]);
    expect(await values(["release", "create", "--ref"], "v")).toEqual([
      "v1.0.0",
    ]);
  });

  test("a local range starts from a ref git resolves", async () => {
    expect(await values(["release", "set-commits", "--from"], "or")).toEqual([
      "origin/main",
    ]);
  });

  test("SHAs complete recent commits with their subjects", async () => {
    expect(
      await getCompletions(["snapshots", "upload", "--head-sha"], "de"),
    ).toEqual([{ value: "def456", description: "Older" }]);
  });

  test("repository names complete from the remotes", async () => {
    expect(await values(["code-mappings", "upload", "--repo"], "")).toEqual([
      "acme/app",
    ]);
  });

  test("--commit completes REPO@ and then commits, in ranges and lists", async () => {
    const commit = ["release", "set-commits", "--commit"];
    expect(await values(commit, "ac")).toEqual(["acme/app@"]);
    expect(await values(commit, "acme/app@")).toEqual([
      "acme/app@abc123",
      "acme/app@def456",
    ]);
    expect(await values(commit, "acme/app@def456..ab")).toEqual([
      "acme/app@def456..abc123",
    ]);
    expect(await values(commit, "acme/app@abc123,ac")).toEqual([
      "acme/app@abc123,acme/app@",
    ]);
  });
});
