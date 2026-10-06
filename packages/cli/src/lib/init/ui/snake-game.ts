/**
 * Snake engine for the `sentry init` waiting screen.
 *
 * Pure state transitions plus a string renderer so the Ink component
 * only owns timing and input. The board uses half-block glyphs: one
 * terminal row holds two board rows, which makes cells roughly square
 * and keeps the whole frame a single `<Text>` node for Ink.
 */

export type SnakeDirection = "up" | "down" | "left" | "right";

export type SnakeStatus = "ready" | "playing" | "paused" | "over";

export type SnakePoint = { x: number; y: number };

export type SnakeState = {
  width: number;
  height: number;
  /** Head first. */
  body: SnakePoint[];
  direction: SnakeDirection;
  /** Turns pressed faster than the tick rate, applied one per step. */
  queuedTurns: SnakeDirection[];
  food: SnakePoint | null;
  score: number;
  status: SnakeStatus;
};

export type RandomSource = () => number;

const MAX_QUEUED_TURNS = 2;
const START_LENGTH = 3;

const OPPOSITE: Record<SnakeDirection, SnakeDirection> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

const DELTA: Record<SnakeDirection, SnakePoint> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function createSnake(
  width: number,
  height: number,
  random: RandomSource = Math.random,
): SnakeState {
  const y = Math.floor(height / 2);
  const headX = Math.min(width - 1, Math.floor(width / 3) + START_LENGTH);
  const body: SnakePoint[] = [];
  for (let i = 0; i < START_LENGTH; i++) {
    body.push({ x: Math.max(0, headX - i), y });
  }
  const state: SnakeState = {
    width,
    height,
    body,
    direction: "right",
    queuedTurns: [],
    food: null,
    score: 0,
    status: "ready",
  };
  return { ...state, food: placeFood(state, random) };
}

/** Milliseconds between steps; the snake speeds up as it grows. */
export function snakeTickMs(state: SnakeState): number {
  return Math.max(55, 110 - state.score * 3);
}

export function turnSnake(
  state: SnakeState,
  direction: SnakeDirection,
): SnakeState {
  if (state.status === "over") {
    return state;
  }
  // Any steering key also starts a ready game or resumes a paused one.
  const started: SnakeState =
    state.status === "playing" ? state : { ...state, status: "playing" };
  const last = state.queuedTurns.at(-1) ?? state.direction;
  if (
    direction === last ||
    direction === OPPOSITE[last] ||
    state.queuedTurns.length >= MAX_QUEUED_TURNS
  ) {
    return started;
  }
  return { ...started, queuedTurns: [...state.queuedTurns, direction] };
}

export function togglePause(state: SnakeState): SnakeState {
  if (state.status === "playing") {
    return { ...state, status: "paused" };
  }
  if (state.status === "paused") {
    return { ...state, status: "playing" };
  }
  return state;
}

export function pauseSnake(state: SnakeState): SnakeState {
  return state.status === "playing" ? { ...state, status: "paused" } : state;
}

export function stepSnake(
  state: SnakeState,
  random: RandomSource = Math.random,
): SnakeState {
  if (state.status !== "playing") {
    return state;
  }
  const [nextTurn, ...queuedTurns] = state.queuedTurns;
  const direction = nextTurn ?? state.direction;
  const head = state.body[0];
  if (!head) {
    return { ...state, status: "over" };
  }
  const delta = DELTA[direction];
  const next = { x: head.x + delta.x, y: head.y + delta.y };
  const eats = state.food !== null && samePoint(next, state.food);
  // The tail moves away this step unless the snake grows, so the head may
  // enter the cell the tail is leaving.
  const blockers = eats ? state.body : state.body.slice(0, -1);
  if (
    next.x < 0 ||
    next.y < 0 ||
    next.x >= state.width ||
    next.y >= state.height ||
    blockers.some((part) => samePoint(part, next))
  ) {
    return { ...state, direction, queuedTurns, status: "over" };
  }
  const body = [next, ...blockers];
  const moved: SnakeState = { ...state, body, direction, queuedTurns };
  if (!eats) {
    return moved;
  }
  const grown = { ...moved, score: state.score + 1 };
  const food = placeFood(grown, random);
  return food ? { ...grown, food } : { ...grown, food, status: "over" };
}

/**
 * Fit a run to a new board size. The snake keeps its shape and moves only
 * as far as it must to stay on the board. A playing run pauses so the new
 * walls do not end it by surprise. A snake too long for the board starts over.
 */
export function resizeSnake(
  state: SnakeState,
  width: number,
  height: number,
  random: RandomSource = Math.random,
): SnakeState {
  if (state.width === width && state.height === height) {
    return state;
  }
  const xs = state.body.map((part) => part.x);
  const ys = state.body.map((part) => part.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  if (maxX - minX >= width || maxY - minY >= height) {
    return createSnake(width, height, random);
  }
  const dx = Math.min(0, width - 1 - maxX);
  const dy = Math.min(0, height - 1 - maxY);
  const shift = (point: SnakePoint): SnakePoint => ({
    x: point.x + dx,
    y: point.y + dy,
  });
  const resized: SnakeState = {
    ...pauseSnake(state),
    width,
    height,
    body: state.body.map(shift),
  };
  const food = state.food ? shift(state.food) : null;
  if (food && food.x >= 0 && food.y >= 0 && food.x < width && food.y < height) {
    return { ...resized, food };
  }
  const placed = placeFood(resized, random);
  return placed
    ? { ...resized, food: placed }
    : { ...resized, food: null, status: "over" };
}

function placeFood(state: SnakeState, random: RandomSource): SnakePoint | null {
  const occupied = new Set(state.body.map((part) => pointKey(part)));
  const free = state.width * state.height - occupied.size;
  if (free <= 0) {
    return null;
  }
  let pick = Math.floor(random() * free);
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (occupied.has(pointKey({ x, y }))) {
        continue;
      }
      if (pick === 0) {
        return { x, y };
      }
      pick -= 1;
    }
  }
  return null;
}

function samePoint(a: SnakePoint, b: SnakePoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function pointKey(point: SnakePoint): string {
  return `${point.x},${point.y}`;
}

// ────────────────────────────── Rendering ─────────────────────────────

const EMPTY = 0;
const BODY = 1;
const HEAD = 2;
const FOOD = 3;

type CellKind = typeof EMPTY | typeof BODY | typeof HEAD | typeof FOOD;

export type SnakePalette = Record<
  Exclude<CellKind, typeof EMPTY>,
  [number, number, number]
>;

export const DEFAULT_SNAKE_PALETTE: SnakePalette = {
  [BODY]: [139, 106, 200],
  [HEAD]: [196, 176, 255],
  [FOOD]: [255, 90, 122],
};

/** Terminal rows needed to draw a board of `height` cells. */
export function snakeTerminalRows(height: number): number {
  return Math.ceil(height / 2);
}

/**
 * Draw the board as `snakeTerminalRows(height)` lines, each exactly
 * `width` columns wide. Colors are 24-bit SGR sequences that change
 * only between runs of different styles.
 */
export function renderSnake(
  state: SnakeState,
  palette: SnakePalette = DEFAULT_SNAKE_PALETTE,
): string[] {
  const cells = new Uint8Array(state.width * state.height);
  if (state.food) {
    cells[state.food.y * state.width + state.food.x] = FOOD;
  }
  state.body.forEach((part, index) => {
    cells[part.y * state.width + part.x] = index === 0 ? HEAD : BODY;
  });

  const lines: string[] = [];
  for (let row = 0; row < snakeTerminalRows(state.height); row++) {
    let line = "";
    let activeStyle = "";
    for (let x = 0; x < state.width; x++) {
      const top = cells[row * 2 * state.width + x] as CellKind;
      const bottomY = row * 2 + 1;
      const bottom =
        bottomY < state.height
          ? (cells[bottomY * state.width + x] as CellKind)
          : EMPTY;
      const [style, glyph] = halfBlock(top, bottom, palette);
      if (style !== activeStyle) {
        line += activeStyle ? `\x1b[0m${style}` : style;
        activeStyle = style;
      }
      line += glyph;
    }
    lines.push(activeStyle ? `${line}\x1b[0m` : line);
  }
  return lines;
}

function halfBlock(
  top: CellKind,
  bottom: CellKind,
  palette: SnakePalette,
): [string, string] {
  if (top === EMPTY && bottom === EMPTY) {
    return ["", " "];
  }
  if (bottom === EMPTY) {
    return [fg(palette[top as Exclude<CellKind, 0>]), "▀"];
  }
  if (top === EMPTY) {
    return [fg(palette[bottom]), "▄"];
  }
  if (top === bottom) {
    return [fg(palette[top]), "█"];
  }
  return [`${fg(palette[top])}${bg(palette[bottom])}`, "▀"];
}

function fg([r, g, b]: [number, number, number]): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg([r, g, b]: [number, number, number]): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}
