/**
 * sentry games snake
 *
 * Full-screen Snake. Renders through the Ink sidecar, like the init wizard.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { detectAgent } from "../../lib/detect-agent.js";
import { ValidationError } from "../../lib/errors.js";

export const snakeCommand = buildCommand({
  docs: {
    brief: "Play Snake in your terminal",
    fullDescription:
      "Play Snake full-screen in your terminal. Steer with the arrow keys, " +
      "pause with `p`, and quit with `esc` or `q`.\n\n" +
      "Needs an interactive terminal and is not available when an AI agent " +
      "runs the CLI.",
  },
  auth: false,
  parameters: {},
  // oxlint-disable-next-line require-yield -- the game renders through Ink instead of command output
  async *func(this: SentryContext) {
    const stdout = this.stdout as { isTTY?: boolean } & typeof this.stdout;
    if (!(this.stdin.isTTY && stdout.isTTY)) {
      throw new ValidationError("Snake needs an interactive terminal.");
    }
    if (detectAgent()) {
      throw new ValidationError(
        "Snake is not available when an AI agent runs the CLI.",
      );
    }

    // A static import would load Ink and its WebAssembly layout engine
    // whenever the app starts, which breaks the library SDK build.
    const { runSnakeGame } = await import("../../lib/init/ui/ink-ui.js");
    await runSnakeGame();
  },
});
