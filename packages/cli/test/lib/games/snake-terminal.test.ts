import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSnake } from "../../../src/lib/games/snake-game.js";
import {
  parseKeys,
  playSnake,
  renderSnakeFrame,
  type SnakeTerminal,
} from "../../../src/lib/games/snake-terminal.js";

const UP = "\x1b[A";
const RIGHT = "\x1b[C";

function fakeTerminal() {
  const input = Object.assign(new EventEmitter(), {
    rawMode: false,
    setEncoding: vi.fn(),
    setRawMode(mode: boolean) {
      input.rawMode = mode;
      return input;
    },
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    columns: 40,
    rows: 20,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  });
  const terminal = { input, output } as unknown as SnakeTerminal;
  const press = (keys: string) => input.emit("data", keys);
  /** Index of the frame line that holds the snake's head. */
  const headLine = () =>
    (writes.findLast((w) => w.startsWith("\x1b[H")) ?? "")
      .split("\r\n")
      .findIndex((line) => line.includes("@"));
  return { input, output, writes, terminal, press, headLine };
}

describe("parseKeys", () => {
  test("reads arrow keys in both cursor modes and letter keys", () => {
    expect(parseKeys("\x1b[A\x1bOB\x1b[C\x1b[D")).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
    expect(parseKeys("wasdKJHL")).toEqual([
      "up",
      "left",
      "down",
      "right",
      "up",
      "down",
      "left",
      "right",
    ]);
    expect(parseKeys("p rq")).toEqual(["pause", "pause", "restart", "quit"]);
  });

  test("reads a lone escape and ctrl+c as quit", () => {
    expect(parseKeys("\x1b")).toEqual(["quit"]);
    expect(parseKeys("\x03")).toEqual(["quit"]);
  });

  test("drops unknown keys and escape sequences", () => {
    expect(parseKeys("x\x1b[1;5A\x1b[200~z")).toEqual([]);
  });
});

describe("renderSnakeFrame", () => {
  test("draws without color codes when color is off", () => {
    const frame = renderSnakeFrame(
      createSnake(30, 6, () => 0),
      3,
      false,
    );
    // oxlint-disable-next-line no-control-regex -- SGR codes start with \x1b
    expect(frame).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(frame).toContain(`╭${"─".repeat(30)}╮`);
    expect(frame).toContain("Bugs squashed 0  Best 3");
    expect(frame).toContain("Press an arrow key");
  });
});

describe("playSnake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Food goes to the first free cell, out of the snake's path.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("restores the terminal when the player quits", async () => {
    const { input, output, writes, terminal, press } = fakeTerminal();
    const game = playSnake(terminal, { color: false });
    expect(input.rawMode).toBe(true);
    expect(writes[0]).toContain("\x1b[?1049h");

    press("q");
    await game;

    expect(input.rawMode).toBe(false);
    expect(input.pause).toHaveBeenCalled();
    expect(writes.at(-1)).toBe("\x1b[?25h\x1b[?1049l");
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("resize")).toBe(0);
  });

  test("keeps the pending step when the player steers", async () => {
    const { terminal, press, headLine } = fakeTerminal();
    const game = playSnake(terminal, { color: false });
    press(RIGHT);
    const start = headLine();

    await vi.advanceTimersByTimeAsync(100);
    press(UP);
    await vi.advanceTimersByTimeAsync(10);

    expect(headLine()).toBe(start - 1);
    press("q");
    await game;
  });

  test("reports the score of each run once when it ends", async () => {
    const { terminal, press } = fakeTerminal();
    const onGameOver = vi.fn();
    const game = playSnake(terminal, { color: false, onGameOver });

    press(RIGHT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onGameOver).toHaveBeenCalledTimes(1);

    press(`r${RIGHT}`);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onGameOver).toHaveBeenCalledTimes(2);
    expect(onGameOver).toHaveBeenCalledWith(0);

    press("q");
    await game;
  });

  test("pauses a running game when the terminal resizes", async () => {
    const { output, writes, terminal, press } = fakeTerminal();
    const game = playSnake(terminal, { color: false });
    press(RIGHT);

    output.columns = 30;
    output.emit("resize");

    expect(writes.at(-1)).toContain("Paused");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.at(-1)).toContain("Paused");
    press("q");
    await game;
  });
});
