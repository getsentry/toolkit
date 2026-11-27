/**
 * Progress output for `sentry debug-files upload`.
 *
 * Turns {@link DebugFilesUploadProgress} events into progress the user sees
 * while files upload, as the legacy sentry-cli did:
 *
 * - On a terminal, the chunk upload and the `--wait` processing each draw an
 *   in-place spinner with a byte bar or a file count, and a log line on
 *   stderr records each finished phase.
 * - Elsewhere (CI, pipes), only log lines go to stderr. Byte progress is
 *   logged at each 10% step, so a long upload shows it is moving without
 *   flooding the log.
 *
 * The spinner draws on stdout only when stdout is a terminal, so a redirected
 * command result stays clean.
 */

import type { DebugFilesUploadProgress } from "../api/debug-files.js";
import { formatBytes } from "../formatters/numbers.js";
import { logger } from "../logger.js";
import { type ProgressLine, startProgressLine } from "../polling.js";
import { type ByteProgress, makeByteProgress } from "../progress.js";

const log = logger.withTag("dif.upload");

/** Percent step between two byte-progress log lines. */
const PROGRESS_STEP_PERCENT = 10;

/** "1 debug information file" / "N debug information files". */
function difCount(count: number): string {
  return `${count} debug information ${count === 1 ? "file" : "files"}`;
}

/** "1 file" / "N files". */
function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** Log how many debug information files the scan found. */
export function logFoundDebugFiles(count: number): void {
  log.info(`Found ${difCount(count)}`);
}

/** Progress callbacks for `uploadDebugFiles`. */
export type UploadProgressReporter = {
  /** Pass as `uploadDebugFiles`'s `onProgress`. */
  onProgress: (event: DebugFilesUploadProgress) => void;
  /** Clear a spinner still on screen, such as after a failed upload. */
  stop: () => void;
};

/**
 * Create the progress reporter for one upload. Repeated processing polls with
 * no change show nothing new.
 */
export function createUploadProgressReporter(): UploadProgressReporter {
  let line: ProgressLine | null = null;
  let bytes: ByteProgress | undefined;
  let uploadedBytes = 0;
  let lastStep = 0;
  let lastProcessed = -1;

  const stop = () => {
    line?.stop();
    line = null;
    bytes = undefined;
  };

  const onUploadProgress = (uploaded: number, total: number) => {
    if (bytes) {
      bytes.onProgress(uploaded - uploadedBytes);
      uploadedBytes = uploaded;
      return;
    }
    if (total <= 0) {
      return;
    }
    const percent = Math.floor((uploaded * 100) / total);
    const step =
      Math.floor(percent / PROGRESS_STEP_PERCENT) * PROGRESS_STEP_PERCENT;
    // 100% is left to the `uploaded` line that follows.
    if (step > lastStep && percent < 100) {
      lastStep = step;
      log.info(
        `Uploaded ${formatBytes(uploaded)} of ${formatBytes(total)} (${percent}%)`,
      );
    }
  };

  const onProcessing = (processed: number, total: number) => {
    const changed = processed !== lastProcessed;
    const first = lastProcessed < 0;
    lastProcessed = processed;
    if (processed >= total) {
      if (changed) {
        stop();
        log.info(`Processed ${processed} of ${fileCount(total)}`);
      }
      return;
    }
    const message = `Waiting for Sentry to process ${difCount(total)}... ${processed}/${total}`;
    if (line) {
      line.setMessage(message);
      return;
    }
    // Start the spinner on the first poll, and again after a chunk re-send
    // stopped it.
    line = startProgressLine(message);
    if (line || !changed) {
      return;
    }
    log.info(
      first
        ? `Waiting for Sentry to process ${difCount(total)}...`
        : `Processed ${processed} of ${fileCount(total)}`,
    );
  };

  const onProgress = (event: DebugFilesUploadProgress) => {
    switch (event.phase) {
      case "up-to-date":
        log.info("Nothing to upload, all files are already on the server");
        break;
      case "uploading": {
        stop();
        const label = `Uploading ${difCount(event.files)}`;
        line = startProgressLine(`${label}...`);
        uploadedBytes = 0;
        lastStep = 0;
        if (line) {
          bytes = makeByteProgress(label, event.totalBytes, line.setMessage);
        } else {
          log.info(`${label} (${formatBytes(event.totalBytes)})...`);
        }
        break;
      }
      case "upload-progress":
        onUploadProgress(event.uploadedBytes, event.totalBytes);
        break;
      case "uploaded":
        stop();
        log.info(`Uploaded ${difCount(event.files)}`);
        break;
      case "processing":
        onProcessing(event.processed, event.total);
        break;
    }
  };

  return { onProgress, stop };
}
