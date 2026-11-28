import { beforeEach, describe, it, vi, expect } from "vitest";

import {
  getUncommittedOrUntrackedFilePaths,
  isInGitRepo,
} from "../../../../src/lib/wizard/utils/git.js";

const { mockedExecSync } = vi.hoisted(() => {
  return { mockedExecSync: vi.fn() };
});

vi.mock("node:child_process", async () => {
  return {
    default: {},
    ...(await vi.importActual("node:child_process")),
    execSync: mockedExecSync,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isInGitRepo", () => {
  it("returns true if the git command process exits with 0", () => {
    mockedExecSync.mockImplementationOnce(() => {
      return "true";
    });
    expect(isInGitRepo({ cwd: undefined })).toBe(true);
  });

  it("returns false if the git command process exits with non-zero", () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("Command failed");
    });
    expect(isInGitRepo({ cwd: undefined })).toBe(false);
  });

  it("forwards cwd if provided", () => {
    mockedExecSync.mockImplementationOnce(() => {
      return "true";
    });
    isInGitRepo({ cwd: "/path/to/dir" });
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git rev-parse --is-inside-work-tree",
      {
        stdio: "ignore",
        cwd: "/path/to/dir",
      },
    );
  });
});

describe("getUncommittedOrUntrackedFilePaths", () => {
  it("returns the verbatim paths of uncommitted or untracked files", () => {
    mockedExecSync.mockImplementationOnce(() => {
      return (
        " M file1.txt\0" +
        "?? file2.txt\0" +
        "?? file3.txt\0" +
        "?? file4.txt\0"
      );
    });
    expect(getUncommittedOrUntrackedFilePaths()).toEqual([
      "file1.txt",
      "file2.txt",
      "file3.txt",
      "file4.txt",
    ]);
  });

  it("uses the NUL-delimited porcelain format", () => {
    mockedExecSync.mockImplementationOnce(() => "");

    getUncommittedOrUntrackedFilePaths({ cwd: "/path/to/dir" });

    expect(mockedExecSync).toHaveBeenCalledWith(
      "git status --porcelain=v1 -z",
      {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: "/path/to/dir",
      },
    );
  });

  it("preserves file names containing spaces and shell metacharacters", () => {
    mockedExecSync.mockImplementationOnce(() => {
      return (
        "?? $(touch pwned).js\0" +
        "?? a;id;b.js\0" +
        "?? with space.txt\0" +
        " M `whoami`.ts\0"
      );
    });
    expect(getUncommittedOrUntrackedFilePaths()).toEqual([
      "$(touch pwned).js",
      "a;id;b.js",
      "with space.txt",
      "`whoami`.ts",
    ]);
  });

  it("returns the destination path of a rename and skips the source field", () => {
    mockedExecSync.mockImplementationOnce(() => {
      return "R  renamed.txt\0orig.txt\0?? other.txt\0";
    });
    expect(getUncommittedOrUntrackedFilePaths()).toEqual([
      "renamed.txt",
      "other.txt",
    ]);
  });

  it("returns an empty list if there are no uncommitted or untracked files", () => {
    mockedExecSync.mockImplementationOnce(() => "");

    expect(getUncommittedOrUntrackedFilePaths()).toEqual([]);
  });

  it("returns an empty list if the git command fails", () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("Command failed");
    });

    expect(getUncommittedOrUntrackedFilePaths()).toEqual([]);
  });
});
