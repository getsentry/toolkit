import { describe, expect, test } from "vitest";
import { withEnv } from "../../../../src/lib/env.js";
import { isSnakeEnabled } from "../../../../src/lib/init/ui/ink-ui.js";

describe("isSnakeEnabled", () => {
  test("offers the game to a person at a terminal", () => {
    expect(withEnv({}, isSnakeEnabled)).toBe(true);
  });

  test("SENTRY_INIT_GAME=0 turns the game off", () => {
    expect(withEnv({ SENTRY_INIT_GAME: "0" }, isSnakeEnabled)).toBe(false);
  });

  test("hides the game when an AI agent runs the CLI", () => {
    expect(withEnv({ AI_AGENT: "claude-code" }, isSnakeEnabled)).toBe(false);
  });
});
