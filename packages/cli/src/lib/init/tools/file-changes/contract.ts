/**
 * Runtime boundary for legacy file-change requests from the remote workflow.
 * Successful parses normalize wire-specific patch names into domain changes.
 */

import {
  array,
  literal,
  minLength,
  optional,
  pipe,
  safeParse,
  strictObject,
  string,
  variant,
} from "valibot";
import type { FileChange } from "./types.js";

const editSchema = strictObject({
  oldString: pipe(string(), minLength(1, "oldString must not be empty")),
  newString: string(),
});

const fileChangeSchema = variant("action", [
  strictObject({
    action: literal("create"),
    patch: string(),
    path: pipe(string(), minLength(1, "path must not be empty")),
  }),
  strictObject({
    action: literal("modify"),
    edits: pipe(array(editSchema), minLength(1, "edits must not be empty")),
    path: pipe(string(), minLength(1, "path must not be empty")),
  }),
  strictObject({
    action: literal("delete"),
    patch: optional(string()),
    path: pipe(string(), minLength(1, "path must not be empty")),
  }),
]);

const legacyApplyPatchsetPayloadSchema = strictObject({
  cwd: pipe(string(), minLength(1, "cwd must not be empty")),
  operation: literal("apply-patchset"),
  params: strictObject({
    patches: array(fileChangeSchema),
  }),
  type: literal("tool"),
});

type FileChangesContractResult =
  | { ok: true; cwd: string; changes: FileChange[] }
  | { ok: false; error: string };

/**
 * Validate the legacy wire request before it reaches the filesystem.
 *
 * The remote operation remains `apply-patchset` for compatibility, while the
 * local implementation treats its payload as a batch of file changes.
 */
export function parseFileChangesRequest(
  input: unknown
): FileChangesContractResult {
  const result = safeParse(legacyApplyPatchsetPayloadSchema, input);
  if (!result.success) {
    const details = [...new Set(result.issues.map((issue) => issue.message))];
    return {
      error: `Invalid file changes request: ${details.join("; ")}`,
      ok: false,
    };
  }
  return {
    changes: result.output.params.patches.map((change): FileChange => {
      if (change.action === "create") {
        return {
          action: change.action,
          content: change.patch,
          path: change.path,
        };
      }
      if (change.action === "modify") {
        return change;
      }
      return { action: change.action, path: change.path };
    }),
    cwd: result.output.cwd,
    ok: true,
  };
}
