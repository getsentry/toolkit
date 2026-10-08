import {
  array,
  constantFrom,
  assert as fcAssert,
  integer,
  property,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { stripAnsi } from "../../../../src/lib/formatters/plain-detect.js";
import {
  createSnake,
  pauseSnake,
  renderSnake,
  resizeSnake,
  type SnakeDirection,
  type SnakeState,
  snakeTerminalRows,
  stepSnake,
  togglePause,
  turnSnake,
} from "../../../../src/lib/init/ui/snake-game.js";

const firstFreeCell = () => 0;

function playing(overrides: Partial<SnakeState> = {}): SnakeState {
  return {
    ...createSnake(10, 6, firstFreeCell),
    status: "playing",
    ...overrides,
  };
}

describe("snake engine", () => {
  test("starts ready and moves only once a turn starts it", () => {
    const ready = createSnake(10, 6, firstFreeCell);
    expect(ready.status).toBe("ready");
    expect(stepSnake(ready)).toBe(ready);

    const started = turnSnake(ready, "up");
    expect(started.status).toBe("playing");
    expect(stepSnake(started).body[0]).toEqual({
      x: ready.body[0]?.x,
      y: (ready.body[0]?.y ?? 0) - 1,
    });
  });

  test("ignores a reversal into its own neck", () => {
    const state = playing();
    expect(turnSnake(state, "left")).toBe(state);
  });

  test("queues quick turns and applies one per step", () => {
    const state = turnSnake(turnSnake(playing(), "up"), "left");
    expect(state.queuedTurns).toEqual(["up", "left"]);
    const once = stepSnake(state);
    expect(once.direction).toBe("up");
    expect(stepSnake(once).direction).toBe("left");
  });

  test("grows and scores when it eats food", () => {
    const state = playing();
    const head = state.body[0];
    const ate = stepSnake({
      ...state,
      food: { x: (head?.x ?? 0) + 1, y: head?.y ?? 0 },
    });
    expect(ate.score).toBe(1);
    expect(ate.body).toHaveLength(state.body.length + 1);
    expect(ate.food).not.toBeNull();
  });

  test("ends the game at a wall", () => {
    const state = playing({
      body: [
        { x: 9, y: 2 },
        { x: 8, y: 2 },
      ],
      food: { x: 0, y: 0 },
    });
    expect(stepSnake(state).status).toBe("over");
  });

  test("may follow its tail into the cell the tail leaves", () => {
    const loop = playing({
      body: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
      direction: "left",
      queuedTurns: ["down"],
      food: { x: 9, y: 5 },
    });
    expect(stepSnake(loop).status).toBe("playing");
  });

  test("pause stops steps and a turn resumes", () => {
    const paused = togglePause(playing());
    expect(paused.status).toBe("paused");
    expect(stepSnake(paused)).toBe(paused);
    expect(pauseSnake(paused)).toBe(paused);
    expect(turnSnake(paused, "up").status).toBe("playing");
  });
});

describe("renderSnake", () => {
  test("packs two board rows into each terminal row at a fixed width", () => {
    const state = createSnake(12, 7, firstFreeCell);
    const lines = renderSnake(state);
    expect(lines).toHaveLength(snakeTerminalRows(7));
    for (const line of lines) {
      expect(stripAnsi(line)).toHaveLength(12);
    }
  });

  test("draws stacked cells with half and full blocks", () => {
    const state: SnakeState = {
      ...createSnake(3, 2, firstFreeCell),
      body: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
      ],
      food: { x: 2, y: 1 },
    };
    expect(stripAnsi(renderSnake(state)[0] ?? "")).toBe("▀ ▄");
  });

  describe("without color", () => {
    const state: SnakeState = {
      ...createSnake(4, 2, firstFreeCell),
      body: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      food: { x: 2, y: 1 },
    };
    const plain = renderSnake(state, undefined, false);

    test("emits no escape codes", () => {
      expect(plain.join("")).not.toContain("\x1b");
    });

    test("keeps head, body, food and empty cells distinguishable", () => {
      expect(plain).toEqual(["@o* "]);
    });

    test("keeps the fixed width", () => {
      expect(plain.every((line) => line.length === 4)).toBe(true);
    });
  });
});

describe("engine invariants", () => {
  const directions = constantFrom<SnakeDirection>(
    "up",
    "down",
    "left",
    "right",
  );

  /** Plays random turns and steps from a seeded start and checks each state. */
  function check(
    seed: number,
    turns: SnakeDirection[],
    verify: (state: SnakeState) => void,
  ) {
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let state = createSnake(12, 8, random);
    for (const turn of turns) {
      state = stepSnake(turnSnake(state, turn), random);
      verify(state);
    }
  }

  test("the snake never overlaps itself and stays on the board", () => {
    fcAssert(
      property(
        integer({ min: 1, max: 2 ** 30 }),
        array(directions, { maxLength: 300 }),
        (seed, turns) => {
          check(seed, turns, (state) => {
            if (state.status === "over") {
              return;
            }
            const keys = state.body.map((part) => `${part.x},${part.y}`);
            expect(new Set(keys).size).toBe(keys.length);
            for (const part of state.body) {
              expect(part.x).toBeGreaterThanOrEqual(0);
              expect(part.y).toBeGreaterThanOrEqual(0);
              expect(part.x).toBeLessThan(state.width);
              expect(part.y).toBeLessThan(state.height);
            }
          });
        },
      ),
    );
  });

  test("food is never placed on the snake and the score counts growth", () => {
    fcAssert(
      property(
        integer({ min: 1, max: 2 ** 30 }),
        array(directions, { maxLength: 300 }),
        (seed, turns) => {
          check(seed, turns, (state) => {
            const food = state.food;
            if (food) {
              expect(
                state.body.some(
                  (part) => part.x === food.x && part.y === food.y,
                ),
              ).toBe(false);
            }
            expect(state.body.length).toBe(3 + state.score);
          });
        },
      ),
    );
  });
});

describe("resizeSnake", () => {
  const snake = playing({
    body: [
      { x: 8, y: 4 },
      { x: 7, y: 4 },
      { x: 6, y: 4 },
    ],
    food: { x: 9, y: 5 },
    score: 4,
  });

  test("keeps the run on a larger board and pauses it", () => {
    const resized = resizeSnake(snake, 20, 10, firstFreeCell);
    expect(resized).toMatchObject({
      width: 20,
      height: 10,
      body: snake.body,
      food: snake.food,
      score: 4,
      status: "paused",
    });
  });

  test("shifts the snake inside a smaller board", () => {
    const resized = resizeSnake(snake, 6, 4, firstFreeCell);
    expect(resized.body).toEqual([
      { x: 5, y: 3 },
      { x: 4, y: 3 },
      { x: 3, y: 3 },
    ]);
    expect(resized.score).toBe(4);
    expect(resized.food).not.toBeNull();
    const food = resized.food as { x: number; y: number };
    expect(food.x).toBeLessThan(6);
    expect(food.y).toBeLessThan(4);
  });

  test("starts over when the snake no longer fits", () => {
    const resized = resizeSnake(snake, 2, 4, firstFreeCell);
    expect(resized.score).toBe(0);
    expect(resized.status).toBe("ready");
  });

  test("returns the same state when the size does not change", () => {
    expect(resizeSnake(snake, snake.width, snake.height)).toBe(snake);
  });
});
