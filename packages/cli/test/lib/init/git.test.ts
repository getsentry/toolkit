/**
 * Tests for `checkGitStatus`. Stubs the low-level git probes from
 * `src/lib/git.ts` and uses `MockUI` to record/replay all UI traffic.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as gitLib from "../../../src/lib/git.js";
import {
  checkGitStatus,
  getUncommittedOrUntrackedFiles,
  isInsideGitWorkTree,
} from "../../../src/lib/init/git.js";
import { CANCELLED } from "../../../src/lib/init/ui/types.js";
import { createMockUI, type MockCall } from "./ui/mock-ui.js";

let isInsideWorkTreeSpy: ReturnType<typeof spyOn>;
let getUncommittedFilesSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  isInsideWorkTreeSpy = vi.spyOn(gitLib, "isInsideGitWorkTree");
  getUncommittedFilesSpy = vi.spyOn(gitLib, "getUncommittedFiles");
});

afterEach(() => {
  isInsideWorkTreeSpy.mockRestore();
  getUncommittedFilesSpy.mockRestore();
});

function lastWarn(calls: MockCall[]): string | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call?.kind === "log.warn") {
      return call.message;
    }
  }
  return;
}

describe("isInsideGitWorkTree", () => {
  test("returns true when inside git work tree", () => {
    isInsideWorkTreeSpy.mockReturnValue(true);

    expect(isInsideGitWorkTree({ cwd: "/tmp" })).toBe(true);
    expect(isInsideWorkTreeSpy).toHaveBeenCalledWith("/tmp");
  });

  test("returns false when not in git repo", () => {
    isInsideWorkTreeSpy.mockReturnValue(false);

    expect(isInsideGitWorkTree({ cwd: "/tmp" })).toBe(false);
  });
});

describe("getUncommittedOrUntrackedFiles", () => {
  test("returns formatted file list from lib/git", () => {
    getUncommittedFilesSpy.mockReturnValue([
      "-  M src/index.ts",
      "- ?? new-file.ts",
    ]);

    const files = getUncommittedOrUntrackedFiles({ cwd: "/tmp" });

    expect(files).toEqual(["-  M src/index.ts", "- ?? new-file.ts"]);
    expect(getUncommittedFilesSpy).toHaveBeenCalledWith("/tmp");
  });

  test("returns empty array for clean repo", () => {
    getUncommittedFilesSpy.mockReturnValue([]);

    expect(getUncommittedOrUntrackedFiles({ cwd: "/tmp" })).toEqual([]);
  });
});

describe("checkGitStatus", () => {
  test("returns true silently for clean git repo", async () => {
    isInsideWorkTreeSpy.mockReturnValue(true);
    getUncommittedFilesSpy.mockReturnValue([]);

    const { ui, calls } = createMockUI();
    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(true);
    expect(calls.some((c) => c.kind === "confirm")).toBe(false);
    expect(calls.some((c) => c.kind === "log.warn")).toBe(false);
  });

  test("prompts when not in git repo (interactive) and returns true on confirm", async () => {
    isInsideWorkTreeSpy.mockReturnValue(false);
    const { ui, calls, respond } = createMockUI();
    respond.confirm(true);

    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(true);
    const confirmCall = calls.find((c) => c.kind === "confirm");
    expect(confirmCall?.kind === "confirm" && confirmCall.message).toContain(
      "not inside a git repository"
    );
  });

  test("prompts when not in git repo (interactive) and returns false on decline", async () => {
    isInsideWorkTreeSpy.mockReturnValue(false);
    const { ui, respond } = createMockUI();
    respond.confirm(false);

    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(false);
  });

  test("returns false without throwing when user cancels not-in-git-repo prompt", async () => {
    isInsideWorkTreeSpy.mockReturnValue(false);
    const { ui, respond } = createMockUI();
    respond.confirm(CANCELLED);

    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(false);
  });

  test("warns and auto-continues when not in git repo with --yes", async () => {
    isInsideWorkTreeSpy.mockReturnValue(false);
    const { ui, calls } = createMockUI();

    const result = await checkGitStatus({ cwd: "/tmp", yes: true, ui });

    expect(result).toBe(true);
    expect(lastWarn(calls)).toContain("not inside a git repository");
    expect(calls.some((c) => c.kind === "confirm")).toBe(false);
  });

  test("shows files and prompts for dirty tree (interactive), returns true on confirm", async () => {
    isInsideWorkTreeSpy.mockReturnValue(true);
    getUncommittedFilesSpy.mockReturnValue(["-  M dirty.ts"]);
    const { ui, calls, respond } = createMockUI();
    respond.confirm(true);

    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(true);
    expect(lastWarn(calls)).toContain("uncommitted");
    const confirmCall = calls.find((c) => c.kind === "confirm");
    expect(confirmCall?.kind === "confirm" && confirmCall.message).toContain(
      "uncommitted changes"
    );
  });

  test("shows files and prompts for dirty tree (interactive), returns false on decline", async () => {
    isInsideWorkTreeSpy.mockReturnValue(true);
    getUncommittedFilesSpy.mockReturnValue(["-  M dirty.ts"]);
    const { ui, respond } = createMockUI();
    respond.confirm(false);

    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(false);
  });

  test("returns false without throwing when user cancels dirty-tree prompt", async () => {
    isInsideWorkTreeSpy.mockReturnValue(true);
    getUncommittedFilesSpy.mockReturnValue(["-  M dirty.ts"]);
    const { ui, respond } = createMockUI();
    respond.confirm(CANCELLED);

    const result = await checkGitStatus({ cwd: "/tmp", yes: false, ui });

    expect(result).toBe(false);
  });

  test("warns with file list and auto-continues for dirty tree with --yes", async () => {
    isInsideWorkTreeSpy.mockReturnValue(true);
    getUncommittedFilesSpy.mockReturnValue(["-  M dirty.ts", "- ?? new.ts"]);
    const { ui, calls } = createMockUI();

    const result = await checkGitStatus({ cwd: "/tmp", yes: true, ui });

    expect(result).toBe(true);
    const warn = lastWarn(calls);
    expect(warn).toBeDefined();
    expect(warn).toContain("uncommitted");
    expect(warn).toContain("M dirty.ts");
    expect(calls.some((c) => c.kind === "confirm")).toBe(false);
  });
});
