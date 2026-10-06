/**
 * Help Command
 *
 * Provides help information for the CLI.
 * - `sentry help` or `sentry` (no args): Shows branded help with banner
 * - `sentry help <command>`: Shows detailed help for that command
 * - `sentry help --json`: Emits full command tree as structured JSON
 * - `sentry help --json <command>`: Emits specific command/group metadata as JSON
 */

import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import { OutputError } from "../lib/errors.js";
import { CommandOutput } from "../lib/formatters/output.js";
import {
  formatHelpHuman,
  introspectAllCommands,
  introspectCommand,
} from "../lib/help.js";

export const helpCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Display help for a command",
    fullDescription:
      "Display help information. Run 'sentry help' for an overview, " +
      "or 'sentry help <command>' for detailed help on a specific command. " +
      "Use --json for machine-readable output suitable for AI agents.",
  },
  output: {
    human: formatHelpHuman,
  },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Command to get help for",
        parse: String,
        placeholder: "command",
      },
    },
  },
  // biome-ignore lint/complexity/noBannedTypes: Stricli requires empty object for commands with no flags
  // biome-ignore lint/suspicious/useAwait: async generator required by Stricli buildCommand pattern
  async *func(this: SentryContext, _flags: {}, ...commandPath: string[]) {
    if (commandPath.length === 0) {
      // Yield the full command tree. The branded banner + help is rendered by
      // formatHelpHuman (human output only), so `--json` never triggers the
      // sixel probe or any terminal I/O for a banner it would discard.
      return yield new CommandOutput(introspectAllCommands());
    }

    // Resolve the command path and yield the result.
    // This ensures --json mode always gets structured output.
    const result = introspectCommand(commandPath);
    if ("error" in result) {
      // OutputError renders through the output system but exits non-zero
      throw new OutputError(result);
    }
    return yield new CommandOutput(result);
  },
});
