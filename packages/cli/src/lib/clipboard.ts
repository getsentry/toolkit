/**
 * Clipboard utilities
 *
 * Cross-platform utilities for copying text to the system clipboard.
 * Includes both low-level copy function and interactive keyboard-triggered copy.
 */

import { spawn } from "node:child_process";
import { logger } from "./logger.js";
import { whichSync } from "./which.js";

const log = logger.withTag("clipboard");

const CTRL_C = "\x03";

/**
 * Copy text to the system clipboard.
 *
 * Uses platform-specific commands:
 * - macOS: pbcopy
 * - Linux: xclip or xsel
 * - Windows: clip
 *
 * @param text - The text to copy to clipboard
 * @returns true if copy succeeded, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const { platform } = process;

  let command: string | null = null;
  let args: string[] = [];

  if (platform === "darwin") {
    command = whichSync("pbcopy");
    args = [];
  } else if (platform === "win32") {
    command = whichSync("clip");
    args = [];
  } else {
    // Linux - try xclip first, then xsel
    command = whichSync("xclip");
    if (command) {
      args = ["-selection", "clipboard"];
    } else {
      command = whichSync("xsel");
      if (command) {
        args = ["--clipboard", "--input"];
      }
    }
  }

  if (!command) {
    return false;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const proc = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
    });

    const { stdin } = proc;
    if (stdin) {
      stdin.write(text);
      stdin.end();
    }

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => resolve(code ?? 1));
      proc.on("error", () => resolve(1));
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Sets up a keyboard listener that copies text to clipboard when 'c' is pressed.
 * Only activates in TTY environments. Returns a cleanup function to restore stdin state.
 *
 * Feedback ("Copied!") is written to stderr via the logger so stdout stays clean
 * for structured command output.
 *
 * @param stdin - The stdin stream to listen on
 * @param getText - Function that returns the text to copy
 * @returns Cleanup function to restore stdin state
 */
export function setupCopyKeyListener(
  stdin: NodeJS.ReadStream,
  getText: () => string
): () => void {
  if (!stdin.isTTY) {
    return () => {
      /* no-op for non-TTY */
    };
  }

  stdin.setRawMode(true);
  stdin.resume();

  let active = true;

  const onData = async (data: Buffer) => {
    const key = data.toString();

    if (key === "c" || key === "C") {
      const text = getText();
      const copied = await copyToClipboard(text);
      if (copied && active) {
        log.success("Copied!");
      }
    }

    if (key === CTRL_C) {
      stdin.setRawMode(false);
      stdin.pause();
      process.exit(130);
    }
  };

  stdin.on("data", onData);

  return () => {
    active = false;
    stdin.off("data", onData);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };
}
