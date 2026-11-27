/**
 * Check and update a React Native project's `.gitignore`.
 */

import { promises } from "node:fs";
import { debug } from "../utils/debug.js";

const GITIGNORE_FILENAME = ".gitignore";

export async function addToGitignore(filepath: string): Promise<boolean> {
  /**
   * Don't check whether the given file is ignored because:
   * 1. It's tricky to check it without git.
   * 2. Git might not be installed or accessible.
   * 3. It's convenient to use a module to interact with git, but it would
   *    increase the size x2 approximately. Docs say to run the Wizard without
   *    installing it, and duplicating the size would slow the set-up down.
   * 4. The Wizard is meant to be run once.
   * 5. A message is logged informing users it's been added to the gitignore.
   * 6. It will be added to the gitignore as many times as it runs - not a big
   *    deal.
   * 7. It's straightforward to remove it from the gitignore.
   */
  try {
    await promises.appendFile(GITIGNORE_FILENAME, `\n${filepath}\n`);
    return true;
  } catch (error) {
    // The caller tells the user to add the path to .gitignore themselves.
    debug(error);
    return false;
  }
}

/**
 * Checks if gitignore file contains ios and android folders
 * Processes line by line, ignoring comments and checking for exact patterns
 */
export const isFolderInGitignore = async (folder: string): Promise<boolean> => {
  try {
    const content = await promises.readFile(GITIGNORE_FILENAME, {
      encoding: "utf-8",
    });

    // Split by lines and normalize line endings
    const lines = content.replace(/\r\n/g, "\n").split("\n");

    return lines.some((line) => {
      const lineWithoutComment = (line.split("#")[0] ?? "").trim();

      if (!lineWithoutComment || !lineWithoutComment.includes(folder)) {
        return false;
      }

      const patterns = [
        folder, // Exact match: ios
        `${folder}/`, // Folder with trailing slash: ios/
        `${folder}/*`, // Folder with wildcard: ios/*
        `/${folder}`, // Folder with leading slash: /ios
        `/${folder}/`, // Folder with leading and trailing slash: /ios/
      ];

      return patterns.includes(lineWithoutComment);
    });
  } catch (error) {
    // No readable .gitignore means the folder is not ignored.
    debug(error);
    return false;
  }
};
