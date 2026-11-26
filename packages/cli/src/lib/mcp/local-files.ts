/**
 * Local file access for MCP tools that upload files, such as videos attached
 * to issue comments. Only the stdio server runs on the user's machine, so only
 * it hands this reader to mcp-core.
 *
 * The paths come from the model, which may be following injected
 * instructions, so reads are confined to the directory the server was started
 * in. Symlinks are resolved before that check, so a link inside the directory
 * cannot reach a file outside it.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { LocalFile } from "@sentry/mcp-core/types";

/** True when `path` is `root` or inside it. */
function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" || !(fromRoot.startsWith("..") || isAbsolute(fromRoot))
  );
}

/**
 * Read one regular file named in a tool call, from `root` or below it.
 *
 * @param root Directory files may be read from (the server's working directory)
 */
export async function readLocalFile(
  path: string,
  root: string = process.cwd(),
): Promise<LocalFile> {
  const realRoot = await realpath(root);
  const realPath = await realpath(resolve(realRoot, path));
  if (!isWithin(realRoot, realPath)) {
    throw new Error(
      `only files in ${realRoot} can be attached; move the file there or start the MCP server from its directory`,
    );
  }
  const info = await stat(realPath);
  if (!info.isFile()) {
    throw new Error("not a regular file");
  }
  return {
    name: basename(realPath),
    data: new Uint8Array(await readFile(realPath)),
  };
}
