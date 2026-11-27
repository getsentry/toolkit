/**
 * Recursive file search by extension or exact name, used by the Apple
 * wizards to find Xcode schemes and scheme-management plists.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { debug } from "./debug.js";

export function findFilesWithExtension(
  directory: string,
  extension: string,
): string[] {
  return findFiles(directory, (filePath) => filePath.endsWith(extension));
}

export function findFilesWithName(
  directory: string,
  fileName: string,
): string[] {
  return findFiles(
    directory,
    (filePath) => path.basename(filePath) === fileName,
  );
}

function findFiles(
  directory: string,
  predicate: (filePath: string) => boolean,
): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    debug("Could not read directory while finding files:", directory, error);
    return [];
  }

  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findFiles(entryPath, predicate);
    }

    return predicate(entryPath) ? [entryPath] : [];
  });
}
