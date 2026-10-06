/**
 * Apply phase for fully prepared file changes.
 * It revalidates captured path/content evidence and reports partial writes;
 * it intentionally does not attempt rollback.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeReadFile } from "../../../safe-read.js";
import type { ToolResult } from "../../types.js";
import { safePath } from "../shared.js";
import {
  resolveCanonicalDestination,
  resolveCanonicalRoot,
  resolvePathIdentity,
} from "./paths.js";
import { deleteSnapshotMatches, type PreparedFileChange } from "./prepare.js";
import type { FileChangeFailure, FileChangeFailureCode } from "./result.js";

type AppliedFileChange = {
  action: PreparedFileChange["action"];
  path: string;
};

class FileChangeApplyError extends Error {
  readonly code: FileChangeFailureCode;

  constructor(code: FileChangeFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

async function assertApplyPath(change: PreparedFileChange): Promise<void> {
  try {
    const currentRoot = await resolveCanonicalRoot(change.root);
    const currentDestination = await resolveCanonicalDestination(
      change.absolutePath
    );
    const currentIdentity = await resolvePathIdentity(change.absolutePath);
    if (
      currentRoot !== change.rootRealPath ||
      currentDestination !== change.canonicalPath ||
      currentIdentity !== change.pathIdentity ||
      safePath(change.root, change.path) !== change.absolutePath
    ) {
      throw new Error("resolved path changed");
    }
  } catch {
    throw new FileChangeApplyError(
      "stale_content",
      `Cannot ${change.action} "${change.path}": path changed after validation`
    );
  }
}

async function applyPreparedFileChange(
  change: PreparedFileChange
): Promise<void> {
  await assertApplyPath(change);
  if (change.action === "create") {
    await mkdir(path.dirname(change.absolutePath), { recursive: true });
    await assertApplyPath(change);
    try {
      await writeFile(change.absolutePath, change.content, {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FileChangeApplyError(
          "stale_content",
          `Cannot create "${change.path}": target appeared after validation`
        );
      }
      throw error;
    }
    return;
  }

  if (change.action === "modify") {
    const current = await safeReadFile(
      change.absolutePath,
      "apply-file-changes.apply"
    );
    if (current === null) {
      throw new FileChangeApplyError(
        "stale_content",
        `Cannot modify "${change.path}": target changed after validation`
      );
    }
    if (current !== change.expectedContent) {
      throw new FileChangeApplyError(
        "stale_content",
        `Cannot modify "${change.path}": file changed after validation`
      );
    }
    await assertApplyPath(change);
    await writeFile(change.absolutePath, change.content, "utf-8");
    return;
  }

  if (!(await deleteSnapshotMatches(change.absolutePath, change.expected))) {
    throw new FileChangeApplyError(
      "stale_content",
      `Cannot delete "${change.path}": target changed after validation`
    );
  }
  await assertApplyPath(change);
  if (change.expected.kind !== "missing") {
    await unlink(change.absolutePath);
  }
}

function failureFromError(
  change: PreparedFileChange,
  error: unknown
): FileChangeFailure {
  return {
    action: change.action,
    code: error instanceof FileChangeApplyError ? error.code : "write_failed",
    message:
      error instanceof Error
        ? error.message
        : `Could not ${change.action} "${change.path}"`,
    path: change.path,
  };
}

function failedResult(
  failure: FileChangeFailure,
  applied: AppliedFileChange[]
): ToolResult {
  return {
    data: { applied, failed: failure },
    error: failure.message,
    ok: false,
  };
}

/**
 * Apply a fully prepared batch, reporting any unavoidable write-time partial
 * result without attempting filesystem rollback.
 */
export async function applyPreparedFileChanges(
  changes: PreparedFileChange[],
  dryRun: boolean
): Promise<ToolResult> {
  const applied = changes.map(({ action, path: filePath }) => ({
    action,
    path: filePath,
  }));
  if (dryRun) {
    return { data: { applied, dryRun: true }, ok: true };
  }

  const completed: AppliedFileChange[] = [];
  for (const change of changes) {
    try {
      await applyPreparedFileChange(change);
      completed.push({ action: change.action, path: change.path });
    } catch (error) {
      return failedResult(failureFromError(change, error), completed);
    }
  }
  return { data: { applied: completed }, ok: true };
}
