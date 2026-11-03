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

/** One completion candidate for a parameter. */
export type CompletionCandidate = { value: string; description?: string };

/** What `search_sentry`'s `complete` mode asks for. */
export type CompletionRequest = {
  /** Command name, such as `issue list`. */
  command: string;
  /** `positional[0]` or a flag name such as `query`. */
  parameter: string;
  /** The value typed so far. */
  value: string;
};

/** Completes parameter values; wired up by the completion work (#1895). */
export type CommandCompleter = (
  request: CompletionRequest,
  context: ServerContext,
) => Promise<CompletionCandidate[]>;
