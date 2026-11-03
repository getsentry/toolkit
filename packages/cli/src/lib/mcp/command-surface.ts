/**
 * `sentry mcp --commands`: serve CLI commands through mcp-core's command
 * surface (`search_sentry`, `execute_sentry_read`, `execute_sentry_write`).
 *
 * `search_sentry` reads the generated command catalog, and each execute call
 * runs through `createSentrySDK().run()`, which loads only the top-level route
 * the call runs, never the whole command tree.
 *
 * Loaded only in commands mode. `@sentry/mcp-server` does not bundle command
 * handlers, so its bundle replaces this module with a stub.
 */

import {
  type CommandCall,
  CommandFailedError,
  createCommandTools,
  type ToolRegistry,
  toCommandArgs,
} from "@sentry/mcp-core/command-surface";
import { createSentrySDK, SentryError } from "../../index.js";
import type { McpServerConfig } from "./config.js";

export type CommandSurfaceSetup = {
  config: McpServerConfig;
  /** Where commands run, for DSN detection and project roots. */
  cwd: string;
  /** The session's current token, refreshed as needed. */
  getToken: () => Promise<string>;
};

/** Run one call through the CLI SDK, with JSON output and no telemetry of its own. */
async function runCall(
  setup: CommandSurfaceSetup,
  call: CommandCall,
): Promise<unknown> {
  const { config } = setup;
  const sdk = createSentrySDK({
    token: await setup.getToken(),
    url: `${config.sentryProtocol}://${config.sentryHost}`,
    org: call.org,
    project: call.project,
    cwd: setup.cwd,
    // The MCP server owns the process's Sentry client.
    telemetry: false,
  });
  try {
    // `run()` is typed for streaming flags too; the command surface refuses them.
    return await (sdk.run(...toCommandArgs(call)) as Promise<unknown>);
  } catch (error) {
    if (error instanceof SentryError) {
      throw new CommandFailedError(call.path.join(" "), error.message);
    }
    throw error;
  }
}

/** The command surface's tools, running calls through the CLI SDK. */
export function createCliCommandTools(
  setup: CommandSurfaceSetup,
): ToolRegistry {
  return createCommandTools({
    runtime: "stdio",
    readOnly: setup.config.readOnly,
    run: (call) => runCall(setup, call),
  });
}
