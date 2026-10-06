import fs from "node:fs";
import path from "node:path";
import type { ReadFileErrorCode } from "../types.js";
import { safePath } from "./shared.js";

const SENSITIVE_PATH_TOKEN_RE = /[\\/{},()[\]!+@?*]+/u;
const SENSITIVE_PATH_TOKENS = new Set([
  ".git",
  ".git-credentials",
  ".hg",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".svn",
  ".yarnrc",
  ".yarnrc.yml",
]);
const CONTROL_CHARACTER_RE = /\p{Cc}/u;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/u;
const WINDOWS_RESERVED_SEGMENT_RE =
  /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export type OpenedProjectFile = {
  handle: fs.promises.FileHandle;
  stat: fs.Stats;
};

/**
 * Normalize a portable filesystem-root-relative file path.
 *
 * Tool requests may use either slash style, but aliases that resolve
 * differently across operating systems are rejected before filesystem I/O.
 */
export function normalizeProjectFilePath(filePath: string): string | undefined {
  const portablePath = filePath.replaceAll("\\", "/");
  if (
    portablePath.startsWith("/") ||
    WINDOWS_DRIVE_RE.test(portablePath) ||
    CONTROL_CHARACTER_RE.test(portablePath)
  ) {
    return;
  }

  const segments = portablePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_SEGMENT_RE.test(segment)
    )
  ) {
    return;
  }
  return segments.join("/");
}

/**
 * Open a stable regular file inside a project root.
 *
 * Direct reads of sensitive metadata are allowed. An alias whose resolved
 * target is sensitive is rejected because downstream redaction selects its
 * format from the requested path.
 */
export async function openProjectFile(
  cwd: string,
  filePath: string
): Promise<OpenedProjectFile | { error: ReadFileErrorCode }> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    const absPath = safePath(cwd, filePath);
    handle = await fs.promises.open(
      absPath,
      // biome-ignore lint/suspicious/noBitwiseOperators: fs open flags are a bitmask.
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await closeProjectFile(handle);
      return { error: "not-file" };
    }
    if (!(await openedPathIsAllowed(cwd, absPath, stat))) {
      await closeProjectFile(handle);
      return { error: "unreadable" };
    }
    return { handle, stat };
  } catch (error) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    await handle?.close().catch(() => {
      // Preserve the primary open error when cleanup fails.
    });
    return { error: readErrorCode(error) };
  }
}

export async function closeProjectFile(
  handle: fs.promises.FileHandle
): Promise<void> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  await handle.close().catch(() => {
    // Descriptor cleanup must not replace the primary read classification.
  });
}

export function projectFileChanged(
  initial: fs.Stats,
  final: fs.Stats
): boolean {
  return (
    final.dev !== initial.dev ||
    final.ino !== initial.ino ||
    final.size !== initial.size ||
    final.mtimeMs !== initial.mtimeMs
  );
}

async function openedPathIsAllowed(
  cwd: string,
  absPath: string,
  openedStat: fs.Stats
): Promise<boolean> {
  const [realCwd, realPath] = await Promise.all([
    fs.promises.realpath(cwd),
    fs.promises.realpath(absPath),
  ]);
  if (realPath !== realCwd && !realPath.startsWith(`${realCwd}${path.sep}`)) {
    return false;
  }

  const requestedRelativePath = path.relative(path.resolve(cwd), absPath);
  const resolvedRelativePath = path.relative(realCwd, realPath);
  if (
    isSensitiveReadPath(resolvedRelativePath) &&
    (!sameProjectPath(requestedRelativePath, resolvedRelativePath) ||
      (await requestedPathContainsSymlink(cwd, absPath)))
  ) {
    return false;
  }

  const resolvedStat = await fs.promises.stat(realPath);
  return (
    resolvedStat.dev === openedStat.dev && resolvedStat.ino === openedStat.ino
  );
}

async function requestedPathContainsSymlink(
  cwd: string,
  absPath: string
): Promise<boolean> {
  let currentPath = path.resolve(cwd);
  const relativePath = path.relative(currentPath, absPath);
  for (const segment of relativePath.split(path.sep)) {
    if (!segment) {
      continue;
    }
    currentPath = path.join(currentPath, segment);
    if ((await fs.promises.lstat(currentPath)).isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

function sameProjectPath(first: string, second: string): boolean {
  const normalizedFirst = path.normalize(first);
  const normalizedSecond = path.normalize(second);
  if (process.platform === "win32" || process.platform === "darwin") {
    return normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase();
  }
  return normalizedFirst === normalizedSecond;
}

function isSensitiveReadPath(filePath: string): boolean {
  const tokens = filePath
    .toLowerCase()
    .split(SENSITIVE_PATH_TOKEN_RE)
    .filter(Boolean);
  return tokens.some(
    (token) =>
      SENSITIVE_PATH_TOKENS.has(token) ||
      token === ".dev.vars" ||
      token === ".env" ||
      token.startsWith(".env.")
  );
}

function readErrorCode(error: unknown): ReadFileErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "ENOENT") {
      return "not-found";
    }
    if (error.code === "EISDIR") {
      return "not-file";
    }
  }
  return "unreadable";
}
