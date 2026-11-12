/**
 * sentry init
 *
 * Print the agent setup guide (`init.md`): the steps a coding agent follows
 * to add Sentry to a project — install the CLI, log in, pick a Sentry
 * project, choose features, install the SDKs with help from `sentry docs`,
 * and check that a test error reaches Sentry. The same guide is published at
 * https://cli.sentry.dev/get-started-with-sentry.md.
 *
 * The command makes no requests, so it runs without a login and ignores a
 * `.sentryclirc` URL.
 */

import type { SentryContext } from "../context.js";
import { INIT_GUIDE } from "../generated/init-guide.js";
import { InitOutputSchema } from "../generated/output-schemas/init.js";
import { buildCommand } from "../lib/command.js";
import { detectAgent } from "../lib/detect-agent.js";
import { isPlainOutput, renderMarkdown } from "../lib/formatters/markdown.js";
import { CommandOutput } from "../lib/formatters/output.js";
import type { InitOutput } from "../output-schemas/init.js";
import { topLevelBrief } from "../top-level-briefs.js";

type InitFlags = {
  readonly json: boolean;
  readonly fields?: string[];
};

/**
 * Agents get the Markdown source as written: they read it through a pipe,
 * or through a pseudo-terminal that `detectAgent` recognizes. A person in a
 * terminal gets it rendered.
 */
function formatGuide(data: InitOutput): string {
  return isPlainOutput() || detectAgent()
    ? data.guide.trimEnd()
    : renderMarkdown(data.guide);
}

export const initCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: topLevelBrief("init"),
    fullDescription:
      "Print a Markdown guide that a coding agent follows to add Sentry to " +
      "your project: install the CLI, log in, pick or create a Sentry " +
      "project, choose features, install and configure the SDKs using " +
      "`sentry docs`, and verify that a test error reaches Sentry. If the " +
      "project already uses Sentry, the guide covers upgrading the SDKs and " +
      "turning on more features instead.\n\n" +
      "The command changes nothing and needs no login. The same guide is " +
      "published at https://cli.sentry.dev/get-started-with-sentry.md.",
    examples: [
      {
        description: "Print the setup guide",
        run: "init",
      },
      {
        description: "Print the guide as JSON",
        run: "init --json",
      },
    ],
  },
  output: { human: formatGuide, schema: InitOutputSchema },
  parameters: {
    flags: {},
  },
  // Stricli requires an AsyncGenerator; the guide is static
  async *func(this: SentryContext, _flags: InitFlags) {
    yield new CommandOutput<InitOutput>({ guide: INIT_GUIDE });
  },
});
