/**
 * Init-wizard `glob` tool adapter. Thin wrapper over `collectGlob`:
 * sandboxes `params.path`, runs each pattern as a separate call
 * (the wire contract returns one row per pattern with its own
 * `truncated` flag), and passes `files` + `truncated` through.
 */

import { collectGlob } from "../../scan/index.js";
import type { GlobPayload, ToolResult } from "../types.js";
import { safePath } from "./shared.js";
import type { InitToolDefinition } from "./types.js";

const MAX_GLOB_RESULTS = 100;

type PatternResult = {
  pattern: string;
  files: string[];
  truncated: boolean;
};

/** Find files matching one or more glob patterns in parallel. */
export async function glob(payload: GlobPayload): Promise<ToolResult> {
  const maxResults = payload.params.maxResults ?? MAX_GLOB_RESULTS;

  // Validate once before spawning per-pattern calls — a single
  // throw aborts the whole payload, matching the registry's
  // sandbox-reject contract.
  if (payload.params.path !== undefined) {
    safePath(payload.cwd, payload.params.path);
  }

  const results: PatternResult[] = await Promise.all(
    payload.params.patterns.map(async (pattern) => {
      const { files, truncated } = await collectGlob({
        cwd: payload.cwd,
        patterns: pattern,
        path: payload.params.path,
        maxResults,
      });
      return { pattern, files, truncated };
    })
  );
  return { ok: true, data: { results } };
}

/**
 * Tool definition for glob-based file discovery.
 */
export const globTool: InitToolDefinition<"glob"> = {
  operation: "glob",
  describe: (payload) => {
    const [first] = payload.params.patterns;
    if (payload.params.patterns.length === 1 && first) {
      return `Finding files matching \`${first}\`...`;
    }
    return `Finding files (${payload.params.patterns.length} patterns)...`;
  },
  execute: glob,
};
