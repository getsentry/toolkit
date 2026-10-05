/**
 * Init-wizard `grep` tool adapter. Thin wrapper over `collectGrep`:
 * sandboxes `search.path`, forwards the wire-level constants,
 * strips `absolutePath` from each match (not part of the wire
 * contract), and catches `ValidationError` from a bad regex so the
 * agent can retry without the whole payload aborting.
 */

import { ValidationError } from "../../errors.js";
import { collectGrep } from "../../scan/index.js";
import type { GrepPayload, GrepSearch, ToolResult } from "../types.js";
import { safePath } from "./shared.js";
import type { InitToolDefinition } from "./types.js";

const MAX_GREP_RESULTS_PER_SEARCH = 100;
const MAX_GREP_LINE_LENGTH = 2000;

/** Per-match shape on the wire — no `absolutePath`, by contract. */
type WireGrepMatch = { path: string; lineNum: number; line: string };

type SearchResult = {
  pattern: string;
  matches: WireGrepMatch[];
  truncated: boolean;
};

async function runOneSearch(
  cwd: string,
  search: GrepSearch,
  maxResults: number
): Promise<SearchResult> {
  // The scan engine trusts its `path` input (see
  // `GrepOptions.path`) — sandbox enforcement lives here. We only
  // need the validation side effect; `collectGrep` takes a
  // cwd-relative subpath, so we forward `search.path` unchanged.
  if (search.path !== undefined) {
    safePath(cwd, search.path);
  }

  try {
    const { matches, stats } = await collectGrep({
      cwd,
      pattern: search.pattern,
      include: search.include,
      path: search.path,
      // Wire shape uses `caseInsensitive`; scan engine uses the
      // inverse. Leave undefined when unset so the engine's default
      // (case-sensitive, rg-like) applies.
      caseSensitive: search.caseInsensitive === true ? false : undefined,
      multiline: search.multiline,
      maxResults,
      maxLineLength: MAX_GREP_LINE_LENGTH,
    });
    return {
      pattern: search.pattern,
      matches: matches.map((m) => ({
        path: m.path,
        lineNum: m.lineNum,
        line: m.line,
      })),
      truncated: stats.truncated,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      // Malformed regex from the agent. Empty row lets the agent
      // retry with a fix instead of aborting the whole payload.
      return { pattern: search.pattern, matches: [], truncated: false };
    }
    throw error;
  }
}

/** Search project files for one or more regex patterns in parallel. */
export async function grep(payload: GrepPayload): Promise<ToolResult> {
  const maxResults =
    payload.params.maxResultsPerSearch ?? MAX_GREP_RESULTS_PER_SEARCH;
  const results = await Promise.all(
    payload.params.searches.map((search) =>
      runOneSearch(payload.cwd, search, maxResults)
    )
  );
  return { ok: true, data: { results } };
}

/**
 * Tool definition for grep-like project searches.
 */
export const grepTool: InitToolDefinition<"grep"> = {
  operation: "grep",
  describe: (payload) => {
    const [first] = payload.params.searches;
    if (payload.params.searches.length === 1 && first) {
      return `Searching for \`${first.pattern}\`...`;
    }
    return `Running ${payload.params.searches.length} searches...`;
  },
  execute: grep,
};
