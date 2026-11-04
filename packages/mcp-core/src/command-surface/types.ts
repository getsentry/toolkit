import type { ServerContext } from "../types";

/** A validated command call, ready for the CLI SDK. */
export type CommandCall = {
  /** Command path without `sentry`, such as `["issue", "list"]`. */
  path: string[];
  positional: string[];
  /** By CLI flag name (`dry-run`), without the injected `json`. */
  flags: Record<string, string | number | boolean | (string | number)[]>;
  /**
   * The session's organization and project, for the SDK to use when the call
   * names no target.
   */
  org?: string;
  project?: string;
};

/**
 * Runs a call and returns the command's JSON output: one value, or an array
 * when the command yielded more than once. Throws `CommandFailedError` when
 * the command fails.
 */
export type CommandRunner = (
  call: CommandCall,
  context: ServerContext,
) => Promise<unknown>;
