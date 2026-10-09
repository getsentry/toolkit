import { Box, type DOMElement, Text, useBoxMetrics } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { isPlainOutput } from "../../formatters/plain-detect.js";
import { type ShortcutBinding, useInkShortcuts } from "./ink-shortcuts.js";
import {
  createSnake,
  DEFAULT_SNAKE_PALETTE,
  pauseSnake,
  renderSnake,
  resizeSnake,
  type SnakeDirection,
  type SnakeState,
  type SnakeStatus,
  snakeTickMs,
  stepSnake,
  togglePause,
  turnSnake,
} from "./snake-game.js";

type InkKey = Parameters<ShortcutBinding["match"]>[1];

/**
 * Lives above the game view so a prompt can unmount the board without
 * losing the run in progress.
 */
export type SnakeSession = {
  /** The run in progress, or `null` before the board first mounts. */
  state: SnakeState | null;
  /** Highest score across runs in this session. */
  best: number;
};

/** Start an empty session for one `sentry init` run. */
export function createSnakeSession(): SnakeSession {
  return { state: null, best: 0 };
}

const MAX_BOARD_TERMINAL_ROWS = 14;
/** Border (2) plus the score and hint lines under the board. */
const BOARD_CHROME_ROWS = 4;

/** Board size in cells for a pane of `cols` × `rows` terminal cells. */
function snakeBoardSize(
  cols: number,
  rows: number,
): { width: number; height: number } {
  const width = Math.max(10, cols - 2);
  const terminalRows = Math.max(
    3,
    Math.min(MAX_BOARD_TERMINAL_ROWS, rows - BOARD_CHROME_ROWS),
  );
  return { width, height: terminalRows * 2 };
}

function steerDirection(input: string, key: InkKey): SnakeDirection | null {
  if (key.upArrow || input === "w" || input === "k") {
    return "up";
  }
  if (key.downArrow || input === "s" || input === "j") {
    return "down";
  }
  if (key.leftArrow || input === "a" || input === "h") {
    return "left";
  }
  if (key.rightArrow || input === "d" || input === "l") {
    return "right";
  }
  return null;
}

const STATUS_HINT: Record<SnakeStatus, string> = {
  ready: "Press an arrow key to start",
  playing: "",
  paused: "Paused · p to resume",
  over: "Game over · r to retry",
};

type SnakeGameProps = {
  accent: string;
  exitAction?: string;
  muted: string;
  onCancel: () => void;
  onExit: () => void;
  /** Called once with the final score when a run ends. */
  onGameOver?: (score: number) => void;
  session: SnakeSession;
};

/** Playable board sized to the pane it fills. Shows score, best score, and a status hint. */
export function SnakeGame(props: SnakeGameProps): React.ReactNode {
  const ref = useRef<DOMElement>(null);
  const pane = useBoxMetrics(ref);
  const board = pane.hasMeasured
    ? snakeBoardSize(pane.width, pane.height)
    : null;
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      ref={ref}
    >
      {board ? (
        <SnakeBoard {...props} height={board.height} width={board.width} />
      ) : null}
    </Box>
  );
}

function SnakeBoard({
  accent,
  exitAction = "back to setup",
  height,
  muted,
  onCancel,
  onExit,
  onGameOver,
  session,
  width,
}: SnakeGameProps & { height: number; width: number }): React.ReactNode {
  const [, redraw] = useReducer((frame: number) => frame + 1, 0);
  session.state = session.state
    ? resizeSnake(session.state, width, height)
    : createSnake(width, height);
  const state = session.state;
  const onGameOverRef = useRef(onGameOver);
  onGameOverRef.current = onGameOver;

  const apply = useCallback(
    (update: (current: SnakeState) => SnakeState) => {
      if (!session.state) {
        return;
      }
      const current = session.state;
      const next = update(current);
      if (next === current) {
        return;
      }
      session.state = next;
      session.best = Math.max(session.best, next.score);
      if (next.status === "over" && current.status !== "over") {
        onGameOverRef.current?.(next.score);
      }
      redraw();
    },
    [session],
  );

  useEffect(() => {
    if (state.status !== "playing") {
      return;
    }
    const timer = setTimeout(() => apply(stepSnake), snakeTickMs(state));
    return () => clearTimeout(timer);
  }, [apply, state]);

  useEffect(
    () => () => {
      if (session.state) {
        session.state = pauseSnake(session.state);
      }
    },
    [session],
  );

  const bindings = useMemo<ShortcutBinding[]>(
    () => [
      {
        key: "ctrl+c",
        action: "cancel",
        priority: 0,
        showInFooter: false,
        match: (input, key) => key.ctrl && input === "c",
        run: onCancel,
      },
      {
        key: "←↑↓→",
        action: "steer",
        priority: 10,
        match: (input, key) => steerDirection(input, key) !== null,
        run: (input, key) => {
          const direction = steerDirection(input, key);
          if (direction) {
            apply((current) => turnSnake(current, direction));
          }
        },
      },
      {
        key: "p",
        action: "pause",
        priority: 20,
        match: (input) => input === "p" || input === " ",
        run: () => apply(togglePause),
      },
      {
        key: "r",
        action: "restart",
        priority: 30,
        match: (input) => input === "r",
        run: () => apply(() => createSnake(width, height)),
      },
      {
        key: "esc",
        action: exitAction,
        priority: 40,
        match: (input, key) => key.escape || input === "q",
        run: () => {
          // Pause before the board unmounts so the invite renders the resume copy.
          apply(pauseSnake);
          onExit();
        },
      },
    ],
    [apply, exitAction, height, onCancel, onExit, width],
  );
  useInkShortcuts("snake-game", bindings);

  const frame = useMemo(
    () =>
      renderSnake(state, DEFAULT_SNAKE_PALETTE, !isPlainOutput()).join("\n"),
    [state],
  );

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box borderColor={muted} borderStyle="round" width={width + 2}>
        <Text>{frame}</Text>
      </Box>
      <Box gap={2} paddingX={1}>
        <Text color={accent}>Bugs squashed {state.score}</Text>
        <Text dimColor>Best {session.best}</Text>
      </Box>
      <Box height={1} paddingX={1}>
        <Text dimColor wrap="truncate">
          {STATUS_HINT[state.status]}
        </Text>
      </Box>
    </Box>
  );
}

/** Prompt that offers the game, or its resume when a run is paused. */
export function SnakeInvite({
  accent,
  muted,
  session,
}: {
  accent: string;
  muted: string;
  session: SnakeSession;
}): React.ReactNode {
  const paused = session.state?.status === "paused";
  return (
    <Box
      borderColor={muted}
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
    >
      <Text dimColor>
        {paused
          ? `Your snake is waiting (${session.state?.score ?? 0} bugs squashed).`
          : "Got a minute? Squash some bugs while we work."}
      </Text>
      <Text>
        Press{" "}
        <Text bold color={accent}>
          g
        </Text>{" "}
        to {paused ? "resume" : "play"} Snake {"→"}
      </Text>
    </Box>
  );
}
