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
  snakeTerminalRows,
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
  "\x03": "quit",
  "\x1b": "quit",
};

const ESC = "\x1b";

// oxlint-disable-next-line no-control-regex -- terminal key sequences start with \x1b
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;]*[@-~]|O[@-~])/y;
// oxlint-disable-next-line no-control-regex -- terminal key sequences start with \x1b
const ESCAPE_PREFIX = /\x1b(?:\[[0-9;]*|O)?$/y;

/**
 * Split raw terminal input into keys. Other input is dropped, and so is
 * Alt plus a key (escape followed by the key in the same read).
 *
 * The returned `pending` is an escape sequence that the chunk ends before
 * completing, because a terminal can split one key across reads. The caller
 * passes it back with the next chunk. When that chunk does not complete it,
 * a lone escape is the Esc key and a partial sequence is dropped.
 */
export function parseKeys(
  chunk: string,
  pending = "",
): { keys: SnakeKey[]; pending: string } {
  const input = pending + chunk;
  ESCAPE_SEQUENCE.lastIndex = 0;
  ESCAPE_PREFIX.lastIndex = 0;
  if (pending && !ESCAPE_SEQUENCE.test(input) && !ESCAPE_PREFIX.test(input)) {
    const key = KEYS[pending];
    const rest = parseKeys(chunk);
    return { ...rest, keys: key ? [key, ...rest.keys] : rest.keys };
  }

  const keys: SnakeKey[] = [];
  let index = 0;
  while (index < input.length) {
    ESCAPE_SEQUENCE.lastIndex = index;
    ESCAPE_PREFIX.lastIndex = index;
    const sequence = ESCAPE_SEQUENCE.exec(input)?.[0];
    if (!sequence && ESCAPE_PREFIX.test(input)) {
      return { keys, pending: input.slice(index) };
    }
    const altKey = input[index] === ESC && input[index + 1] !== ESC;
    const token = sequence ?? input.slice(index, index + (altKey ? 2 : 1));
    const key = KEYS[token] ?? KEYS[token.toLowerCase()];
    if (key) {
      keys.push(key);
    }
    index += token.length;
  }
  return { keys, pending: "" };
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

/** Whether the frame for `state` fits a terminal of `columns` × `rows`. */
export function snakeFrameFits(
  state: SnakeState,
  columns: number,
  rows: number,
): boolean {
  return (
    state.width + 2 <= columns &&
    snakeTerminalRows(state.height) + CHROME_ROWS <= rows
  );
}

const TOO_SMALL_MESSAGE = "Terminal too small · esc to quit";

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
  const score = `Bugs squashed ${state.score}`;
  const bestLabel = `  Best ${best}`;
  const scoreLine =
    score.length + bestLabel.length <= state.width
      ? `${accent(score)}${dim(bestLabel)}`
      : accent(score.slice(0, state.width));
  const lines = [
    dim(`╭${edge}╮`),
    ...renderSnake(state, DEFAULT_SNAKE_PALETTE, color).map(
      (row) => `${dim("│")}${row}${dim("│")}`,
    ),
    dim(`╰${edge}╯`),
    ` ${scoreLine}`,
    ` ${dim(STATUS_HINT[state.status].slice(0, state.width))}`,
  ];
  return `\x1b[H${lines.join("\x1b[K\r\n")}\x1b[K\x1b[J`;
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[2J";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[2J";
/** How long a lone escape waits for the rest of a split key sequence. */
const ESCAPE_TIMEOUT_MS = 100;

/**
 * Play Snake full-screen until the player quits. The terminal is restored on
 * the way out.
 */
export function playSnake(
  { input, output }: SnakeTerminal,
  { color, onGameOver }: SnakeOptions,
): Promise<void> {
  const columns = () => output.columns ?? DEFAULT_COLUMNS;
  const rows = () => output.rows ?? DEFAULT_ROWS;
  const boardSize = () => snakeBoardSize(columns(), rows());
  const fits = () => snakeFrameFits(state, columns(), rows());
  const start = boardSize();
  let state = createSnake(start.width, start.height);
  let best = 0;
  let timer: NodeJS.Timeout | undefined;
  let pendingInput = "";
  let escapeTimer: NodeJS.Timeout | undefined;

  const draw = () => {
    output.write(
      fits()
        ? renderSnakeFrame(state, best, color)
        : `\x1b[H${TOO_SMALL_MESSAGE.slice(0, columns())}\x1b[K\x1b[J`,
    );
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
      clearTimeout(escapeTimer);
      input.off("data", onData);
      output.off("resize", onResize);
      input.setRawMode(false);
      input.pause();
      output.write(LEAVE_SCREEN);
      resolve();
    };

    const onData = (chunk: string) => {
      clearTimeout(escapeTimer);
      const { keys, pending } = parseKeys(chunk, pendingInput);
      pendingInput = pending;
      for (const key of keys) {
        if (key === "quit") {
          quit();
          return;
        }
        if (!fits()) {
          continue;
        }
        if (key === "pause") {
          update(togglePause(state));
        } else if (key === "restart") {
          update(createSnake(state.width, state.height));
        } else {
          update(turnSnake(state, key));
        }
      }
      if (pending) {
        escapeTimer = setTimeout(() => {
          pendingInput = "";
          if (pending === ESC) {
            quit();
          }
        }, ESCAPE_TIMEOUT_MS);
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
