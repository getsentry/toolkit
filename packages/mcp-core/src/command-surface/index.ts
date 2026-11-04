/**
 * The command surface: one MCP tool per exposed Sentry CLI command.
 * See `tools.ts`.
 */

export { toCommandArgs } from "./args";
export { CommandFailedError } from "./errors";
export { type CommandSurfaceOptions, createCommandTools } from "./tools";
export type { ToolRegistry } from "../tools/catalog-runtime/availability";
export type { CommandCall, CommandRunner } from "./types";
