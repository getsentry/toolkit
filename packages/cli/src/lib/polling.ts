/**
 * Generic Polling Utility
 *
 * Provides a reusable polling mechanism with progress spinner display.
 * Used by commands that need to wait for async operations to complete.
 */

import { setTimeout as sleepMs } from "node:timers/promises";
import { TimeoutError } from "./errors.js";
import { isPlainOutput } from "./formatters/plain-detect.js";
import {
  formatProgressLine,
  truncateProgressMessage,
} from "./formatters/seer.js";

/** Default polling interval in milliseconds */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Animation interval for spinner updates — 50ms gives 20fps, matching the ora/inquirer standard */
const ANIMATION_INTERVAL_MS = 50;

/** Default interval between automatic progress-message updates. */
const DEFAULT_PROGRESS_ROTATION_INTERVAL_MS = 4000;

/** Default timeout in milliseconds (6 minutes) */
const DEFAULT_TIMEOUT_MS = 360_000;

/**
 * Options for the generic poll function.
 */
export type PollOptions<T> = {
  /** Function to fetch current state */
  fetchState: () => Promise<T | null>;
  /** Predicate to determine if polling should stop */
  shouldStop: (state: T) => boolean;
  /** Get progress message from state */
  getProgressMessage: (state: T) => string;
  /** Suppress progress output (JSON mode) */
  json?: boolean;
  /** Poll interval in ms (default: 1000) */
  pollIntervalMs?: number;
  /** Timeout in ms (default: 360000 / 6 min) */
  timeoutMs?: number;
  /** Custom timeout message */
  timeoutMessage?: string;
  /** Actionable hint appended to the TimeoutError (e.g., "Run the command again…") */
  timeoutHint?: string;
  /** Initial progress message */
  initialMessage?: string;
};

/**
 * Generic polling function with animated progress display.
 *
 * Polls the fetchState function until shouldStop returns true or timeout is reached.
 * Displays an animated spinner with progress messages when not in JSON mode.
 * Animation runs at 50ms intervals (20fps) independently of polling frequency.
 *
 * @typeParam T - The type of state being polled
 * @param options - Polling configuration
 * @returns The final state when shouldStop returns true
 * @throws {TimeoutError} When timeout is reached before shouldStop returns true
 *
 * @example
 * ```typescript
 * const finalState = await poll({
 *   fetchState: () => getAutofixState(org, issueId),
 *   shouldStop: (state) => isTerminalStatus(state.status),
 *   getProgressMessage: (state) => state.message ?? "Processing...",
 *   json: false,
 *   timeoutMs: 360_000,
 *   timeoutMessage: "Operation timed out after 6 minutes.",
 * });
 * ```
 */
export async function poll<T>(options: PollOptions<T>): Promise<T> {
  const {
    fetchState,
    shouldStop,
    getProgressMessage,
    json = false,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    timeoutMessage = "Operation timed out after 6 minutes. Try again or check the Sentry web UI.",
    timeoutHint,
    initialMessage = "Waiting for operation to start...",
  } = options;

  const startTime = Date.now();
  const suppress = json || isPlainOutput();
  const spinner = suppress ? null : startSpinner(initialMessage);

  try {
    while (Date.now() - startTime < timeoutMs) {
      const state = await fetchState();

      if (state) {
        // Always call getProgressMessage (callers may rely on the callback
        // being invoked), but only forward the result to the spinner.
        const msg = getProgressMessage(state);
        spinner?.setMessage(msg);

        if (shouldStop(state)) {
          return state;
        }
      }

      await sleepMs(pollIntervalMs);
    }

    throw new TimeoutError(timeoutMessage, timeoutHint);
  } finally {
    spinner?.stop();
    if (!suppress) {
      process.stdout.write("\n");
    }
  }
}

/**
 * Start an animated spinner that writes progress to stdout.
 *
 * Uses stdout so the spinner doesn't collide with consola log messages
 * on stderr. The spinner is erased before command output is written,
 * and is suppressed entirely in JSON mode and when stdout is not a TTY.
 *
 * Returns a controller with `setMessage` to update the displayed text
 * and `stop` to halt the animation.
 */
function startSpinner(initialMessage: string): {
  setMessage: (msg: string) => void;
  stop: () => void;
} {
  let currentMessage = initialMessage;
  let tick = 0;
  let stopped = false;

  const scheduleFrame = () => {
    if (stopped) {
      return;
    }
    const display = truncateProgressMessage(currentMessage);
    process.stdout.write(`\r\x1b[K${formatProgressLine(display, tick)}`);
    tick += 1;
    setTimeout(scheduleFrame, ANIMATION_INTERVAL_MS).unref();
  };
  scheduleFrame();

  return {
    setMessage: (msg: string) => {
      currentMessage = msg;
    },
    stop: () => {
      stopped = true;
    },
  };
}

/**
 * Options for {@link withProgress}.
 */
export type WithProgressOptions = {
  /** Initial spinner message displayed until a rotating message replaces it. */
  message: string;
  /** Suppress progress output (JSON mode). When true, the operation runs
   *  without a spinner — matching the behaviour of {@link poll}. */
  json?: boolean;
  /**
   * Suppress progress when stdout is not a terminal, even if rich output is
   * explicitly forced. Use for terminal-only feedback that must not enter a
   * machine-readable pipe.
   */
  interactiveOnly?: boolean;
  /**
   * Messages to show in sequence while the operation is pending. Omit or pass
   * an empty array to leave the initial message in place.
   */
  rotatingMessages?: readonly string[];
  /**
   * Milliseconds between rotating-message updates. Defaults to 4 seconds and
   * is ignored when {@link rotatingMessages} is empty.
   */
  rotationIntervalMs?: number;
};

/**
 * Run an async operation with an animated spinner on stdout.
 *
 * The spinner uses the same braille frames as the Seer polling spinner,
 * giving a consistent look across all CLI commands. Progress output goes
 * to stdout so it doesn't collide with consola log messages on stderr.
 *
 * The spinner is suppressed when:
 * - `options.json` is true (JSON mode — no ANSI noise for agents/CI)
 * - stdout is not a TTY / plain output mode is active (piped output)
 *
 * The callback receives a `setMessage` function to update the displayed
 * message as work progresses (e.g. to show page counts during pagination).
 * Optional rotating messages provide friendly feedback for operations whose
 * progress cannot be measured directly. Progress is automatically cleared
 * when the operation completes or fails.
 *
 * @param options - Spinner configuration
 * @param fn - Async operation to run; receives `setMessage` to update the displayed text
 * @returns The value returned by `fn`
 *
 * @example
 * ```typescript
 * const result = await withProgress(
 *   { message: "Fetching issues..." },
 *   async (setMessage) => {
 *     const data = await fetchWithPages({
 *       onPage: (fetched, total) => setMessage(`Fetching issues... ${fetched}/${total}`),
 *     });
 *     return data;
 *   }
 * );
 * ```
 */
export async function withProgress<T>(
  options: WithProgressOptions,
  fn: (setMessage: (msg: string) => void) => Promise<T>
): Promise<T> {
  if (
    options.json ||
    isPlainOutput() ||
    (options.interactiveOnly && !process.stdout.isTTY)
  ) {
    // JSON mode or non-TTY: skip the spinner entirely, pass a no-op setMessage
    return fn(() => {
      /* spinner suppressed */
    });
  }

  const spinner = startSpinner(options.message);
  const rotatingMessages = options.rotatingMessages ?? [];
  const rotationIntervalMs =
    options.rotationIntervalMs ?? DEFAULT_PROGRESS_ROTATION_INTERVAL_MS;
  let rotationTimer: NodeJS.Timeout | undefined;

  if (rotatingMessages.length > 0 && rotationIntervalMs > 0) {
    let messageIndex = 0;
    rotationTimer = setInterval(() => {
      const message = rotatingMessages[messageIndex];
      if (message !== undefined) {
        spinner.setMessage(message);
      }
      messageIndex = (messageIndex + 1) % rotatingMessages.length;
    }, rotationIntervalMs);
    rotationTimer.unref();
  }

  try {
    return await fn(spinner.setMessage);
  } finally {
    if (rotationTimer) {
      clearInterval(rotationTimer);
    }
    spinner.stop();
    process.stdout.write("\r\x1b[K");
  }
}
