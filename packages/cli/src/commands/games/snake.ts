/**
 * sentry games snake
 *
 * Full-screen Snake, drawn straight to the terminal.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { detectAgent } from "../../lib/detect-agent.js";
import { ValidationError } from "../../lib/errors.js";
import { isPlainOutput } from "../../lib/formatters/plain-detect.js";

export const snakeCommand = buildCommand({
  docs: {
    brief: "Play Snake in your terminal",
    fullDescription:
      "Play Snake full-screen in your terminal. Steer with the arrow keys, " +
      "pause with `p`, retry with `r`, and quit with `esc` or `q`.\n\n" +
      "Needs an interactive terminal and is not available when an AI agent " +
      "runs the CLI.",
    examples: [{ description: "Play Snake", command: "sentry games snake" }],
  },
  auth: false,
  parameters: {},
  // oxlint-disable-next-line require-yield -- the game draws to the terminal instead of yielding output
  async *func(this: SentryContext) {
    const output = this.stdout as NodeJS.WriteStream;
    if (!(this.stdin.isTTY && output.isTTY)) {
      throw new ValidationError("Snake needs an interactive terminal.");
    }
    if (detectAgent()) {
      throw new ValidationError(
        "Snake is not available when an AI agent runs the CLI.",
      );
    }

    const [{ playSnake }, { reportSnakeScore, waitForSnakeScores }] =
      await Promise.all([
        import("../../lib/games/snake-terminal.js"),
        import("../../lib/games/score.js"),
      ]);
    await playSnake(
      { input: this.stdin, output },
      { color: !isPlainOutput(), onGameOver: reportSnakeScore },
    );
    await waitForSnakeScores();
  },
});
