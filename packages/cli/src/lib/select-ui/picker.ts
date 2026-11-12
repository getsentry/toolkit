/**
 * The fuzzy-filter select picker, drawn straight to the terminal.
 *
 * Renders a filterable single-choice list for entity pickers (organization,
 * project, account) inline below the cursor. Key parsing
 * ({@link createKeyParser}), state changes ({@link applyPickerKey}), and the
 * frame ({@link renderPicker}) are pure; {@link mountSelectPrompt} wires them
 * to a terminal and redraws the frame in place after each key. It uses no
 * UI framework, so it runs from source under Node's type stripping and
 * bundles into an ordinary lazy chunk.
 */

import { StringDecoder } from "node:string_decoder";
import chalk from "chalk";
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

/** Width of the icon column before the title and each option. */
const ICON_COLUMN_WIDTH = 3;

/**
 * Rows the picker draws besides its title and options: the margins above and
 * below the title, the filter status, the shortcut footer, and one row of
 * headroom so the frame never fills the terminal. A frame that scrolls the
 * terminal can't be redrawn in place.
 */
const PICKER_CHROME_ROWS = 5;

/** How long a bare Esc waits for the rest of a split escape sequence. */
const ESCAPE_TIMEOUT_MS = 20;

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/** A CSI sequence: parameters, intermediates, then one final byte. */
// oxlint-disable-next-line no-control-regex -- parses terminal escape sequences
const CSI_RE = /^\u001b\[[0-?]*[ -/]*[@-~]/;
/** An SS3 sequence, which some terminals send for arrow keys. */
// oxlint-disable-next-line no-control-regex -- parses terminal escape sequences
const SS3_RE = /^\u001bO./;
// oxlint-disable-next-line no-control-regex -- splits typed text from control keys
const PRINTABLE_RUN_RE = /^[^\u0000-\u001f\u007f]+/;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** A key the picker reacts to. */
type PickerKey =
  | { name: "up" | "down" | "enter" | "escape" | "backspace" | "cancel" }
  | { name: "text"; text: string };

/** The filter query and the highlighted index into the filtered options. */
type PickerState = { query: string; highlighted: number };

/** Terminal size the frame must fit in. */
type TerminalSize = { columns: number; rows: number };

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
 * Turns raw terminal input into picker keys.
 *
 * Bracketed paste becomes one text key, so a pasted newline never confirms.
 * Escape sequences the picker doesn't use (other CSI keys, Alt+key) are
 * dropped. A chunk that ends in a bare Esc keeps it pending, because the
 * rest of an arrow key's sequence can arrive in the next chunk; `flush()`
 * turns a pending Esc into the Esc key.
 */
export function createKeyParser(): {
  push: (chunk: string) => PickerKey[];
  flush: () => PickerKey[];
  hasPendingEscape: () => boolean;
} {
  let pending = "";
  let pasting = false;

  const push = (chunk: string): PickerKey[] => {
    const keys: PickerKey[] = [];
    let input = pending + chunk;
    pending = "";
    const addText = (text: string) => {
      const last = keys.at(-1);
      if (last?.name === "text") {
        last.text += text;
      } else if (text) {
        keys.push({ name: "text", text });
      }
    };

    while (input) {
      if (pasting) {
        const end = input.indexOf(PASTE_END);
        addText(
          sanitizeSelectFilterInput(end === -1 ? input : input.slice(0, end)),
        );
        if (end === -1) {
          break;
        }
        pasting = false;
        input = input.slice(end + PASTE_END.length);
        continue;
      }
      if (input.startsWith(PASTE_START)) {
        pasting = true;
        input = input.slice(PASTE_START.length);
        continue;
      }
      if (input === ESC) {
        pending = ESC;
        break;
      }
      const sequence = CSI_RE.exec(input)?.[0] ?? SS3_RE.exec(input)?.[0];
      if (sequence) {
        const final = sequence.at(-1);
        if (final === "A") {
          keys.push({ name: "up" });
        } else if (final === "B") {
          keys.push({ name: "down" });
        } else if (sequence === `${ESC}[3~`) {
          keys.push({ name: "backspace" });
        }
        input = input.slice(sequence.length);
        continue;
      }
      if (input.startsWith(ESC)) {
        // Esc Esc is two Esc presses; Esc + another key is Alt+key.
        if (input[1] === ESC) {
          keys.push({ name: "escape" });
          input = input.slice(1);
        } else {
          input = input.slice(2);
        }
        continue;
      }
      const printable = PRINTABLE_RUN_RE.exec(input)?.[0];
      if (printable) {
        addText(sanitizeSelectFilterInput(printable));
        input = input.slice(printable.length);
        continue;
      }
      const control = input[0];
      if (control === "\r" || control === "\n") {
        keys.push({ name: "enter" });
      } else if (control === "\u007f" || control === "\b") {
        keys.push({ name: "backspace" });
      } else if (control === "\u0003") {
        keys.push({ name: "cancel" });
      }
      input = input.slice(1);
    }
    return keys;
  };

  return {
    push,
    flush: () => {
      if (!pending) {
        return [];
      }
      pending = "";
      return [{ name: "escape" }];
    },
    hasPendingEscape: () => pending !== "",
  };
}

/**
 * Applies one key. Returns the next state, or `{ value }` when the key ends
 * the prompt: the chosen option's value, or `null` on cancel.
 */
function applyPickerKey(
  options: readonly SelectOption<string>[],
  state: PickerState,
  key: PickerKey,
): PickerState | { value: string | null } {
  switch (key.name) {
    case "up":
    case "down": {
      const count = filterSelectOptions(options, state.query).length;
      if (count === 0) {
        return state;
      }
      const step = key.name === "up" ? count - 1 : 1;
      return { ...state, highlighted: (state.highlighted + step) % count };
    }
    case "enter": {
      const current = filterSelectOptions(options, state.query)[
        state.highlighted
      ];
      return current ? { value: current.value } : state;
    }
    case "escape":
      return state.query ? { query: "", highlighted: 0 } : { value: null };
    case "cancel":
      return { value: null };
    case "backspace":
      return state.query
        ? { query: removeLastFilterCharacter(state.query), highlighted: 0 }
        : state;
    case "text":
      return key.text
        ? { query: state.query + key.text, highlighted: 0 }
        : state;
  }
}

/** A run of text with one style, so a line can be clipped before styling. */
type Segment = { text: string; style?: (text: string) => string };

/** Cuts `text` to at most `width` terminal columns, on grapheme boundaries. */
function sliceToWidth(text: string, width: number): string {
  let used = 0;
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > width) {
      return text.slice(0, index);
    }
    used += segmentWidth;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

/** Like {@link sliceToWidth}, but marks a cut with a trailing ellipsis. */
function truncateToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) {
    return text;
  }
  return width <= 0 ? "" : `${sliceToWidth(text, width - 1)}…`;
}

/** Styles and joins segments, clipping the line at `width` columns. */
function fitLine(segments: readonly Segment[], width: number): string {
  let remaining = width;
  let line = "";
  for (const { text, style } of segments) {
    if (remaining <= 0) {
      break;
    }
    const clipped = sliceToWidth(text, remaining);
    remaining -= stringWidth(clipped);
    if (clipped) {
      line += style ? style(clipped) : clipped;
    }
  }
  return line;
}

/** Splits `text` so the first case-insensitive match of `query` stands out. */
function highlightMatch(
  text: string,
  query: string,
  style: (text: string) => string,
  matchStyle: (text: string) => string,
): Segment[] {
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (start === -1) {
    return [{ text, style }];
  }
  const end = start + query.length;
  return [
    { text: text.slice(0, start), style },
    { text: text.slice(start, end), style: matchStyle },
    { text: text.slice(end), style },
  ];
}

function padIcon(icon: string): string {
  return icon.padEnd(ICON_COLUMN_WIDTH);
}

/**
 * Rows the title wraps to, leaving room for the icon and the widest
 * ` (n/total)` position counter.
 */
function wrapTitle(
  title: string,
  columns: number,
  totalCount: number,
): string[] {
  const digits = "9".repeat(String(Math.max(1, totalCount)).length);
  const counterWidth = stringWidth(` (${digits}/${digits})`);
  const width = columns - ICON_COLUMN_WIDTH - counterWidth;
  return wrapAnsi(title, Math.max(1, width), {
    hard: true,
    trim: false,
    wordWrap: true,
  }).split("\n");
}

function renderOptionRow(
  option: SelectOption<string>,
  isCursor: boolean,
  query: string,
  columns: number,
): string {
  const accent = chalk.hex(ACCENT);
  const muted = chalk.hex(MUTED);
  const label = isCursor ? chalk.bold : (text: string) => text;
  const segments: Segment[] = [
    { text: padIcon(isCursor ? ICONS.triangleRight : ""), style: accent },
    ...highlightMatch(option.label, query, label, (text) =>
      label(accent(text)),
    ),
  ];
  if (option.hint) {
    segments.push(
      { text: " " },
      ...highlightMatch(option.hint, query, muted, accent),
    );
  }
  return fitLine(segments, columns);
}

function renderFilterStatus(
  query: string,
  matches: number,
  total: number,
  columns: number,
): string {
  const indent = " ".repeat(ICON_COLUMN_WIDTH);
  if (!query) {
    return fitLine(
      [{ text: indent }, { text: "type to filter", style: chalk.hex(MUTED) }],
      columns,
    );
  }
  const count = ` ${matches} of ${total}`;
  const queryWidth = columns - ICON_COLUMN_WIDTH - stringWidth(count);
  return fitLine(
    [
      { text: indent },
      {
        text: truncateToWidth(`/${query}`, queryWidth),
        style: chalk.hex(ACCENT),
      },
      { text: count, style: chalk.hex(MUTED) },
    ],
    columns,
  );
}

/** The footer's shortcut hints, dropping any that don't fit the width. */
function renderFooter(query: string, columns: number): string {
  const shortcuts = [
    { key: "↑↓", action: "navigate" },
    { key: "enter", action: "confirm" },
    { key: "esc", action: query ? "clear filter" : "cancel" },
  ];
  const availableWidth = Math.max(0, columns - 2);
  let usedWidth = 0;
  const hints: string[] = [];
  for (const { key, action } of shortcuts) {
    const gapWidth = hints.length === 0 ? 0 : 2;
    const hintWidth = stringWidth(`${key} ${action}`);
    if (usedWidth + gapWidth + hintWidth > availableWidth) {
      continue;
    }
    usedWidth += gapWidth + hintWidth;
    hints.push(`${chalk.bold.hex(MUTED_DIM)(key)}${chalk.dim(` ${action}`)}`);
  }
  return ` ${hints.join("  ")}`;
}

/**
 * Draws the picker for `state` as terminal lines. The frame is always
 * shorter than the terminal, and the filter row stays on the same line
 * while the query changes.
 */
function renderPicker(
  prompt: Pick<SelectPrompt, "message" | "options">,
  state: PickerState,
  { columns, rows }: TerminalSize,
): string[] {
  const { query, highlighted } = state;
  const titleLines = wrapTitle(prompt.message, columns, prompt.options.length);
  const maxVisible = Math.max(1, rows - PICKER_CHROME_ROWS - titleLines.length);
  const filtered = filterSelectOptions(prompt.options, query);
  const [windowStart, windowEnd] = getOptionWindow(
    filtered.length,
    highlighted,
    maxVisible,
  );
  const isWindowed = windowEnd - windowStart < filtered.length;

  const accent = chalk.hex(ACCENT);
  const lines = [""];
  titleLines.forEach((line, index) => {
    const icon = padIcon(index === 0 ? ICONS.diamondOpen : "");
    const counter =
      index === 0 && isWindowed
        ? chalk.hex(MUTED_DIM)(` (${highlighted + 1}/${filtered.length})`)
        : "";
    lines.push(`${accent.bold(icon)}${chalk.bold(line)}${counter}`);
  });
  lines.push("");

  const optionLines =
    filtered.length === 0
      ? [chalk.hex(MUTED)(truncateToWidth("No matches", columns))]
      : filtered
          .slice(windowStart, windowEnd)
          .map((option, index) =>
            renderOptionRow(
              option,
              windowStart + index === highlighted,
              query,
              columns,
            ),
          );
  // Keep the option area's height while filtering shrinks the list.
  const optionRows = Math.min(prompt.options.length, maxVisible);
  while (optionLines.length < optionRows) {
    optionLines.push("");
  }
  lines.push(...optionLines);
  lines.push(
    renderFilterStatus(query, filtered.length, prompt.options.length, columns),
  );
  lines.push(renderFooter(query, columns));
  return lines;
}

/** The input side of the terminal the picker reads keys from. */
type PickerInput = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
};

/** The output side of the terminal the picker draws on. */
type PickerOutput = {
  columns?: number;
  rows?: number;
  write(text: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  removeListener(event: "resize", listener: () => void): unknown;
};

/** A mounted picker; `close()` erases it and stops reading keys. */
export type MountedPicker = { close: () => void };

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ERASE_DOWN = `${ESC}[J`;

/**
 * Draws the picker on `output` and reads keys from `input` until the prompt
 * resolves. The caller puts `input` in raw mode and closes the picker after
 * the prompt resolves.
 */
export function mountSelectPrompt(
  prompt: SelectPrompt,
  { input, output }: { input: PickerInput; output: PickerOutput },
): MountedPicker {
  const decoder = new StringDecoder("utf8");
  const parser = createKeyParser();
  let state: PickerState = {
    query: "",
    highlighted: Math.min(
      Math.max(prompt.initialIndex, 0),
      Math.max(0, prompt.options.length - 1),
    ),
  };
  let drawnLines = 0;
  let done = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Moves to the first line of the last frame and erases it. */
  const eraseFrame = () =>
    `${drawnLines > 1 ? `${ESC}[${drawnLines - 1}A` : ""}\r${ERASE_DOWN}`;

  const draw = () => {
    const lines = renderPicker(prompt, state, {
      columns: output.columns || 80,
      rows: output.rows || 24,
    });
    output.write(`${eraseFrame()}${lines.join("\n")}`);
    drawnLines = lines.length;
  };

  const handleKeys = (keys: PickerKey[]) => {
    for (const key of keys) {
      if (done) {
        return;
      }
      const next = applyPickerKey(prompt.options, state, key);
      if ("value" in next) {
        done = true;
        prompt.resolve(next.value);
        return;
      }
      state = next;
    }
    draw();
  };

  const onData = (chunk: Buffer | string) => {
    clearTimeout(escapeTimer);
    handleKeys(
      parser.push(typeof chunk === "string" ? chunk : decoder.write(chunk)),
    );
    if (parser.hasPendingEscape()) {
      escapeTimer = setTimeout(
        () => handleKeys(parser.flush()),
        ESCAPE_TIMEOUT_MS,
      );
    }
  };

  output.write(HIDE_CURSOR);
  draw();
  input.on("data", onData);
  output.on("resize", draw);

  return {
    close: () => {
      done = true;
      clearTimeout(escapeTimer);
      input.removeListener("data", onData);
      output.removeListener("resize", draw);
      output.write(`${eraseFrame()}${SHOW_CURSOR}`);
      drawnLines = 0;
    },
  };
}
