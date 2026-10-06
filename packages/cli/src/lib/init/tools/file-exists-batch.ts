import fs from "node:fs";
import type { FileExistsBatchPayload, ToolResult } from "../types.js";
import { safePath } from "./shared.js";
import type { InitToolDefinition } from "./types.js";

const PATH_SEGMENT_RE = /[/\\]/u;

/**
 * Check whether a batch of paths exists inside the sandbox.
 */
export async function fileExistsBatch(
  payload: FileExistsBatchPayload
): Promise<ToolResult> {
  const results = await Promise.all(
    payload.params.paths.map(async (filePath) => {
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        const absPath = safePath(payload.cwd, filePath);
        await fs.promises.access(absPath);
        return [filePath, true] as const;
      } catch {
        return [filePath, false] as const;
      }
    })
  );

  const exists: Record<string, boolean> = {};
  for (const [filePath, found] of results) {
    exists[filePath] = found;
  }

  return { ok: true, data: { exists } };
}

/**
 * Tool definition for batched existence checks.
 */
export const fileExistsBatchTool: InitToolDefinition<"file-exists-batch"> = {
  operation: "file-exists-batch",
  describe: (payload) => {
    const [first, second] = payload.params.paths;
    if (!first) {
      return "Checking files...";
    }
    if (!second && payload.params.paths.length === 1) {
      return `Checking \`${pathBase(first)}\`...`;
    }
    if (payload.params.paths.length === 2 && second) {
      return `Checking \`${pathBase(first)}\`, \`${pathBase(second)}\`...`;
    }
    return `Checking ${payload.params.paths.length} files (\`${pathBase(first)}\`${second ? `, \`${pathBase(second)}\`` : ""}, ...)...`;
  },
  execute: fileExistsBatch,
};

function pathBase(filePath: string): string {
  const parts = filePath.split(PATH_SEGMENT_RE);
  return parts.at(-1) ?? filePath;
}
