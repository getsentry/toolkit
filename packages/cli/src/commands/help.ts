/**
 * Help Command
 *
 * Provides help information for the CLI.
 * - `sentry` (no args): Shows branded help with a compact command overview
 *   (the full list when an AI agent is detected)
 * - `sentry help`: Shows branded help with every command
 * - `sentry help <command>`: Shows detailed help for that command
 * - `sentry help --json`: Emits full command tree as structured JSON
 * - `sentry help --json <command>`: Emits specific command/group metadata as JSON
 */

import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import { parseCommandPath } from "../lib/completion-target.js";
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
      "Display help information. Run 'sentry' for an overview, 'sentry help' " +
      "to list every command, " +
      "or 'sentry help <command>' for detailed help on a specific command. " +
      "Use --json for machine-readable output suitable for AI agents.",
  },
  output: {
    human: formatHelpHuman,
    jsonExclude: ["overview"],
  },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Command to get help for",
        parse: parseCommandPath,
        placeholder: "command",
      },
    },
  },
  // Stricli requires empty object for commands with no flags
  // async generator required by Stricli buildCommand pattern
  async *func(this: SentryContext, _flags: {}, ...commandPath: string[]) {
    if (commandPath.length === 0) {
      // Yield the full command tree. The branded banner + help is rendered by
      // formatHelpHuman (human output only), so `--json` never triggers the
      // sixel probe or any terminal I/O for a banner it would discard.
      // Bare `sentry` (prefix without `help`) gets the compact overview;
      // explicit `sentry help` lists every command.
      const overview = this.commandPrefix?.length === 1;
      return yield new CommandOutput({ ...introspectAllCommands(), overview });
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
