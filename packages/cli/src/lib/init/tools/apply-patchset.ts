/**
 * Compatibility adapter for the deployed `apply-patchset` wire operation.
 * All validation and filesystem policy belong to the file-change engine.
 */

import type { ToolResult } from "../types.js";
import { applyPreparedFileChanges } from "./file-changes/apply.js";
import { parseFileChangesRequest } from "./file-changes/contract.js";
import { prepareFileChanges } from "./file-changes/prepare.js";
import type { FileChangeFailure } from "./file-changes/result.js";
import type { FileChange } from "./file-changes/types.js";
import type { InitToolDefinition, ToolContext } from "./types.js";

const PATH_SEGMENT_RE = /[/\\]/u;

function failedPreparation(failure: FileChangeFailure): ToolResult {
  return {
    data: { applied: [], failed: failure },
    error: failure.message,
    ok: false,
  };
}

/**
 * Adapt the legacy `apply-patchset` wire request to the local file-change
 * engine. The engine always validates and prepares the entire batch before it
 * performs the first write.
 */
export async function applyPatchset(
  input: unknown,
  context: Pick<ToolContext, "dryRun" | "authToken">
): Promise<ToolResult> {
  const parsed = parseFileChangesRequest(input);
  if (!parsed.ok) {
    return { error: parsed.error, ok: false };
  }
  const prepared = await prepareFileChanges(
    parsed.cwd,
    parsed.changes,
    context.authToken
  );
  if (!prepared.ok) {
    return failedPreparation(prepared.failure);
  }
  return applyPreparedFileChanges(prepared.changes, context.dryRun);
}

/**
 * Tool definition for file patch application.
 */
export const applyPatchsetTool: InitToolDefinition<"apply-patchset"> = {
  operation: "apply-patchset",
  describe: (payload) => {
    const parsed = parseFileChangesRequest(payload);
    if (!parsed.ok) {
      return "Applying file changes...";
    }
    const [first] = parsed.changes;
    if (parsed.changes.length === 1 && first) {
      const verb = patchActionVerb(first.action);
      const fileName = first.path.split(PATH_SEGMENT_RE).at(-1) ?? first.path;
      return `${verb} \`${fileName}\`...`;
    }
    return `Applying ${parsed.changes.length} file changes...`;
  },
  execute: applyPatchset,
};

function patchActionVerb(action: FileChange["action"]): string {
  switch (action) {
    case "create":
      return "Creating";
    case "modify":
      return "Modifying";
    case "delete":
      return "Deleting";
    default:
      return "Updating";
  }
}
