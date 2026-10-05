/**
 * Browser utilities
 *
 * Cross-platform utilities for interacting with the user's browser.
 * Uses child_process.spawn and whichSync for process management.
 */

import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { generateQRCode } from "./qrcode.js";
import { whichSync } from "./which.js";

/** No-op error handler to prevent unhandled error crashes from spawn. */
function noop(): void {
  // Intentionally empty — absorbs async spawn errors (e.g., ENOENT)
}

/**
 * Open a URL in the user's default browser.
 *
 * This is a "best effort" operation - returns true if successful, false otherwise.
 * Never throws, so callers can safely attempt to open a browser without breaking flows.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const { platform } = process;

  let command: string | null = null;
  let args: string[];

  if (platform === "darwin") {
    command = whichSync("open");
    args = [url];
  } else if (platform === "win32") {
    command = whichSync("cmd");
    args = ["/c", "start", "", url];
  } else {
    // Linux and other Unix-like systems - try multiple openers
    const linuxOpeners = [
      "xdg-open",
      "sensible-browser",
      "x-www-browser",
      "gnome-open",
      "kde-open",
    ];
    for (const opener of linuxOpeners) {
      command = whichSync(opener);
      if (command) {
        break;
      }
    }
    args = [url];
  }

  if (!command) {
    return false;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const proc = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Prevent unhandled error crash if the binary disappears between
    // whichSync() and spawn() (TOCTOU window).
    proc.on("error", noop);

    // Give browser time to open, then detach
    await setTimeout(500);
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open URL in browser, or show URL + QR code as fallback.
 *
 * Attempts to open the browser first. If that fails (no browser available,
 * headless environment, etc.), displays the URL and a QR code for mobile scanning.
 *
 * Writes directly to `process.stdout` — callers don't need to pass a writer.
 *
 * @param url - The URL to open or display
 * @returns true if browser opened, false if showing fallback
 */
export async function openOrShowUrl(url: string): Promise<boolean> {
  const opened = await openBrowser(url);
  if (opened) {
    process.stdout.write("Opening in browser...\n");
    return true;
  }

  // Fallback: show URL and QR code
  process.stdout.write("Could not open browser. Visit this URL:\n\n");
  process.stdout.write(`${url}\n\n`);
  const qr = await generateQRCode(url);
  process.stdout.write(qr);
  process.stdout.write("\n");
  return false;
}

/**
 * Handle the --web flag for view commands.
 *
 * Opens the URL in a browser if available, otherwise shows URL + QR code.
 * If URL is undefined/null, prints an error message.
 *
 * Writes directly to `process.stdout` — callers don't need to pass a writer.
 *
 * @param url - The URL to open (or undefined if not available)
 * @param entityName - Name of the entity for error message (e.g., "issue", "project")
 */
export async function openInBrowser(
  url: string | undefined,
  entityName = "resource"
): Promise<void> {
  if (!url) {
    process.stdout.write(`No URL available for this ${entityName}.\n`);
    return;
  }
  await openOrShowUrl(url);
}
