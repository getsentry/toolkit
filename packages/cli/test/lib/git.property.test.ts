import { array, constantFrom, assert as fcAssert, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { isSameRepository, parseRemoteUrl } from "../../src/lib/git.js";
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
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("HTTPS URL without .git suffix → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `https://github.com/${owner}/${repo}`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("SSH URL → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `git@github.com:${owner}/${repo}.git`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("SSH URL without .git suffix → owner/repo", () => {
    fcAssert(
      property(ownerArb, repoArb, (owner, repo) => {
        const url = `git@github.com:${owner}/${repo}`;
        const result = parseRemoteUrl(url);
        expect(result).toBe(`${owner}/${repo}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});

describe("unit: parseRemoteUrl edge cases", () => {
  test("standard GitHub HTTPS", () => {
    expect(parseRemoteUrl("https://github.com/getsentry/cli.git")).toBe(
      "getsentry/cli",
    );
  });

  test("standard GitHub SSH", () => {
    expect(parseRemoteUrl("git@github.com:getsentry/cli.git")).toBe(
      "getsentry/cli",
    );
  });

  test("GitLab HTTPS", () => {
    expect(parseRemoteUrl("https://gitlab.com/my-group/my-project.git")).toBe(
      "my-group/my-project",
    );
  });

  test("Bitbucket SSH", () => {
    expect(parseRemoteUrl("git@bitbucket.org:team/repo.git")).toBe("team/repo");
  });

  test("SSH with port (ssh:// protocol)", () => {
    expect(parseRemoteUrl("ssh://git@github.com:22/owner/repo.git")).toBe(
      "owner/repo",
    );
  });

  test("SSH with port (no .git)", () => {
    expect(parseRemoteUrl("ssh://git@github.com:443/owner/repo")).toBe(
      "owner/repo",
    );
  });

  test("empty string returns undefined", () => {
    expect(parseRemoteUrl("")).toBeUndefined();
  });

  test("plain string returns undefined", () => {
    expect(parseRemoteUrl("not-a-url")).toBeUndefined();
  });
});

describe("unit: isSameRepository", () => {
  test.each([
    {
      case: "matches a GitHub repository by name",
      repo: { name: "getsentry/cli", url: "https://github.com/getsentry/cli" },
      path: "GetSentry/CLI",
      expected: true,
    },
    {
      case: "matches a GitLab display name by its URL path",
      repo: { name: "Acme Corp / Web", url: "https://gitlab.com/acme/web" },
      path: "acme/web",
      expected: true,
    },
    {
      case: "matches an Azure DevOps repository by its URL path",
      repo: {
        name: "storefront",
        url: "https://dev.azure.com/acme/web/_git/storefront",
      },
      path: "acme/web/_git/storefront",
      expected: true,
    },
    {
      case: "skips a display name whose URL is another project",
      repo: { name: "Acme / Web", url: "https://gitlab.com/archive/acme/web" },
      path: "acme/web",
      expected: false,
    },
    {
      case: "matches a display name when there is no URL",
      repo: { name: "Acme / Web", url: null },
      path: "acme/web",
      expected: true,
    },
  ])("$case", ({ repo, path, expected }) => {
    expect(isSameRepository(repo, path)).toBe(expected);
  });
});
