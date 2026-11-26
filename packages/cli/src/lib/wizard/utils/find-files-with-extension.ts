/**
 * List the entries of one directory (not recursive) that end in an
 * extension, such as the `.xcodeproj` bundles next to an iOS app.
 */

import { readdirSync } from "node:fs";

import { debug } from "./debug.js";

export function findFilesWithExtension(
  dir: string,
  extension: string,
): string[] {
  debug(`Searching for files with extension: ${extension} at path: ${dir}`);
  const files = readdirSync(dir);
  debug(`Found ${files.length} files in ${dir}`);
  const found = files.filter((file) => file.endsWith(extension));
  debug(`Found ${found.length} files with extension ${extension}`);
  for (const file of found) {
    debug(`  ${file}`);
  }
  return found;
}
