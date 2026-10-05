import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SKIP_DIRS, normalizePath } from "../../scan/index.js";
import type { DirEntry, ListDirPayload, ToolResult } from "../types.js";
import { safePath } from "./shared.js";
import type { InitToolDefinition } from "./types.js";

const NATIVE_SEP = path.sep;
const INIT_SKIP_DIRS = new Set([
  ...DEFAULT_SKIP_DIRS,
  "tmp",
  "temp",
  "bin",
  "Pods",
]);

/**
 * List files and directories within the workflow sandbox.
 *
 * Paths in the result are POSIX-normalized (`/`-separated) regardless
 * of host OS, so the Mastra agent sees a consistent wire shape.
 */
export async function listDir(payload: ListDirPayload): Promise<ToolResult> {
  const { cwd, params } = payload;
  const targetPath = safePath(cwd, params.path);
  const maxDepth = params.maxDepth ?? 3;
  const maxEntries = params.maxEntries ?? 500;
  const recursive = params.recursive ?? false;
  const state: WalkState = {
    cwd,
    // Cached prefix length used to turn an absolute native path into a
    // cwd-relative POSIX path via `abs.slice(cwdPrefixLen)` — O(1) and
    // avoids the per-entry `path.relative` allocation.
    cwdPrefixLen: cwd.length + 1,
    entries: [],
    maxDepth,
    maxEntries,
    recursive,
    truncated: false,
  };

  await walkDirectory(targetPath, 0, state);
  return {
    ok: true,
    data: {
      entries: state.entries,
      ...(state.truncated ? { truncated: true } : {}),
    },
  };
}

type WalkState = {
  cwd: string;
  cwdPrefixLen: number;
  entries: DirEntry[];
  maxDepth: number;
  maxEntries: number;
  recursive: boolean;
  truncated: boolean;
};

async function readDirEntries(dir: string): Promise<fs.Dirent[] | undefined> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
}

function shouldRecurseInto(entry: fs.Dirent, state: WalkState): boolean {
  return (
    state.recursive &&
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    !entry.name.startsWith(".") &&
    !INIT_SKIP_DIRS.has(entry.name)
  );
}

/**
 * Build a `DirEntry` for `entry` sitting inside `dir`. Returns
 * `undefined` for symlinks that escape the sandbox.
 *
 * `dir` is absolute native-separator, guaranteed to start with
 * `state.cwd + sep`, so `abs.slice(state.cwdPrefixLen)` yields the
 * cwd-relative path without a `path.relative` allocation.
 */
function toDirEntry(
  state: WalkState,
  dir: string,
  entry: fs.Dirent
): DirEntry | undefined {
  const abs = dir + NATIVE_SEP + entry.name;
  const relNative = abs.slice(state.cwdPrefixLen);

  if (entry.isSymbolicLink()) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      safePath(state.cwd, relNative);
    } catch {
      return;
    }
  }

  if (entry.isDirectory()) {
    return {
      name: entry.name,
      path: normalizePath(relNative),
      type: "directory",
    };
  }

  // Only regular files carry size. lstat avoids following a path that changed
  // into a symlink after readdir; special files are never opened.
  return {
    name: entry.name,
    path: normalizePath(relNative),
    type: "file",
    ...(entry.isFile() ? fileSize(abs) : {}),
  };
}

/** Return a regular file's byte size without opening or reading its contents. */
function fileSize(abs: string): { size?: number } {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const stat = fs.lstatSync(abs);
    return stat.isFile() ? { size: stat.size } : {};
  } catch {
    return {};
  }
}

async function walkDirectory(
  dir: string,
  depth: number,
  state: WalkState
): Promise<void> {
  if (depth > state.maxDepth || state.entries.length >= state.maxEntries) {
    state.truncated = true;
    return;
  }

  const entries = await readDirEntries(dir);
  if (!entries) {
    state.truncated = true;
    return;
  }

  for (const entry of entries) {
    if (state.entries.length >= state.maxEntries) {
      state.truncated = true;
      return;
    }
    const nextEntry = toDirEntry(state, dir, entry);
    if (!nextEntry) {
      continue;
    }
    state.entries.push(nextEntry);
    if (shouldRecurseInto(entry, state)) {
      if (depth >= state.maxDepth) {
        state.truncated = true;
      } else {
        await walkDirectory(dir + NATIVE_SEP + entry.name, depth + 1, state);
      }
    }
  }
}

/**
 * Tool definition for directory listing requests.
 */
export const listDirTool: InitToolDefinition<"list-dir"> = {
  operation: "list-dir",
  describe: () => "Listing directory...",
  execute: listDir,
};
