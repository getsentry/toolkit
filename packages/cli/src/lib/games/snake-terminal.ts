/**
 * Full-screen terminal runner for the Snake engine.
 *
 * Drives the terminal directly: alternate screen, raw-mode keys, and one
 * redraw per state change. It loads no UI framework, so the game adds only
 * this file and the engine to the CLI.
 */

import {
  createSnake,
  DEFAULT_SNAKE_PALETTE,
  renderSnake,
  resizeEndedRun,
  resizeSnake,
  type SnakeDirection,
  type SnakeState,
  type SnakeStatus,
  snakeTickMs,
  stepSnake,
  togglePause,
  turnSnake,
} from "./snake-game.js";

/** The terminal streams the game reads keys from and draws to. */
export type SnakeTerminal = {
  readonly input: Pick<
    NodeJS.ReadStream,
    "off" | "on" | "pause" | "resume" | "setEncoding" | "setRawMode"
  >;
  readonly output: Pick<
    NodeJS.WriteStream,
    "columns" | "off" | "on" | "rows" | "write"
  >;
};

export type SnakeOptions = {
  /** Draw with 24-bit color and dim chrome. */
  readonly color: boolean;
  /** Called once with the final score of each run that ends. */
  readonly onGameOver?: (score: number) => void;
};

/** A key the game reacts to. */
export type SnakeKey = SnakeDirection | "pause" | "restart" | "quit";

const KEYS: Readonly<Record<string, SnakeKey>> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  w: "up",
  k: "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  s: "down",
  j: "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  d: "right",
  l: "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  a: "left",
  h: "left",
  p: "pause",
  " ": "pause",
  r: "restart",
  q: "quit",
  "\x1b": "quit",
  "\x03": "quit",
};

// oxlint-disable-next-line no-control-regex -- terminal key sequences start with \x1b
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;]*[@-~]|O[@-~])/y;

/** Split a chunk of raw terminal input into keys. Other input is dropped. */
export function parseKeys(chunk: string): SnakeKey[] {
  const keys: SnakeKey[] = [];
  let index = 0;
  while (index < chunk.length) {
    ESCAPE_SEQUENCE.lastIndex = index;
    const token = ESCAPE_SEQUENCE.exec(chunk)?.[0] ?? chunk.charAt(index);
    const key = KEYS[token] ?? KEYS[token.toLowerCase()];
    if (key) {
      keys.push(key);
    }
    index += token.length;
  }
  return keys;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MAX_BOARD_COLUMNS = 118;
const MAX_BOARD_TERMINAL_ROWS = 14;
/** Border (2) plus the score and hint lines under the board. */
const CHROME_ROWS = 4;

/** Board size in cells for a terminal of `columns` × `rows`. */
export function snakeBoardSize(
  columns: number,
  rows: number,
): { width: number; height: number } {
  const width = Math.max(10, Math.min(MAX_BOARD_COLUMNS, columns - 2));
  const terminalRows = Math.max(
    3,
    Math.min(MAX_BOARD_TERMINAL_ROWS, rows - CHROME_ROWS),
  );
  return { width, height: terminalRows * 2 };
}

const STATUS_HINT: Record<SnakeStatus, string> = {
  ready: "Press an arrow key to start · esc to quit",
  playing: "←↑↓→ steer · p pause · r restart · esc quit",
  paused: "Paused · p to resume · esc to quit",
  over: "Game over · r to retry · esc to quit",
};

/**
 * Draw the board, its border, the score line, and the status hint. The frame
 * homes the cursor and clears what the previous frame left behind.
 */
export function renderSnakeFrame(
  state: SnakeState,
  best: number,
  color: boolean,
): string {
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[22m` : text);
  const accent = (text: string) =>
    color ? `\x1b[38;2;196;176;255m${text}\x1b[39m` : text;
  const edge = "─".repeat(state.width);
  const lines = [
    dim(`╭${edge}╮`),
    ...renderSnake(state, DEFAULT_SNAKE_PALETTE, color).map(
      (row) => `${dim("│")}${row}${dim("│")}`,
    ),
    dim(`╰${edge}╯`),
    ` ${accent(`Bugs squashed ${state.score}`)}  ${dim(`Best ${best}`)}`,
    ` ${dim(STATUS_HINT[state.status].slice(0, state.width))}`,
  ];
  return `\x1b[H${lines.join("\x1b[K\r\n")}\x1b[K\x1b[J`;
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[2J";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[2J";

/**
 * Play Snake full-screen until the player quits. The terminal is restored on
 * the way out.
 */
export function playSnake(
  { input, output }: SnakeTerminal,
  { color, onGameOver }: SnakeOptions,
): Promise<void> {
  const boardSize = () =>
    snakeBoardSize(
      output.columns ?? DEFAULT_COLUMNS,
      output.rows ?? DEFAULT_ROWS,
    );
  const start = boardSize();
  let state = createSnake(start.width, start.height);
  let best = 0;
  let timer: NodeJS.Timeout | undefined;

  const draw = () => {
    output.write(renderSnakeFrame(state, best, color));
  };

  // At most one pending step. A turn must not restart it, or steering
  // faster than the tick rate stalls the snake.
  const schedule = () => {
    if (state.status !== "playing") {
      clearTimeout(timer);
      timer = undefined;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        update(stepSnake(state));
      }, snakeTickMs(state));
    }
  };

  const update = (next: SnakeState) => {
    if (next === state) {
      return;
    }
    const previous = state;
    state = next;
    best = Math.max(best, next.score);
    if (next.status === "over" && previous.status !== "over") {
      onGameOver?.(next.score);
    }
    schedule();
    draw();
  };

  const onResize = () => {
    const { width, height } = boardSize();
    const previous = state;
    state = resizeSnake(previous, width, height);
    if (resizeEndedRun(previous, state)) {
      onGameOver?.(previous.score);
    }
    schedule();
    output.write(CLEAR_SCREEN);
    draw();
  };

  return new Promise((resolve) => {
    const quit = () => {
      clearTimeout(timer);
      input.off("data", onData);
      output.off("resize", onResize);
      input.setRawMode(false);
      input.pause();
      output.write(LEAVE_SCREEN);
      resolve();
    };

    const onData = (chunk: string) => {
      for (const key of parseKeys(chunk)) {
        if (key === "quit") {
          quit();
          return;
        }
        if (key === "pause") {
          update(togglePause(state));
        } else if (key === "restart") {
          update(createSnake(state.width, state.height));
        } else {
          update(turnSnake(state, key));
        }
      }
    };

    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
    output.on("resize", onResize);
    output.write(ENTER_SCREEN);
    draw();
  });
}
