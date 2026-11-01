/**
 * Git refs, commits, and remotes read for shell completion, against a real
 * repository.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  listLocalRefs,
  listRecentCommits,
  listRemoteRepositories,
  listVcsRefs,
} from "../../src/lib/git.js";

let repo: string;
let outside: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "git-completion-"));
  outside = mkdtempSync(join(tmpdir(), "git-completion-outside-"));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "First commit");
  git("tag", "v1.0.0");
  writeFileSync(join(repo, "b.txt"), "b");
  git("add", "b.txt");
  git("commit", "--quiet", "-m", "Second commit");
  git("branch", "feature");
  git("remote", "add", "origin", "git@github.com:acme/app.git");
  git("remote", "add", "fork", "https://github.com/jane/app.git");
  // A remote-tracking branch and the remote's HEAD, as a fetch leaves them
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("update-ref", "refs/remotes/origin/release", "v1.0.0");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("git completion", () => {
  test("local refs are named as git resolves them, without remote HEADs", () => {
    expect(
      listLocalRefs(repo)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["feature", "main", "origin/main", "origin/release", "v1.0.0"]);
  });

  test("VCS refs drop the remote and list each name once, branches first", () => {
    const refs = listVcsRefs(repo).map(({ name }) => name);
    expect([...refs].sort()).toEqual(["feature", "main", "release", "v1.0.0"]);
    expect(refs.at(-1)).toBe("v1.0.0");
  });

  test("recent commits are full SHAs of HEAD, newest first, with subjects", () => {
    const commits = listRecentCommits(repo);
    expect(commits.map(({ subject }) => subject)).toEqual([
      "Second commit",
      "First commit",
    ]);
    expect(commits[0]?.name).toBe(git("rev-parse", "HEAD"));
  });

  test("remote repositories are owner/repo names with their remote", () => {
    expect(listRemoteRepositories(repo)).toEqual([
      { name: "jane/app", subject: "fork" },
      { name: "acme/app", subject: "origin" },
    ]);
  });

  test("nothing is completed outside a repository", () => {
    expect(listLocalRefs(outside)).toEqual([]);
    expect(listVcsRefs(outside)).toEqual([]);
    expect(listRecentCommits(outside)).toEqual([]);
    expect(listRemoteRepositories(outside)).toEqual([]);
  });
});
