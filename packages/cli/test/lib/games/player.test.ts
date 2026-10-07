import { describe, expect, test } from "vitest";
import {
  getPlayerHandle,
  PLAYER_HANDLE_REGEX,
} from "../../../src/lib/games/player.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-games-player-");

describe("getPlayerHandle", () => {
  test("matches the handle format", () => {
    expect(getPlayerHandle()).toMatch(PLAYER_HANDLE_REGEX);
  });

  test("persists the same handle across calls", () => {
    expect(getPlayerHandle()).toBe(getPlayerHandle());
  });
});
