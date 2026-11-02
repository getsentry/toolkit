/**
 * Parse `sentry mcp` arguments with the command's own Stricli parameters and
 * the runner's argument fix-ups, without starting the server.
 */

// oxlint-disable no-restricted-imports -- a bare command that only captures `mcpCommand`'s parsed flags; the CLI wrapper would run its telemetry and output pipeline.
import {
  buildApplication,
  buildCommand,
  type CommandContext,
  run,
} from "@stricli/core";
// oxlint-enable no-restricted-imports
import { mcpCommand } from "../../../src/commands/mcp.js";
import {
  type McpFlags,
  type McpScope,
  splitInlineFlagValues,
} from "../../../src/lib/mcp/args.js";

type McpPositional = [McpScope?];

type McpParameters = Parameters<
  typeof buildCommand<McpFlags, McpPositional, CommandContext>
>[0]["parameters"];

/** What `sentry mcp <args>` hands to the server. */
type McpArgs = { flags: McpFlags; scope?: McpScope };

/** The flags `sentry mcp <args>` hands to the server. Rejects what Stricli rejects. */
export async function parseMcpFlags(
  args: readonly string[],
): Promise<McpFlags> {
  return (await parseMcpArgs(args)).flags;
}

/**
 * The flags and `[<org>/[<project>]]` target `sentry mcp <args>` hands to the
 * server. Rejects what Stricli rejects, including a target the command's
 * parser refuses.
 */
export async function parseMcpArgs(args: readonly string[]): Promise<McpArgs> {
  let parsed: McpArgs | undefined;
  let stderr = "";
  const command = buildCommand<McpFlags, McpPositional, CommandContext>({
    docs: { brief: "Parse sentry mcp flags" },
    parameters: (mcpCommand as unknown as { parameters: McpParameters })
      .parameters,
    func(flags, scope) {
      parsed = { flags, scope };
    },
  });
  await run(
    buildApplication(command, { name: "sentry-mcp-test" }),
    splitInlineFlagValues(args),
    {
      process: {
        stdout: { write: () => true },
        stderr: {
          write: (text: string) => {
            stderr += text;
            return true;
          },
        },
      },
    },
  );
  if (!parsed) {
    throw new Error(`rejected ${JSON.stringify(args)}: ${stderr}`);
  }
  return parsed;
}
