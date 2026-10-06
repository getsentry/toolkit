import { afterEach, describe, expect, test, vi } from "vitest";

// Mock node:child_process so getCommitLog never shells out to a real git.
const execFileSyncMock = vi.fn(() => "");
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { getCommitLog } from "../../src/lib/git.js";

/** Extract the argv passed to the mocked git invocation. */
function lastGitArgs(): string[] {
  const call = execFileSyncMock.mock.calls.at(-1);
  // execFileSync(file, args, options)
  return (call?.[1] ?? []) as string[];
}

describe("getCommitLog pathspec argv", () => {
  afterEach(() => {
    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValue("");
  });

  test("appends `--` and paths when paths provided", () => {
    getCommitLog("/repo", { paths: ["apps/mobile", "packages/shared"] });

    const args = lastGitArgs();
    expect(args).toContain("--");
    const sep = args.indexOf("--");
    expect(args.slice(sep + 1)).toEqual(["apps/mobile", "packages/shared"]);
  });

  test("omits `--` when no paths provided", () => {
    getCommitLog("/repo", {});
    expect(lastGitArgs()).not.toContain("--");
  });

  test("omits `--` for empty paths array", () => {
    getCommitLog("/repo", { paths: [] });
    expect(lastGitArgs()).not.toContain("--");
  });

  test("pathspec follows the commit range", () => {
    getCommitLog("/repo", { from: "abc123", paths: ["src"] });

    const args = lastGitArgs();
    const rangeIdx = args.indexOf("abc123..HEAD");
    const sepIdx = args.indexOf("--");
    expect(rangeIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(rangeIdx);
  });

  test("adds --max-count when a positive depth is given", () => {
    getCommitLog("/repo", { depth: 50 });
    expect(lastGitArgs()).toContain("--max-count=50");
  });

  // Guards callers that omit depth from accidentally walking all history.
  test("defaults to --max-count=20 when depth is omitted", () => {
    getCommitLog("/repo", {});
    expect(lastGitArgs()).toContain("--max-count=20");
  });

  test("omits --max-count only when from is set with non-positive depth", () => {
    getCommitLog("/repo", { from: "abc123", depth: 0 });
    const args = lastGitArgs();
    expect(args.some((a) => a.startsWith("--max-count="))).toBe(false);
    expect(args).toContain("abc123..HEAD");
  });

  test("keeps --max-count when depth is non-positive but from is absent", () => {
    getCommitLog("/repo", { depth: 0 });
    expect(lastGitArgs()).toContain("--max-count=0");
  });

  // Guards against git argument injection: a `from` like "--format=x" must be
  // rejected rather than passed through as a git option. Version-independent
  // (no reliance on --end-of-options, which requires git >= 2.24).
  test("throws on an option-like `from` ref", () => {
    expect(() => getCommitLog("/repo", { from: "--format=%H" })).toThrow(
      "must be a git ref, not a CLI flag"
    );
    expect(() => getCommitLog("/repo", { from: "--format=%H" })).toThrow(
      "Git refs cannot start with '-'"
    );
    expect(() => getCommitLog("/repo", { from: "--format=%H" })).not.toThrow(
      "use the equals form"
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  test("throws ValidationError when the from ref is unknown", () => {
    const gitError = Object.assign(new Error("Command failed"), {
      stderr:
        "fatal: ambiguous argument 'bogus-ref..HEAD': unknown revision or path not in the working tree.\n",
    });
    execFileSyncMock.mockImplementation(() => {
      throw gitError;
    });

    expect(() => getCommitLog("/repo", { from: "bogus-ref" })).toThrow(
      "Unknown git ref 'bogus-ref': not found in this repository."
    );
    expect(() => getCommitLog("/repo", { from: "bogus-ref" })).toThrow(
      "git rev-parse bogus-ref"
    );
  });

  // Uncapped `--from` ranges can emit >1 MB, so git() must raise maxBuffer
  // above execFileSync's 1 MB default to avoid crashing on large histories.
  test("passes a large maxBuffer to execFileSync", () => {
    getCommitLog("/repo", { from: "abc123" });
    const call = execFileSyncMock.mock.calls.at(-1);
    const options = call?.[2] as { maxBuffer?: number } | undefined;
    expect(options?.maxBuffer).toBeGreaterThanOrEqual(100 * 1024 * 1024);
  });

  test("parses NUL-delimited git output into commits", () => {
    execFileSyncMock.mockReturnValue(
      "abc\x00subject\x00Jane\x00jane@example.com\x002026-01-01T00:00:00Z"
    );

    const commits = getCommitLog("/repo", { paths: ["src"] });
    expect(commits).toEqual([
      {
        id: "abc",
        message: "subject",
        author_name: "Jane",
        author_email: "jane@example.com",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
  });
});
