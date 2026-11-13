/**
 * Runs the select picker on the user's terminal.
 *
 * **Stdin.** The picker reads keys from a freshly opened `/dev/tty`
 * `ReadStream` and closes it after the selection, so its raw-mode reads
 * never touch `process.stdin`, which later prompts in the same run still
 * use. It also covers runtimes whose `process.stdin` accepts
 * `setRawMode(true)` but never delivers data (vadimdemedes/ink#636).
 */

import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import { stripAnsi } from "../formatters/plain-detect.js";
import { type MountedPicker, mountSelectPrompt } from "./picker.js";
import type { SelectOptions, SelectPrompt } from "./types.js";

/**
 * Open a fresh `/dev/tty` `ReadStream` for the picker. Returns `null` when
 * `/dev/tty` isn't available (non-TTY environment, or platforms that don't
 * expose it — Windows). The caller falls back to `process.stdin` then.
 */
function openFreshTty(): ReadStream | null {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const fd = openSync("/dev/tty", "r");
    return new ReadStream(fd);
  } catch {
    return null;
  }
}

/** Build the prompt the picker renders from the caller's options. */
function createSelectPrompt(
  opts: SelectOptions<string>,
  resolve: (value: string | null) => void,
): SelectPrompt {
  return {
    message: stripAnsi(opts.message),
    options: opts.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
    })),
    initialIndex:
      opts.initialValue !== undefined
        ? Math.max(
            0,
            opts.options.findIndex(
              (option) => option.value === opts.initialValue,
            ),
          )
        : 0,
    resolve,
  };
}

/**
 * Show an inline entity picker with type-to-filter, and release the
 * terminal after selection.
 *
 * @param opts - Choices, prompt copy, and initial selection. Filtering is always enabled.
 * @returns The selected value, or `null` on cancellation.
 * @throws Propagates rendering, terminal input, and terminal cleanup failures.
 */
export async function selectWithFilter(
  opts: SelectOptions<string>,
): Promise<string | null> {
  const freshStdin = openFreshTty();
  const stdin = freshStdin ?? process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  let picker: MountedPicker | undefined;
  let resolveSelection!: (value: string | null) => void;
  let rejectSelection!: (error: unknown) => void;
  const selection = new Promise<string | null>((resolve, reject) => {
    resolveSelection = resolve;
    rejectSelection = reject;
  });
  const cancel = () => resolveSelection(null);
  process.once("SIGINT", cancel);
  // Surface terminal read failures instead of waiting forever for a key.
  stdin.once("error", rejectSelection);
  try {
    stdin.setRawMode?.(true);
    stdin.resume();
    picker = mountSelectPrompt(createSelectPrompt(opts, resolveSelection), {
      input: stdin,
      output: process.stdout,
    });
    return await selection;
  } finally {
    process.removeListener("SIGINT", cancel);
    stdin.removeListener("error", rejectSelection);
    // Each resource must be released even if an earlier cleanup step fails.
    try {
      picker?.close();
    } finally {
      try {
        stdin.setRawMode?.(wasRaw);
      } finally {
        stdin.pause();
        freshStdin?.destroy();
      }
    }
  }
}
