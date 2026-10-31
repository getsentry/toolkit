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
  splitInlineFlagValues,
} from "../../../src/lib/mcp/args.js";

type McpParameters = Parameters<
  typeof buildCommand<McpFlags, [], CommandContext>
>[0]["parameters"];

/** The flags `sentry mcp <args>` hands to the server. Rejects what Stricli rejects. */
export async function parseMcpFlags(
  args: readonly string[],
): Promise<McpFlags> {
  let parsed: McpFlags | undefined;
  let stderr = "";
  const command = buildCommand<McpFlags, [], CommandContext>({
    docs: { brief: "Parse sentry mcp flags" },
    parameters: (mcpCommand as unknown as { parameters: McpParameters })
      .parameters,
    func(flags) {
      parsed = flags;
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
