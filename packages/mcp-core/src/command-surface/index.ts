/**
 * The command surface: MCP tools that find and run Sentry CLI commands.
 * See `tools.ts`.
 */

export { toCommandArgs } from "./args";
export { CommandFailedError } from "./errors";
export { type CommandSurfaceOptions, createCommandTools } from "./tools";
export type { ToolRegistry } from "../tools/catalog-runtime/availability";
export type {
  CommandCall,
  CommandCompleter,
  CommandRunner,
  CompletionCandidate,
  CompletionRequest,
} from "./types";
