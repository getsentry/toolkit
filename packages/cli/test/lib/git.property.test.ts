import { array, constantFrom, assert as fcAssert, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { parseRemoteUrl } from "../../src/lib/git.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const slugChars = "abcdefghijklmnopqrstuvwxyz0123456789";

const ownerArb = array(constantFrom(...`${slugChars}-`.split("")), {
  minLength: 1,
  maxLength: 15,
})
  .map((chars) => chars.join(""))
  .filter((s) => !(s.startsWith("-") || s.endsWith("-")));

const repoArb = array(constantFrom(...`${slugChars}-.`.split("")), {
  minLength: 1,
  maxLength: 20,
})
  .map((chars) => chars.join(""))
  .filter((s) => !(s.startsWith("-") || s.endsWith("-") || s.startsWith(".")));

describe("property: parseRemoteUrl", () => {
  test("HTTPS URL → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `https://github.com/${owner}/${repo}.git`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("HTTPS URL without .git suffix → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `https://github.com/${owner}/${repo}`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("SSH URL → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `git@github.com:${owner}/${repo}.git`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("SSH URL without .git suffix → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `git@github.com:${owner}/${repo}`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("unit: parseRemoteUrl edge cases", () => {
  test("standard GitHub HTTPS", () => {
    expect(parseRemoteUrl("https://github.com/getsentry/cli.git")).toBe(
      "getsentry/cli"
    );
  });

  test("standard GitHub SSH", () => {
    expect(parseRemoteUrl("git@github.com:getsentry/cli.git")).toBe(
      "getsentry/cli"
    );
  });

  test("GitLab HTTPS", () => {
    expect(parseRemoteUrl("https://gitlab.com/my-group/my-project.git")).toBe(
      "my-group/my-project"
    );
  });

  test("Bitbucket SSH", () => {
    expect(parseRemoteUrl("git@bitbucket.org:team/repo.git")).toBe("team/repo");
  });

  test("SSH with port (ssh:// protocol)", () => {
    expect(parseRemoteUrl("ssh://git@github.com:22/owner/repo.git")).toBe(
      "owner/repo"
    );
  });

  test("SSH with port (no .git)", () => {
    expect(parseRemoteUrl("ssh://git@github.com:443/owner/repo")).toBe(
      "owner/repo"
    );
  });

  test("empty string returns undefined", () => {
    expect(parseRemoteUrl("")).toBeUndefined();
  });

  test("plain string returns undefined", () => {
    expect(parseRemoteUrl("not-a-url")).toBeUndefined();
  });
});
