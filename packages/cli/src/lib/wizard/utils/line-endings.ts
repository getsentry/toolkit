/**
 * Fixes mixed line endings in files modified by the wizard.
 *
 * When the wizard reads a CRLF file and inserts content with hardcoded \n,
 * the result is mixed line endings. {@link fixLineEndings} detects files with
 * CRLF and normalizes all line endings to CRLF.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getUncommittedOrUntrackedFilePaths } from "./git.js";

const TEXT_EXTENSIONS = new Set([
  ".dart",
  ".yaml",
  ".yml",
  ".properties",
  ".java",
  ".kt",
  ".xml",
  ".gradle",
  ".kts",
  ".gitignore",
  ".json",
]);

/**
 * Normalize every changed text file that has a CRLF to CRLF only. Call it at
 * the end of a wizard run, like `runPrettierIfInstalled()`.
 */
export function fixLineEndings(): void {
  const files = getUncommittedOrUntrackedFilePaths().filter(Boolean);

  for (const file of files) {
    const filePath = path.resolve(file);

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);
    if (!TEXT_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(basename)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");

    if (!content.includes("\r\n")) {
      continue;
    }

    // File has CRLF — normalize all line endings to CRLF
    const normalized = content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    writeFileSync(filePath, normalized, "utf8");
  }
}
