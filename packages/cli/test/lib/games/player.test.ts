import { describe, expect, test } from "vitest";
import {
  getPlayerHandle,
  PLAYER_HANDLE_REGEX,
} from "../../../src/lib/games/player.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { setMetadata } from "../../../src/lib/db/utils.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-games-player-");

describe("getPlayerHandle", () => {
  test("matches the handle format", () => {
    expect(getPlayerHandle()).toMatch(PLAYER_HANDLE_REGEX);
  });

  test("persists the same handle across calls", () => {
    expect(getPlayerHandle()).toBe(getPlayerHandle());
  });

  test("replaces a stored handle in the old two-digit format", () => {
    setMetadata(getDatabase(), { "games.handle": "brave-otter-42" });
    const handle = getPlayerHandle();
    expect(handle).not.toBe("brave-otter-42");
    expect(handle).toMatch(PLAYER_HANDLE_REGEX);
  });
});
