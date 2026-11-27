import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixLineEndings } from "../../../../src/lib/wizard/utils/line-endings.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as git from "../../../../src/lib/wizard/utils/git.js";

describe("fixLineEndings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "line-endings-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    vi.restoreAllMocks();
  });

  it("normalizes mixed line endings to CRLF when file has CRLF", () => {
    const filePath = path.join(tmpDir, "mixed.dart");
    writeFileSync(filePath, "line1\r\nline2\nline3\r\n", "utf8");

    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([
      filePath,
    ]);

    fixLineEndings();

    const result = readFileSync(filePath, "utf8");
    expect(result).toBe("line1\r\nline2\r\nline3\r\n");
  });

  it("skips files that are pure LF", () => {
    const filePath = path.join(tmpDir, "lf.dart");
    const original = "line1\nline2\n";
    writeFileSync(filePath, original, "utf8");

    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([
      filePath,
    ]);

    fixLineEndings();

    const result = readFileSync(filePath, "utf8");
    expect(result).toBe(original);
  });

  it("leaves consistent CRLF files unchanged", () => {
    const filePath = path.join(tmpDir, "crlf.dart");
    const original = "line1\r\nline2\r\n";
    writeFileSync(filePath, original, "utf8");

    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([
      filePath,
    ]);

    fixLineEndings();

    const result = readFileSync(filePath, "utf8");
    expect(result).toBe(original);
  });

  it("skips non-text files", () => {
    const filePath = path.join(tmpDir, "image.png");
    const original = "line1\r\nline2\nline3\r\n";
    writeFileSync(filePath, original, "utf8");

    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([
      filePath,
    ]);

    fixLineEndings();

    const result = readFileSync(filePath, "utf8");
    expect(result).toBe(original);
  });

  it("skips directories", () => {
    const dirPath = path.join(tmpDir, "subdir");
    mkdirSync(dirPath);

    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([
      dirPath,
    ]);

    expect(() => fixLineEndings()).not.toThrow();
  });

  it("skips nonexistent files", () => {
    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([
      "nonexistent.txt",
    ]);

    expect(() => fixLineEndings()).not.toThrow();
  });

  it("does nothing when there are no modified files", () => {
    vi.spyOn(git, "getUncommittedOrUntrackedFilePaths").mockReturnValue([]);

    expect(() => fixLineEndings()).not.toThrow();
  });
});
