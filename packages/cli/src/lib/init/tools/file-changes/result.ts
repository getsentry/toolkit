/** Structured, source-free failure results returned by file changes. */

import type { FileChange } from "./types.js";

/** Stable failure categories returned to the remote workflow. */
export type FileChangeFailureCode =
  | "already_exists"
  | "duplicate_target"
  | "edit_ambiguous"
  | "edit_not_found"
  | "invalid_path"
  | "missing_file"
  | "not_regular_file"
  | "path_conflict"
  | "read_failed"
  | "stale_content"
  | "write_failed";

/** A failed file operation with enough context for agent recovery. */
export type FileChangeFailure = {
  /** File operation that failed. */
  action: FileChange["action"];
  /** Stable category suitable for recovery logic. */
  code: FileChangeFailureCode;
  /** Human-readable explanation without file contents or credentials. */
  message: string;
  /** Project-relative target path. */
  path: string;
};
