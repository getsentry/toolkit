/**
 * Ink select picker — the self-contained sidecar.
 *
 * Renders a filterable single-choice list for entity pickers (organization,
 * project, account) inline in the terminal. `text-import-plugin` bundles this
 * file with its own copies of ink and react into `ink-app.js`, which
 * `ink-ui.ts` imports lazily, so React never loads unless a picker is shown.
 */

import { Box, render as inkRender, Text, useInput, useWindowSize } from "ink";
import { createElement, useCallback, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import {
  filterSelectOptions,
  removeLastFilterCharacter,
  sanitizeSelectFilterInput,
} from "./select-filter.js";
import type { SelectOption, SelectPrompt } from "./types.js";

/** Sentry blurple — primary brand accent. */
const ACCENT = "#7553FF";
/** De-emphasized text that still clears dark terminal backgrounds. */
const MUTED = "#898294";
/** Lowest-contrast treatment for the position counter and shortcut keys. */
const MUTED_DIM = "#68616F";

const ICONS = {
  diamondOpen: "◇",
  triangleRight: "▶",
} as const;

type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

/** A key binding; one with an `action` is listed in the footer. */
type Shortcut = {
  key: string;
  action?: string;
  match: (input: string, key: InkKey) => boolean;
  run: (input: string, key: InkKey) => void;
};

/** Width of the icon column before the title and each option. */
const ICON_COLUMN_WIDTH = 3;

/**
 * Rows the picker draws besides its title and options: the margins above and
 * below the title, the filter status, the shortcut footer, and one row of
 * headroom so Ink never fills the terminal (which forces a full redraw).
 */
const PICKER_CHROME_ROWS = 5;

/**
 * Returns the half-open option range that keeps the highlighted item visible.
 * The range never exceeds the requested viewport size or the option count.
 */
export function getOptionWindow(
  totalCount: number,
  highlighted: number,
  maxVisible: number,
): readonly [number, number] {
  const normalizedTotal = Math.max(0, Math.floor(totalCount));
  if (normalizedTotal === 0) {
    return [0, 0];
  }

  const viewportSize = Math.min(
    normalizedTotal,
    Math.max(1, Math.floor(maxVisible)),
  );
  const normalizedHighlight = Math.min(
    normalizedTotal - 1,
    Math.max(0, Math.floor(highlighted)),
  );
  const centeredStart = normalizedHighlight - Math.floor(viewportSize / 2);
  const start = Math.min(
    normalizedTotal - viewportSize,
    Math.max(0, centeredStart),
  );
  return [start, start + viewportSize];
}

/**
 * Rows the title wraps to, leaving room for the icon and the widest
 * ` (n/total)` position counter.
 */
function getTitleRows(
  title: string,
  terminalColumns: number,
  totalCount: number,
): number {
  const digits = "9".repeat(String(Math.max(1, totalCount)).length);
  const counterWidth = stringWidth(` (${digits}/${digits})`);
  const width = terminalColumns - ICON_COLUMN_WIDTH - counterWidth;
  return wrapAnsi(title, Math.max(1, width), {
    hard: true,
    trim: false,
    wordWrap: true,
  }).split("\n").length;
}

/** How many options fit below the title; at least one. */
function getOptionCapacity(terminalRows: number, titleRows: number): number {
  return Math.max(1, terminalRows - PICKER_CHROME_ROWS - titleRows);
}

function SelectPromptHeader({
  highlighted,
  isOptionWindowed,
  minTitleRows,
  title,
  totalCount,
}: {
  highlighted: number;
  isOptionWindowed: boolean;
  minTitleRows?: number;
  title: string;
  totalCount: number;
}): React.ReactNode {
  return (
    <Box marginBottom={1} minHeight={minTitleRows}>
      <Box flexShrink={0} width={ICON_COLUMN_WIDTH}>
        <Text bold color={ACCENT}>
          {ICONS.diamondOpen}
        </Text>
      </Box>
      <Text bold>{title}</Text>
      {isOptionWindowed ? (
        <Text color={MUTED_DIM}>{` (${highlighted + 1}/${totalCount})`}</Text>
      ) : null}
    </Box>
  );
}

/** The footer's shortcut hints, dropping any that don't fit the width. */
function ShortcutFooter({
  columns,
  shortcuts,
}: {
  columns: number;
  shortcuts: readonly Shortcut[];
}): React.ReactNode {
  const availableWidth = Math.max(0, columns - 2);
  let usedWidth = 0;
  const hints: { key: string; action: string }[] = [];
  for (const { key, action } of shortcuts) {
    if (action === undefined) {
      continue;
    }
    const gapWidth = hints.length === 0 ? 0 : 2;
    const hintWidth = stringWidth(`${key} ${action}`);
    if (usedWidth + gapWidth + hintWidth > availableWidth) {
      continue;
    }
    usedWidth += gapWidth + hintWidth;
    hints.push({ key, action });
  }

  return (
    <Box height={1} paddingX={1}>
      {hints.map((hint, index) => (
        <Box key={hint.key} marginRight={index < hints.length - 1 ? 2 : 0}>
          <Text bold color={MUTED_DIM}>
            {hint.key}
          </Text>
          <Text dimColor> {hint.action}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Compact entity picker (organization, project, account). */
export function SelectPicker({
  prompt,
}: {
  prompt: SelectPrompt;
}): React.ReactNode {
  const { columns, rows } = useWindowSize();
  const titleRows = getTitleRows(
    prompt.message,
    columns,
    prompt.options.length,
  );
  const maxVisibleOptions = getOptionCapacity(rows, titleRows);
  const initialHighlighted = Math.min(
    Math.max(prompt.initialIndex, 0),
    Math.max(0, prompt.options.length - 1),
  );
  const [selection, setSelection] = useState({
    query: "",
    highlighted: initialHighlighted,
  });
  const selectionRef = useRef(selection);
  // Ink can deliver paste and Enter before React commits the next render.
  const updateSelection = useCallback(
    (update: (state: typeof selection) => typeof selection) => {
      const next = update(selectionRef.current);
      selectionRef.current = next;
      setSelection(next);
    },
    [],
  );
  const { query, highlighted } = selection;
  const filteredOptions = filterSelectOptions(prompt.options, query);
  const totalCount = filteredOptions.length;
  const [windowStart, windowEnd] = getOptionWindow(
    totalCount,
    highlighted,
    maxVisibleOptions,
  );
  const visibleOptions = filteredOptions.slice(windowStart, windowEnd);
  const isWindowed = visibleOptions.length < totalCount;
  // Keep the title's height when filtering removes its window position counter.
  const minTitleRows =
    prompt.options.length > maxVisibleOptions ? titleRows : undefined;

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: "↑↓",
        action: "navigate",
        match: (_input, key) => key.upArrow || key.downArrow,
        run: (_input, key) => {
          updateSelection((state) => {
            const count = filterSelectOptions(
              prompt.options,
              state.query,
            ).length;
            if (count === 0) {
              return state;
            }
            return {
              ...state,
              highlighted:
                (state.highlighted + (key.upArrow ? count - 1 : 1)) % count,
            };
          });
        },
      },
      {
        key: "enter",
        action: "confirm",
        match: (_input, key) => key.return,
        run: () => {
          const state = selectionRef.current;
          const current = filterSelectOptions(prompt.options, state.query)[
            state.highlighted
          ];
          if (current) {
            prompt.resolve(current.value);
          }
        },
      },
      {
        key: "esc",
        action: query ? "clear filter" : "cancel",
        match: (input, key) => key.escape || (key.ctrl && input === "c"),
        run: (input, key) => {
          if (key.ctrl && input === "c") {
            prompt.resolve(null);
          } else if (selectionRef.current.query) {
            updateSelection((state) => ({
              ...state,
              query: "",
              highlighted: 0,
            }));
          } else {
            prompt.resolve(null);
          }
        },
      },
      {
        key: "backspace",
        match: (_input, key) => key.backspace || key.delete,
        run: () => {
          updateSelection((state) => {
            if (!state.query) {
              return state;
            }
            return {
              ...state,
              query: removeLastFilterCharacter(state.query),
              highlighted: 0,
            };
          });
        },
      },
      {
        key: "type",
        match: (input, key) =>
          !(key.ctrl || key.meta || key.tab) &&
          sanitizeSelectFilterInput(input).length > 0,
        run: (input) => {
          const text = sanitizeSelectFilterInput(input);
          updateSelection((state) => ({
            ...state,
            query: state.query + text,
            highlighted: 0,
          }));
        },
      },
    ],
    [prompt, query, updateSelection],
  );
  useInput((input, key) => {
    shortcuts.find((shortcut) => shortcut.match(input, key))?.run(input, key);
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <SelectPromptHeader
          highlighted={highlighted}
          isOptionWindowed={isWindowed}
          minTitleRows={minTitleRows}
          title={prompt.message}
          totalCount={totalCount}
        />
        <Box minHeight={Math.min(prompt.options.length, maxVisibleOptions)}>
          {totalCount === 0 ? (
            <Text color={MUTED} wrap="truncate">
              No matches
            </Text>
          ) : (
            <Box flexDirection="column">
              {visibleOptions.map((option, visibleIndex) => (
                <SelectPromptOptionRow
                  isCursor={windowStart + visibleIndex === highlighted}
                  key={option.value}
                  option={option}
                  query={query}
                />
              ))}
            </Box>
          )}
        </Box>
        <SelectFilterStatus
          matches={totalCount}
          query={query}
          total={prompt.options.length}
        />
      </Box>
      <ShortcutFooter columns={columns} shortcuts={shortcuts} />
    </Box>
  );
}

function SelectFilterStatus({
  matches,
  query,
  total,
}: {
  matches: number;
  query: string;
  total: number;
}): React.ReactNode {
  const color = query ? ACCENT : MUTED;
  return (
    <Box
      gap={1}
      height={1}
      overflow="hidden"
      paddingLeft={ICON_COLUMN_WIDTH}
      width="100%"
    >
      <Box flexShrink={1}>
        <Text color={color} wrap="truncate">
          {query ? `/${query}` : "type to filter"}
        </Text>
      </Box>
      {query ? (
        <Box flexShrink={0}>
          <Text color={MUTED}>{`${matches} of ${total}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SelectOptionText({
  text,
  query,
}: {
  text: string;
  query: string;
}): React.ReactNode {
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (start === -1) {
    return text;
  }
  return (
    <>
      {text.slice(0, start)}
      <Text color={ACCENT}>{text.slice(start, start + query.length)}</Text>
      {text.slice(start + query.length)}
    </>
  );
}

function SelectPromptOptionRow({
  isCursor,
  option,
  query,
}: {
  isCursor: boolean;
  option: SelectOption<string>;
  query: string;
}): React.ReactNode {
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      <Box flexShrink={0} width={ICON_COLUMN_WIDTH}>
        <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
      </Box>
      {/* Keep the label when a long hint fills the row; the hint is clipped. */}
      <Box flexShrink={0}>
        <Text bold={isCursor}>
          <SelectOptionText query={query} text={option.label} />
        </Text>
      </Box>
      {option.hint !== undefined && option.hint !== "" ? (
        <Text color={MUTED}>
          {" "}
          <SelectOptionText query={query} text={option.hint} />
        </Text>
      ) : null}
    </Box>
  );
}

/** Ink render options the picker accepts. */
type MountOptions = {
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  stdin?: import("node:tty").ReadStream;
};

/** The parts of the Ink instance the loader in `ink-ui.ts` uses. */
type MountedPicker = {
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  clear: () => void;
};

/**
 * Mount the picker with the sidecar's own Ink and React instances.
 *
 * This must live inside the sidecar so the picker's hooks and `ink.render()`
 * share one copy of React; a second copy in the main bundle causes "Invalid
 * hook call" errors.
 */
export function mountSelectPrompt(
  prompt: SelectPrompt,
  options: MountOptions,
): MountedPicker {
  return inkRender(createElement(SelectPicker, { prompt }), options);
}
