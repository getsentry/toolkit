/**
 * sentry cli completion <shell>
 *
 * Print the shell completion script to stdout. Unlike `cli setup`, which writes
 * completion files to disk, this command lets users and package managers install
 * completions however they like.
 *
 * Usage:
 *   sentry cli completion zsh > ~/.local/share/zsh/site-functions/_sentry
 *   eval "$(sentry cli completion bash)"
 *
 * When no shell is given, the current shell is detected from $SHELL.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { getCompletionScript } from "../../lib/completions.js";
import { ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { detectShellType } from "../../lib/shell.js";

export const completionCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Print the shell completion script",
    fullDescription:
      "Print the shell completion script for the given shell to stdout.\n\n" +
      "Supported shells: bash, zsh, fish.\n" +
      "When no shell is given, it is detected from the $SHELL environment variable.\n\n" +
      "Examples:\n" +
      "  sentry cli completion zsh > ~/.local/share/zsh/site-functions/_sentry\n" +
      '  eval "$(sentry cli completion bash)"',
  },
  output: {
    human: (script: string) => script,
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "shell",
          brief: "Shell to generate completions for (bash, zsh, or fish)",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  // biome-ignore lint/suspicious/useAwait: Stricli requires AsyncGenerator but script generation is synchronous
  async *func(
    this: SentryContext,
    _flags: Record<string, never>,
    shell?: string
  ) {
    const shellType = shell
      ? detectShellType(shell)
      : detectShellType(this.env.SHELL);

    const script = getCompletionScript(shellType);
    if (script === null) {
      throw new ValidationError(
        `Unsupported shell: ${shell || shellType}. Supported shells: bash, zsh, fish`,
        "shell"
      );
    }

    yield new CommandOutput<string>(script);
  },
});
