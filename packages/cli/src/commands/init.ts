/**
 * sentry init
 *
 * Print the agent setup guide (`init.md`): the steps a coding agent follows
 * to add Sentry to a project — install the CLI, log in, pick a Sentry
 * project, choose features, install the SDK with help from `sentry docs`,
 * and check that a test error reaches Sentry. The same guide is published at
 * https://cli.sentry.dev/init.md.
 */

import type { SentryContext } from "../context.js";
import { INIT_GUIDE } from "../generated/init-guide.js";
import { buildCommand } from "../lib/command.js";
import { isPlainOutput, renderMarkdown } from "../lib/formatters/markdown.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { topLevelBrief } from "../top-level-briefs.js";

type InitOutput = {
  /** The guide's Markdown source. */
  guide: string;
};

/**
 * Agents read the command through a pipe, so plain output is the Markdown
 * source as written. A terminal gets it rendered.
 */
function formatGuide(data: InitOutput): string {
  return isPlainOutput() ? data.guide.trimEnd() : renderMarkdown(data.guide);
}

export const initCommand = buildCommand({
  auth: false,
  docs: {
    brief: topLevelBrief("init"),
    fullDescription:
      "Print a Markdown guide that a coding agent follows to add Sentry to " +
      "your project: install the CLI, log in, pick or create a Sentry " +
      "project, choose features, install and configure the SDK using " +
      "`sentry docs`, and verify that a test error reaches Sentry. If the " +
      "project already uses Sentry, the guide covers upgrading the SDK and " +
      "turning on more features instead.\n\n" +
      "The command changes nothing itself. The same guide is published at " +
      "https://cli.sentry.dev/init.md.",
    examples: [
      {
        description: "Print the setup guide",
        command: "sentry init",
      },
      {
        description: "Print the guide as JSON",
        command: "sentry init --json",
      },
    ],
  },
  output: { human: formatGuide },
  parameters: { flags: {} },
  // Stricli requires an AsyncGenerator; the guide is static
  async *func(this: SentryContext) {
    yield new CommandOutput<InitOutput>({ guide: INIT_GUIDE });
  },
});
