/**
 * Read-only preparation phase for file changes.
 * Every change, edit, destination identity, and conflict is validated before
 * the caller is allowed to perform the first write.
 */

import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { safeReadFile } from "../../../safe-read.js";
import { safePath } from "../shared.js";
import {
  isCanonicalChild,
  resolveCanonicalDestination,
  resolveCanonicalRoot,
  resolvePathIdentity,
} from "./paths.js";
import type { FileChangeFailure } from "./result.js";
import type { FileChange } from "./types.js";

const EMPTY_AUTH_TOKEN_RE =
  /^(SENTRY_AUTH_TOKEN[ \t]*=[ \t]*)(?:['"]?[ \t]*['"]?)?[ \t]*$/m;
const PATH_SEGMENT_RE = /[/\\]/u;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const LINE_ENDING_RE = /\r\n|\r|\n/g;

type PreparedPath = {
  absolutePath: string;
  canonicalPath: string;
  pathIdentity?: string;
  path: string;
  root: string;
  rootRealPath: string;
};

type PreparedCreate = PreparedPath & {
  action: "create";
  content: string;
};

type PreparedModify = PreparedPath & {
  action: "modify";
  content: string;
  expectedContent: string;
};

type DeleteSnapshot =
  | { kind: "missing" }
  | { content: Buffer; kind: "file" }
  | { kind: "symlink"; target: string };

type PreparedDelete = PreparedPath & {
  action: "delete";
  expected: DeleteSnapshot;
};

/** Evidence and final content carried from preparation into the apply phase. */
export type PreparedFileChange =
  | PreparedCreate
  | PreparedDelete
  | PreparedModify;

/** Complete prepared batch, or the first source-free validation failure. */
export type PrepareFileChangesResult =
  | { ok: true; changes: PreparedFileChange[] }
  | { ok: false; failure: FileChangeFailure };

type MatchResult =
  | { ok: true; content: string }
  | { ok: false; code: "edit_ambiguous" | "edit_not_found" };

type ApplyEditsResult =
  | { ok: true; content: string }
  | { ok: false; failure: FileChangeFailure };

type NormalizeFileChangesResult =
  | { ok: true; changes: FileChange[] }
  | { ok: false; failure: FileChangeFailure };

function validateFileChangePath(filePath: string): string | undefined {
  if (filePath.includes("\\")) {
    return `Invalid file change path "${filePath}": use project-relative POSIX paths`;
  }
  if (WINDOWS_DRIVE_RE.test(filePath) || path.posix.isAbsolute(filePath)) {
    return `Invalid file change path "${filePath}": absolute paths are not allowed`;
  }
  const invalidSegment = filePath
    .split("/")
    .some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    );
  return invalidSegment
    ? `Invalid file change path "${filePath}": path segments must not be empty, "." or ".."`
    : undefined;
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const firstNewline = content.indexOf("\n");
  return firstNewline > 0 && content[firstNewline - 1] === "\r" ? "\r\n" : "\n";
}

function convertLineEndings(content: string, lineEnding: "\n" | "\r\n") {
  return content.replace(LINE_ENDING_RE, lineEnding);
}

function replaceUnique(
  content: string,
  oldString: string,
  newString: string
): MatchResult {
  const first = content.indexOf(oldString);
  if (first === -1) {
    return { code: "edit_not_found", ok: false };
  }
  if (content.indexOf(oldString, first + 1) !== -1) {
    return { code: "edit_ambiguous", ok: false };
  }
  if (oldString === newString) {
    return { content, ok: true };
  }
  return {
    content: `${content.slice(0, first)}${newString}${content.slice(first + oldString.length)}`,
    ok: true,
  };
}

function applyEdits(
  initialContent: string,
  filePath: string,
  edits: Extract<FileChange, { action: "modify" }>["edits"]
): ApplyEditsResult {
  const hasBom = initialContent.startsWith("\uFEFF");
  let content = hasBom ? initialContent.slice(1) : initialContent;
  const lineEnding = detectLineEnding(content);

  for (const [index, edit] of edits.entries()) {
    const oldString = convertLineEndings(edit.oldString, lineEnding);
    const newString = convertLineEndings(edit.newString, lineEnding);
    const result = replaceUnique(content, oldString, newString);
    if (!result.ok) {
      const reason =
        result.code === "edit_ambiguous"
          ? "matched more than once; provide more surrounding context"
          : "was not found exactly in the current file";
      return {
        failure: {
          action: "modify",
          code: result.code,
          message: `Edit #${index + 1} on "${filePath}" ${reason}`,
          path: filePath,
        },
        ok: false,
      };
    }
    content = result.content;
  }

  return { content: hasBom ? `\uFEFF${content}` : content, ok: true };
}

function resolveCreateContent(
  change: Extract<FileChange, { action: "create" }>,
  authToken?: string
): string {
  let content = change.path.endsWith(".json")
    ? prettyPrintJson(change.content)
    : change.content;
  if (
    authToken &&
    isEnvFile(change.path) &&
    EMPTY_AUTH_TOKEN_RE.test(content)
  ) {
    content = content.replace(
      EMPTY_AUTH_TOKEN_RE,
      (_, prefix) => `${prefix}${authToken}`
    );
  }
  return content;
}

function prettyPrintJson(content: string): string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  } catch {
    return content;
  }
}

function isEnvFile(filePath: string): boolean {
  const name = filePath.split(PATH_SEGMENT_RE).at(-1) ?? "";
  return name === ".env" || name.startsWith(".env.");
}

async function readDeleteSnapshot(
  absolutePath: string
): Promise<DeleteSnapshot | undefined> {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return { kind: "symlink", target: await readlink(absolutePath) };
    }
    if (!stats.isFile()) {
      return;
    }
    return { content: await readFile(absolutePath), kind: "file" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
}

async function prepareFileChange(
  cwd: string,
  rootRealPath: string,
  change: FileChange,
  authToken?: string
): Promise<PrepareFileChangesResult> {
  const pathError = validateFileChangePath(change.path);
  if (pathError) {
    return {
      failure: {
        action: change.action,
        code: "invalid_path",
        message: pathError,
        path: change.path,
      },
      ok: false,
    };
  }

  let absolutePath: string;
  try {
    absolutePath = safePath(cwd, change.path);
  } catch (error) {
    return {
      failure: {
        action: change.action,
        code: "invalid_path",
        message: error instanceof Error ? error.message : String(error),
        path: change.path,
      },
      ok: false,
    };
  }

  let canonicalPath: string;
  let pathIdentity: string | undefined;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    canonicalPath = await resolveCanonicalDestination(absolutePath);
    if (!isCanonicalChild(rootRealPath, canonicalPath)) {
      throw new Error("canonical destination is outside the project root");
    }
    pathIdentity = await resolvePathIdentity(absolutePath);
  } catch {
    return {
      failure: {
        action: change.action,
        code: "invalid_path",
        message: `Cannot resolve "${change.path}" inside the project root`,
        path: change.path,
      },
      ok: false,
    };
  }

  const preparedPath: PreparedPath = {
    absolutePath,
    canonicalPath,
    pathIdentity,
    path: change.path,
    root: cwd,
    rootRealPath,
  };

  if (change.action === "create") {
    return await prepareCreate(preparedPath, change, authToken);
  }
  if (change.action === "delete") {
    return await prepareDelete(preparedPath, change);
  }
  return await prepareModify(preparedPath, change);
}

async function prepareCreate(
  preparedPath: PreparedPath,
  change: Extract<FileChange, { action: "create" }>,
  authToken?: string
): Promise<PrepareFileChangesResult> {
  try {
    await lstat(preparedPath.absolutePath);
    return {
      failure: {
        action: change.action,
        code: "already_exists",
        message: `Cannot create "${change.path}": target already exists`,
        path: change.path,
      },
      ok: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        failure: {
          action: change.action,
          code: "read_failed",
          message: `Cannot inspect "${change.path}" before creating it`,
          path: change.path,
        },
        ok: false,
      };
    }
  }
  return {
    changes: [
      {
        ...preparedPath,
        action: change.action,
        content: resolveCreateContent(change, authToken),
      },
    ],
    ok: true,
  };
}

async function prepareDelete(
  preparedPath: PreparedPath,
  change: Extract<FileChange, { action: "delete" }>
): Promise<PrepareFileChangesResult> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const expected = await readDeleteSnapshot(preparedPath.absolutePath);
    if (!expected) {
      return {
        failure: {
          action: change.action,
          code: "not_regular_file",
          message: `Cannot delete "${change.path}": target is not a regular file or symlink`,
          path: change.path,
        },
        ok: false,
      };
    }
    return {
      changes: [
        {
          ...preparedPath,
          action: change.action,
          expected,
        },
      ],
      ok: true,
    };
  } catch {
    return {
      failure: {
        action: change.action,
        code: "read_failed",
        message: `Cannot inspect "${change.path}" before deleting it`,
        path: change.path,
      },
      ok: false,
    };
  }
}

async function prepareModify(
  preparedPath: PreparedPath,
  change: Extract<FileChange, { action: "modify" }>
): Promise<PrepareFileChangesResult> {
  let initialContent: string;
  try {
    const stats = await lstat(preparedPath.absolutePath);
    if (!(stats.isFile() || stats.isSymbolicLink())) {
      return {
        failure: {
          action: change.action,
          code: "not_regular_file",
          message: `Cannot modify "${change.path}": target is not a regular file`,
          path: change.path,
        },
        ok: false,
      };
    }
    const content = await safeReadFile(
      preparedPath.absolutePath,
      "apply-file-changes.prepare"
    );
    if (content === null) {
      return {
        failure: {
          action: change.action,
          code: "not_regular_file",
          message: `Cannot modify "${change.path}": target is not a readable regular file`,
          path: change.path,
        },
        ok: false,
      };
    }
    initialContent = content;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      failure: {
        action: change.action,
        code: missing ? "missing_file" : "read_failed",
        message: missing
          ? `Cannot modify "${change.path}": file does not exist`
          : `Cannot read "${change.path}" before modifying it`,
        path: change.path,
      },
      ok: false,
    };
  }

  const edited = applyEdits(initialContent, change.path, change.edits);
  if (!edited.ok) {
    return edited;
  }
  return {
    changes: [
      {
        ...preparedPath,
        action: change.action,
        content: edited.content,
        expectedContent: initialContent,
      },
    ],
    ok: true,
  };
}

function normalizeFileChanges(
  changes: FileChange[]
): NormalizeFileChangesResult {
  const normalized: FileChange[] = [];
  const targetIndexes = new Map<string, number>();
  for (const change of changes) {
    const existingIndex = targetIndexes.get(change.path);
    if (existingIndex === undefined) {
      targetIndexes.set(change.path, normalized.length);
      normalized.push(structuredClone(change));
      continue;
    }

    const existing = normalized[existingIndex];
    if (existing?.action === "modify" && change.action === "modify") {
      existing.edits.push(...change.edits);
      continue;
    }
    return {
      failure: {
        action: change.action,
        code: "duplicate_target",
        message: `File change batch contains more than one operation for "${change.path}"`,
        path: change.path,
      },
      ok: false,
    };
  }

  for (const change of normalized) {
    const conflict = normalized.find(
      (candidate) =>
        candidate.path !== change.path &&
        (candidate.path.startsWith(`${change.path}/`) ||
          change.path.startsWith(`${candidate.path}/`))
    );
    if (conflict) {
      return {
        failure: {
          action: change.action,
          code: "path_conflict",
          message: `File change targets "${change.path}" and "${conflict.path}" overlap`,
          path: change.path,
        },
        ok: false,
      };
    }
  }
  return { changes: normalized, ok: true };
}

function comparableCanonicalPath(filePath: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? filePath.toLocaleLowerCase("en-US")
    : filePath;
}

function canonicalTargetsOverlap(
  first: PreparedFileChange,
  second: PreparedFileChange
): boolean {
  const firstPath = comparableCanonicalPath(first.canonicalPath);
  const secondPath = comparableCanonicalPath(second.canonicalPath);
  return (
    (first.pathIdentity !== undefined &&
      first.pathIdentity === second.pathIdentity) ||
    firstPath === secondPath ||
    firstPath.startsWith(`${secondPath}${path.sep}`) ||
    secondPath.startsWith(`${firstPath}${path.sep}`)
  );
}

/**
 * Validate and materialize an entire file-change batch without mutating disk.
 */
export async function prepareFileChanges(
  cwd: string,
  changes: FileChange[],
  authToken?: string
): Promise<PrepareFileChangesResult> {
  const prepared: PreparedFileChange[] = [];
  const [firstChange] = changes;
  if (!firstChange) {
    return { changes: prepared, ok: true };
  }
  let rootRealPath: string;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    rootRealPath = await resolveCanonicalRoot(cwd);
  } catch {
    return {
      failure: {
        action: firstChange.action,
        code: "invalid_path",
        message: "Cannot resolve the project root before applying file changes",
        path: firstChange.path,
      },
      ok: false,
    };
  }
  const normalized = normalizeFileChanges(changes);
  if (!normalized.ok) {
    return normalized;
  }

  for (const change of normalized.changes) {
    const result = await prepareFileChange(
      cwd,
      rootRealPath,
      change,
      authToken
    );
    if (!result.ok) {
      return result;
    }
    const [next] = result.changes;
    const conflict = next
      ? prepared.find((candidate) => canonicalTargetsOverlap(candidate, next))
      : undefined;
    if (next && conflict) {
      return {
        failure: {
          action: next.action,
          code: "path_conflict",
          message: `File change targets "${next.path}" and "${conflict.path}" resolve to overlapping filesystem paths`,
          path: next.path,
        },
        ok: false,
      };
    }
    prepared.push(...result.changes);
  }
  return { changes: prepared, ok: true };
}

/** Compare a prepared delete snapshot with the target's current state. */
export async function deleteSnapshotMatches(
  absolutePath: string,
  expected: DeleteSnapshot
): Promise<boolean> {
  const current = await readDeleteSnapshot(absolutePath);
  if (!current || current.kind !== expected.kind) {
    return false;
  }
  if (current.kind === "missing" && expected.kind === "missing") {
    return true;
  }
  if (current.kind === "symlink" && expected.kind === "symlink") {
    return current.target === expected.target;
  }
  return (
    current.kind === "file" &&
    expected.kind === "file" &&
    current.content.equals(expected.content)
  );
}
