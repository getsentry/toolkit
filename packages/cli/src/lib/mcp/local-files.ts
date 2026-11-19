/**
 * Local file access for MCP tools that upload files, such as videos attached
 * to issue comments. Only the stdio server runs on the user's machine, so only
 * it hands this reader to mcp-core.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { LocalFile } from "@sentry/mcp-core/types";

/** Expand a leading `~` the way a shell would, then make the path absolute. */
function resolveLocalPath(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(cwd, path);
}

/** Read one regular file named in a tool call. */
export async function readLocalFile(
  path: string,
  cwd: string = process.cwd(),
): Promise<LocalFile> {
  const absolutePath = resolveLocalPath(path, cwd);
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new Error("not a regular file");
  }
  return {
    name: basename(absolutePath),
    data: new Uint8Array(await readFile(absolutePath)),
  };
}
