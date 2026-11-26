/**
 * Progress lines for `sentry debug-files upload`.
 *
 * Turns {@link DebugFilesUploadProgress} events into logger lines on stderr,
 * as the legacy sentry-cli did, so stdout keeps only the command result.
 * Byte progress is logged at each 10% step: a long upload shows it is moving,
 * in a terminal and in CI logs, without flooding either.
 */

import type { DebugFilesUploadProgress } from "../api/debug-files.js";
import { formatBytes } from "../formatters/numbers.js";
import { logger } from "../logger.js";

const log = logger.withTag("dif.upload");

/** Percent step between two byte-progress lines. */
const PROGRESS_STEP_PERCENT = 10;

/** "1 debug information file" / "N debug information files". */
function difCount(count: number): string {
  return `${count} debug information ${count === 1 ? "file" : "files"}`;
}

/** Log how many debug information files the scan found. */
export function logFoundDebugFiles(count: number): void {
  log.info(`Found ${difCount(count)}`);
}

/**
 * Create an `onProgress` callback for `uploadDebugFiles` that logs each
 * upload phase. Repeated processing polls with no change log nothing.
 */
export function createUploadProgressLogger(): (
  event: DebugFilesUploadProgress,
) => void {
  let lastStep = 0;
  let lastProcessed = -1;
  return (event) => {
    switch (event.phase) {
      case "up-to-date":
        log.info("Nothing to upload, all files are already on the server");
        break;
      case "uploading":
        lastStep = 0;
        log.info(
          `Uploading ${difCount(event.files)} (${formatBytes(event.totalBytes)})...`,
        );
        break;
      case "upload-progress": {
        if (event.totalBytes <= 0) {
          break;
        }
        const percent = Math.floor(
          (event.uploadedBytes * 100) / event.totalBytes,
        );
        const step =
          Math.floor(percent / PROGRESS_STEP_PERCENT) * PROGRESS_STEP_PERCENT;
        // 100% is left to the `uploaded` line that follows.
        if (step > lastStep && percent < 100) {
          lastStep = step;
          log.info(
            `Uploaded ${formatBytes(event.uploadedBytes)} of ${formatBytes(event.totalBytes)} (${percent}%)`,
          );
        }
        break;
      }
      case "uploaded":
        log.info(`Uploaded ${difCount(event.files)}`);
        break;
      case "processing":
        if (event.processed === lastProcessed) {
          break;
        }
        if (lastProcessed < 0 && event.processed < event.total) {
          log.info(`Waiting for Sentry to process ${difCount(event.total)}...`);
        } else {
          log.info(
            `Processed ${event.processed} of ${event.total} ${event.total === 1 ? "file" : "files"}`,
          );
        }
        lastProcessed = event.processed;
        break;
    }
  };
}
