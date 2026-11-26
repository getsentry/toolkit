/**
 * Tests for the `debug-files upload` progress lines: which upload phases log
 * a line, and that byte progress is throttled to 10% steps.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createUploadProgressLogger,
  logFoundDebugFiles,
} from "../../../src/lib/dif/upload-progress.js";

let stderr: string;

beforeEach(() => {
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The logged lines, without the level and tag prefix. */
function lines(): string[] {
  return stderr
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\[info\] \[dif\.upload\] /, ""));
}

describe("debug-files upload progress", () => {
  test("logs how many files the scan found", () => {
    logFoundDebugFiles(1);
    logFoundDebugFiles(3);
    expect(lines()).toEqual([
      "Found 1 debug information file",
      "Found 3 debug information files",
    ]);
  });

  test("logs the upload start, each 10% step, and the end", () => {
    const report = createUploadProgressLogger();
    const totalBytes = 10 * 1024 * 1024;
    report({ phase: "uploading", files: 2, totalBytes });
    for (const percent of [4, 12, 18, 35, 100]) {
      report({
        phase: "upload-progress",
        uploadedBytes: (totalBytes * percent) / 100,
        totalBytes,
      });
    }
    report({ phase: "uploaded", files: 2 });

    expect(lines()).toEqual([
      "Uploading 2 debug information files (10.0 MB)...",
      "Uploaded 1.2 MB of 10.0 MB (12%)",
      "Uploaded 3.5 MB of 10.0 MB (35%)",
      "Uploaded 2 debug information files",
    ]);
  });

  test("logs that nothing needs uploading", () => {
    createUploadProgressLogger()({ phase: "up-to-date", files: 4 });
    expect(lines()).toEqual([
      "Nothing to upload, all files are already on the server",
    ]);
  });

  test("logs processing once per change", () => {
    const report = createUploadProgressLogger();
    for (const processed of [0, 0, 1, 1, 3]) {
      report({ phase: "processing", processed, total: 3 });
    }
    expect(lines()).toEqual([
      "Waiting for Sentry to process 3 debug information files...",
      "Processed 1 of 3 files",
      "Processed 3 of 3 files",
    ]);
  });
});
