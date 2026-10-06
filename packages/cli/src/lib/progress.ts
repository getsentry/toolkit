/**
 * Byte-driven progress reporting for long-running upgrade phases (patch apply,
 * full-binary download).
 *
 * sentry upgrade already runs under `withProgress`, which animates a spinner
 * and passes down a `setMessage(text)` callback. To avoid two competing
 * in-place redraws fighting over the same terminal line, this helper does NOT
 * draw its own bar — it formats a compact progress string and pushes it into
 * that `setMessage` callback, so the byte counter rides on the existing spinner.
 *
 * Design contract:
 * - Cosmetic ONLY — a formatting/callback failure must never abort the work.
 * - Determinate ("152 MB / 310 MB [====> ] 49%") when a byte `total` is given;
 *   an indeterminate byte counter ("38 MB") otherwise (the decompressed
 *   download size isn't known ahead of time).
 * - Updates are throttled so a fast byte stream doesn't spam the spinner.
 */

import { formatBytes } from "./formatters/numbers.js";

/** Callback that sets the surrounding spinner's message text. */
export type SetMessage = (message: string) => void;

/**
 * How a determinate bar renders its progress fraction.
 *
 * - `"bytes"` (default) renders the accumulated/total byte count alongside the
 *   bar — useful when the total is a meaningful size the user can reason about
 *   (e.g. a full-binary download).
 * - `"pct"` renders only the percentage — useful when the byte total is
 *   misleading (e.g. a multi-hop patch chain whose summed `newSize` far
 *   exceeds the final binary, so "1.5 GB / 3.1 GB" would scare the user
 *   about an install that's actually 310 MB).
 */
export type ByteProgressFormat = "bytes" | "pct";

export type ByteProgress = {
  /** Report `bytes` additional bytes processed since the last call. */
  onProgress: (bytes: number) => void;
  /** Emit a final message reflecting the total processed (best-effort). */
  done: () => void;
};

const BAR_WIDTH = 16;
/** Minimum gap between spinner message updates. */
const THROTTLE_MS = 100;

function renderBar(frac: number, width = BAR_WIDTH): string {
  const filled = Math.max(0, Math.min(width, Math.round(width * frac)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Options for {@link makeByteProgress} beyond the first three required args.
 *
 * Kept as a separate options bag so the helper stays under the lint max-params
 * budget (`useMaxParams: 4`) — four-position call sites don't change.
 */
export type MakeByteProgressOptions = {
  /**
   * Determinate render format. `"bytes"` (default) shows the accumulated/total
   * byte count; `"pct"` shows only the percentage (no byte counter). Ignored
   * when `totalBytes` is null — indeterminate byte counters always show the
   * live byte total.
   */
  format?: ByteProgressFormat;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
};

/**
 * Create a byte-progress reporter that feeds a spinner `setMessage` callback.
 *
 * @param label - Short label prefix (e.g. "Applying 3 patch(es)").
 * @param totalBytes - Expected total bytes; `null` renders an indeterminate
 *   byte counter instead of a bar.
 * @param setMessage - Spinner message setter (from `withProgress`). When
 *   undefined (JSON mode / non-TTY / no surrounding spinner), this is a no-op
 *   so nothing is drawn.
 * @param options - Optional render tweaks (format, injectable clock).
 */
export function makeByteProgress(
  label: string,
  totalBytes: number | null,
  setMessage: SetMessage | undefined,
  options: MakeByteProgressOptions = {}
): ByteProgress {
  const { format = "bytes", nowMs = Date.now } = options;
  let written = 0;
  let lastEmit = 0;

  const render = (): string => {
    if (totalBytes === null || totalBytes <= 0) {
      return `${label} ${formatBytes(written)}`;
    }
    const frac = Math.min(written / totalBytes, 1);
    const pct = Math.round(frac * 100);
    if (format === "pct") {
      return `${label} [${renderBar(frac)}] ${pct}%`;
    }
    return (
      `${label} [${renderBar(frac)}] ` +
      `${formatBytes(written)} / ${formatBytes(totalBytes)} (${pct}%)`
    );
  };

  const emit = (): void => {
    // Cosmetic only — a formatting or callback failure must never propagate.
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      setMessage?.(render());
    } catch {
      // ignore — progress is cosmetic
    }
  };

  const onProgress = (bytes: number): void => {
    written += bytes;
    if (!setMessage) {
      return;
    }
    const now = nowMs();
    if (now - lastEmit < THROTTLE_MS) {
      return;
    }
    lastEmit = now;
    emit();
  };

  // Emit a final, un-throttled message so the last state is always shown.
  const done = (): void => {
    emit();
  };

  return { onProgress, done };
}
