/**
 * Tests for `sentry games snake` guard rails. The interactive game itself is
 * covered by the sidecar render tests in test/lib/init/ui.
 */

import { describe, expect, test } from "vitest";
import { snakeCommand } from "../../../src/commands/games/snake.js";
import { withEnv } from "../../../src/lib/env.js";
import { ValidationError } from "../../../src/lib/errors.js";

function createContext(isTTY: boolean) {
  return {
    stdout: { write: () => true, isTTY },
    stdin: { isTTY },
  };
}

async function run(isTTY: boolean): Promise<void> {
  const func = await snakeCommand.loader();
  await func.call(createContext(isTTY) as never, {});
}

describe("games snake", () => {
  test("rejects a non-interactive terminal", async () => {
    await expect(run(false)).rejects.toThrow(
      "Snake needs an interactive terminal.",
    );
    await expect(run(false)).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects when an AI agent runs the CLI", async () => {
    await withEnv({ ...process.env, AI_AGENT: "test-agent" }, () =>
      expect(run(true)).rejects.toThrow(
        "Snake is not available when an AI agent runs the CLI.",
      ),
    );
  });
});
