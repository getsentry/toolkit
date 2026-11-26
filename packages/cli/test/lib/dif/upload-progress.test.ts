/**
 * Tests for the `debug-files upload` progress output: log lines on stderr
 * when stdout is not a terminal (CI, pipes), and an in-place spinner with a
 * byte bar on a terminal.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createUploadProgressReporter,
  logFoundDebugFiles,
} from "../../../src/lib/dif/upload-progress.js";

const originalIsTTY = process.stdout.isTTY;

let stderr: string;

beforeEach(() => {
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });
  vi.restoreAllMocks();
});

/** The logged lines, without the level and tag prefix. */
function lines(): string[] {
  return stderr
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\[info\] \[dif\.upload\] /, ""));
}

/**
 * Make stdout look like a terminal and capture what is drawn on it. Timers are
 * faked so a test can advance to the spinner's next frame.
 */
function captureTerminal(): () => string {
  vi.useFakeTimers();
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");
  let drawn = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    drawn += String(chunk);
    return true;
  });
  return () => drawn;
}

describe("debug-files upload progress without a terminal", () => {
  test("logs how many files the scan found", () => {
    logFoundDebugFiles(1);
    logFoundDebugFiles(3);
    expect(lines()).toEqual([
      "Found 1 debug information file",
      "Found 3 debug information files",
    ]);
  });

  test("logs the upload start, each 10% step, and the end", () => {
    const { onProgress } = createUploadProgressReporter();
    const totalBytes = 10 * 1024 * 1024;
    onProgress({ phase: "uploading", files: 2, totalBytes });
    for (const percent of [4, 12, 18, 35, 100]) {
      onProgress({
        phase: "upload-progress",
        uploadedBytes: (totalBytes * percent) / 100,
        totalBytes,
      });
    }
    onProgress({ phase: "uploaded", files: 2 });

    expect(lines()).toEqual([
      "Uploading 2 debug information files (10.0 MB)...",
      "Uploaded 1.2 MB of 10.0 MB (12%)",
      "Uploaded 3.5 MB of 10.0 MB (35%)",
      "Uploaded 2 debug information files",
    ]);
  });

  test("logs that nothing needs uploading", () => {
    createUploadProgressReporter().onProgress({
      phase: "up-to-date",
      files: 4,
    });
    expect(lines()).toEqual([
      "Nothing to upload, all files are already on the server",
    ]);
  });

  test("logs processing once per change", () => {
    const { onProgress } = createUploadProgressReporter();
    for (const processed of [0, 0, 1, 1, 3]) {
      onProgress({ phase: "processing", processed, total: 3 });
    }
    expect(lines()).toEqual([
      "Waiting for Sentry to process 3 debug information files...",
      "Processed 1 of 3 files",
      "Processed 3 of 3 files",
    ]);
  });
});

describe("debug-files upload progress on a terminal", () => {
  test("draws a byte bar in place and logs only the finished upload", () => {
    const terminal = captureTerminal();
    const { onProgress } = createUploadProgressReporter();
    const totalBytes = 10 * 1024 * 1024;

    onProgress({ phase: "uploading", files: 2, totalBytes });
    onProgress({
      phase: "upload-progress",
      uploadedBytes: totalBytes / 2,
      totalBytes,
    });
    // The spinner redraws its message on the next animation frame.
    vi.advanceTimersByTime(100);
    onProgress({ phase: "uploaded", files: 2 });

    expect(terminal()).toContain("Uploading 2 debug information files");
    expect(terminal()).toContain("5.0 MB / 10.0 MB (50%)");
    // The spinner clears its line when the upload finishes.
    expect(terminal().endsWith("\r\x1b[K")).toBe(true);
    expect(lines()).toEqual(["Uploaded 2 debug information files"]);
  });

  test("shows processing in place until every file is done", () => {
    const terminal = captureTerminal();
    const { onProgress } = createUploadProgressReporter();

    onProgress({ phase: "processing", processed: 0, total: 2 });
    onProgress({ phase: "processing", processed: 2, total: 2 });

    expect(terminal()).toContain(
      "Waiting for Sentry to process 2 debug information files... 0/2",
    );
    expect(terminal().endsWith("\r\x1b[K")).toBe(true);
    expect(lines()).toEqual(["Processed 2 of 2 files"]);
  });

  test("stop clears a spinner left by a failed upload", () => {
    const terminal = captureTerminal();
    const reporter = createUploadProgressReporter();

    reporter.onProgress({ phase: "uploading", files: 1, totalBytes: 2048 });
    reporter.stop();

    expect(terminal().endsWith("\r\x1b[K")).toBe(true);
    expect(stderr).toBe("");
  });
});
