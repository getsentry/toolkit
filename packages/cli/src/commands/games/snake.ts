/**
 * sentry games snake
 *
 * Full-screen Snake in the alternate screen buffer. Renders through the Ink
 * sidecar, like the init wizard.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { detectAgent } from "../../lib/detect-agent.js";
import { ValidationError } from "../../lib/errors.js";
import {
  loadInkSidecar,
  openFreshTtyForInk,
} from "../../lib/init/ui/ink-ui.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

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

    const app = await loadInkSidecar();
    const freshStdin = openFreshTtyForInk();
    this.stdout.write(ENTER_ALT_SCREEN);
    let instance: ReturnType<typeof app.mountSnakeGame> | undefined;
    try {
      instance = app.mountSnakeGame({
        // Ctrl+C is routed through the game's own shortcut so it exits cleanly.
        exitOnCtrlC: false,
        patchConsole: false,
        ...(freshStdin ? { stdin: freshStdin } : {}),
      });
      await instance.waitUntilExit();
    } finally {
      instance?.unmount();
      this.stdout.write(LEAVE_ALT_SCREEN);
      if (freshStdin) {
        // oxlint-disable-next-line sentry-cli/no-silent-catch -- best-effort terminal restore
        try {
          freshStdin.setRawMode(false);
          freshStdin.pause();
          freshStdin.destroy();
        } catch {
          // stream already torn down
        }
      }
    }
  },
});
