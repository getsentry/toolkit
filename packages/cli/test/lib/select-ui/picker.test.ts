/**
 * Rendering and keyboard tests for the select picker.
 *
 * Each test mounts the picker on a captured stream, feeds it keystrokes, and
 * checks the last frame and the value the prompt resolved with.
 */

import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import {
  createKeyParser,
  mountSelectPrompt,
} from "../../../src/lib/select-ui/picker.js";
import type { SelectPrompt } from "../../../src/lib/select-ui/types.js";

/** Each frame starts by returning to the picker's first line and erasing. */
const FRAME_START = "\r\u001b[J";
// oxlint-disable-next-line no-control-regex -- matching ANSI escape sequences in captured picker output
const ANSI_CSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const LINE_SPLIT_RE = /\r?\n/;
const DOWN_ARROW = "\u001B[B";
const UP_ARROW = "\u001B[A";
/** Longer than the picker's wait for the rest of a split escape sequence. */
const ESCAPE_SETTLE_MS = 50;

class CaptureStream extends EventEmitter {
  output = "";
  readonly columns: number;
  readonly rows: number;
  constructor(columns = 120, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(text: string): boolean {
    this.output += text;
    return true;
  }
  latestFrame(): string {
    const start = this.output.lastIndexOf(FRAME_START);
    return start === -1
      ? this.output
      : this.output.slice(start + FRAME_START.length);
  }
}

function stripAnsi(output: string): string {
  return output.replace(ANSI_CSI_RE, "");
}

/** Mount the picker, type `input` chunk by chunk, and return the output. */
async function renderPicker(
  prompt: SelectPrompt,
  columns: number,
  options: { rows?: number; input?: string[] } = {},
): Promise<{ frame: string; all: string }> {
  const output = new CaptureStream(columns, options.rows ?? 40);
  const input = new EventEmitter();
  const picker = mountSelectPrompt(prompt, { input, output });
  for (const chunk of options.input ?? []) {
    input.emit("data", Buffer.from(chunk));
    if (chunk.endsWith("\u001b")) {
      await sleep(ESCAPE_SETTLE_MS);
    }
  }
  const frame = stripAnsi(output.latestFrame());
  picker.close();
  return { frame, all: stripAnsi(output.output) };
}

function ignorePromptResolution(): void {
  // Some tests render the prompt but never submit it.
}

describe("select picker", () => {
  test("typing filters entity names and slugs and confirms the visible choice", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Choose an organization",
      options: [
        { value: "backend", label: "Backend" },
        { value: "front-admin", label: "Administration", hint: "front-admin" },
        { value: "web", label: "Frontend" },
      ],
      initialIndex: 0,
      resolve,
    };

    const { frame } = await renderPicker(prompt, 120, {
      input: ["FRONT", DOWN_ARROW],
    });
    expect(frame).toContain("/FRONT");
    expect(frame).toContain("2 of 3");
    expect(frame).toContain("Administration");
    expect(frame).not.toContain("Backend");

    await renderPicker(prompt, 120, { input: ["FRONT", DOWN_ARROW, "\r"] });
    expect(resolve).toHaveBeenCalledWith("web");
  });

  test("typing a typo filters and confirms the matching entity", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Choose a project",
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend", label: "Frontend" },
      ],
      initialIndex: 0,
      resolve,
    };

    const { frame } = await renderPicker(prompt, 80, {
      input: ["\u001b[200~fronend\u001b[201~"],
    });
    expect(frame).toContain("/fronend 1 of 2");
    expect(frame).toContain("Frontend");
    expect(frame).not.toContain("Backend");

    await renderPicker(prompt, 80, {
      input: ["\u001b[200~fronend\u001b[201~\r"],
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend");
  });

  test("zero matches cannot be confirmed and Backspace restores matches", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [{ value: "frontend", label: "Web app", hint: "Frontend" }],
      initialIndex: 0,
      resolve,
    };

    const empty = await renderPicker(prompt, 120, {
      input: ["frozz", `${DOWN_ARROW}\r`],
    });
    expect(empty.frame).toContain("No matches");
    expect(resolve).not.toHaveBeenCalled();

    const restored = await renderPicker(prompt, 120, {
      input: ["frozz", "\u007f"],
    });
    expect(restored.frame).toContain("/froz 1 of 1");
    await renderPicker(prompt, 120, { input: ["frozz", "\u007f\r"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend");
  });

  test.each([
    {
      action: "confirms the first filtered option",
      navigation: "",
      expected: "frontend-a",
    },
    {
      action: "wraps up to the last filtered option",
      navigation: UP_ARROW,
      expected: "frontend-b",
    },
    {
      action: "wraps down within the filtered options",
      navigation: DOWN_ARROW.repeat(2),
      expected: "frontend-a",
    },
  ])("same-chunk paste and Enter $action", async ({ navigation, expected }) => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Choose a project",
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend-a", label: "Frontend A" },
        { value: "frontend-b", label: "Frontend B" },
      ],
      initialIndex: 0,
      resolve,
    };

    await renderPicker(prompt, 80, {
      input: [`\u001b[200~front\u001b[201~${navigation}\r`],
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expected);
  });

  test("a pasted newline does not confirm", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Choose a project",
      options: [{ value: "frontend", label: "Frontend" }],
      initialIndex: 0,
      resolve,
    };

    const { frame } = await renderPicker(prompt, 80, {
      input: ["\u001b[200~front\r\nend\u001b[201~"],
    });
    expect(frame).toContain("/frontend 1 of 1");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("same-chunk paste and Enter cannot confirm a filter with no matches", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Choose an organization",
      options: [{ value: "backend", label: "Backend" }],
      initialIndex: 0,
      resolve,
    };

    const { frame } = await renderPicker(prompt, 80, {
      input: ["\u001b[200~missing\u001b[201~\r"],
    });
    expect(frame).toContain("No matches");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("same-chunk Backspace and Enter confirm a restored filter match", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend", label: "Frontend" },
      ],
      initialIndex: 0,
      resolve,
    };

    await renderPicker(prompt, 80, {
      input: ["\u001b[200~frozz\u001b[201~\u007f\r"],
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend");
  });

  test.each([
    { key: "Backspace", input: "\u007f" },
    { key: "Delete", input: "\u001b[3~" },
  ])(
    "$key preserves the selection when the filter is empty",
    async ({ input }) => {
      const resolve = vi.fn();
      const prompt: SelectPrompt = {
        message: "Choose a project",
        options: [
          { value: "backend", label: "Backend" },
          { value: "frontend", label: "Frontend" },
          { value: "worker", label: "Worker" },
        ],
        initialIndex: 1,
        resolve,
      };

      const { frame } = await renderPicker(prompt, 80, {
        input: [`${DOWN_ARROW}${input}`],
      });
      expect(frame).toContain("type to filter");
      await renderPicker(prompt, 80, { input: [`${DOWN_ARROW}${input}\r`] });
      expect(resolve).toHaveBeenCalledExactlyOnceWith("worker");
    },
  );

  test("Esc clears the filter before cancelling, while Ctrl+C cancels directly", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [{ value: "frontend", label: "Frontend" }],
      initialIndex: 0,
      resolve,
    };
    const cleared = await renderPicker(prompt, 120, {
      input: ["front", "\u001b"],
    });
    expect(cleared.frame).toContain("type to filter");
    expect(resolve).not.toHaveBeenCalled();

    await renderPicker(prompt, 120, { input: ["front", "\u001b", "\u001b"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
    resolve.mockClear();
    await renderPicker(prompt, 120, { input: ["front", "\u0003"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
  });

  test("an arrow key split across chunks moves instead of clearing", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [
        { value: "frontend-a", label: "Frontend A" },
        { value: "frontend-b", label: "Frontend B" },
      ],
      initialIndex: 0,
      resolve,
    };
    const output = new CaptureStream(80);
    const input = new EventEmitter();
    const picker = mountSelectPrompt(prompt, { input, output });
    try {
      input.emit("data", "front\u001b");
      input.emit("data", "[B\r");
    } finally {
      picker.close();
    }
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend-b");
  });

  test("the compact project picker filters with the same keyboard controls", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend-web", label: "Web", hint: "frontend-web" },
      ],
      initialIndex: 0,
      resolve,
    };
    const { frame } = await renderPicker(prompt, 80, { input: ["front"] });
    expect(frame).toContain("/front");
    expect(frame).toContain("1 of 2");
    await renderPicker(prompt, 80, { input: ["front", "\r"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend-web");
  });

  test("filterable lists keep the query inside a narrow terminal", async () => {
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: Array.from({ length: 20 }, (_, index) => ({
        value: `project-${index}`,
        label: `${index < 11 ? "Frontend" : "Backend"} ${index}`,
      })),
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };
    const { frame } = await renderPicker(prompt, 40, {
      rows: 24,
      input: ["frontend", DOWN_ARROW],
    });
    expect(frame).toContain("/frontend");
    expect(frame).toContain("11 of 20");
    const lines = frame.split(LINE_SPLIT_RE);
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });

  test.each([{ optionCount: 1 }, { optionCount: 3 }, { optionCount: 20 }])(
    "keeps the filter row fixed with $optionCount options",
    async ({ optionCount }) => {
      const prompt: SelectPrompt = {
        message: "Select a project in acme-platforms:",
        options: Array.from({ length: optionCount }, (_, index) => ({
          value: index === 0 ? "frontend" : `project-${index}`,
          label: index === 0 ? "Frontend" : `Project ${index}`,
        })),
        initialIndex: 0,
        resolve: ignorePromptResolution,
      };

      let initialFilterRow = -1;
      for (const { input, status } of [
        { input: [], status: "type to filter" },
        { input: ["fronend"], status: `/fronend 1 of ${optionCount}` },
        { input: ["missing"], status: `/missing 0 of ${optionCount}` },
        { input: ["missing", "\u001b"], status: "type to filter" },
      ]) {
        const { frame } = await renderPicker(prompt, 40, { rows: 24, input });
        const lines = frame.split(LINE_SPLIT_RE);
        const filterRow = lines.findIndex((line) => line.includes(status));
        expect(filterRow).toBeGreaterThanOrEqual(0);
        if (initialFilterRow === -1) {
          initialFilterRow = filterRow;
        }
        expect(filterRow).toBe(initialFilterRow);
        expect(lines.length).toBeLessThanOrEqual(23);
      }
    },
  );

  test("long select prompts only render options that fit the terminal", async () => {
    const prompt: SelectPrompt = {
      message: "Select a project in acme-platforms:",
      options: Array.from({ length: 20 }, (_value, index) => ({
        value: `project-${index + 1}`,
        label: `Project ${index + 1}`,
      })),
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };

    const { frame } = await renderPicker(prompt, 120, { rows: 24 });
    expect(frame).toContain("Select a project in acme-platforms:");
    expect(frame).toContain("(1/20)");
    expect(frame).toContain("Project 1");
    expect(frame).not.toContain("Project 20");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(23);

    const scrolled = await renderPicker(prompt, 120, {
      input: Array.from({ length: 7 }, () => DOWN_ARROW),
      rows: 24,
    });
    expect(scrolled.frame).toContain("(8/20)");
    expect(scrolled.frame).toContain("Project 8");
  });

  test("long option hints stay on one terminal row", async () => {
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [
        {
          value: "project-1",
          label: "A",
          hint: "This deliberately long project name would wrap onto another row UNIQUE_TAIL",
        },
        { value: "project-2", label: "Project 2" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };

    const { frame } = await renderPicker(prompt, 40, { rows: 24 });
    expect(frame).toContain("▶  A This deliberately");
    expect(frame).not.toContain("UNIQUE_TAIL");
  });

  test("turns bracketed paste on while mounted and off on close", () => {
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [{ value: "frontend", label: "Frontend" }],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };
    const output = new CaptureStream(80);
    const picker = mountSelectPrompt(prompt, {
      input: new EventEmitter(),
      output,
    });
    expect(output.output).toContain("\u001b[?2004h");
    expect(output.output).not.toContain("\u001b[?2004l");
    picker.close();
    expect(output.output).toContain("\u001b[?2004l");
  });

  test("closing erases the picker, restores the cursor, and stops reading keys", () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      message: "Select a project:",
      options: [{ value: "frontend", label: "Frontend" }],
      initialIndex: 0,
      resolve,
    };
    const output = new CaptureStream(80);
    const input = new EventEmitter();
    const picker = mountSelectPrompt(prompt, { input, output });
    picker.close();

    expect(
      output.output.endsWith(`${FRAME_START}\u001b[?2004l\u001b[?25h`),
    ).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("resize")).toBe(0);
  });
});

describe("createKeyParser", () => {
  test("drops escape sequences the picker doesn't use", () => {
    const parser = createKeyParser();
    // Right arrow, F5, and Alt+x around typed text.
    expect(parser.push("a\u001b[C\u001b[15~\u001bxb")).toEqual([
      { name: "text", text: "ab" },
    ]);
    expect(parser.hasPendingEscape()).toBe(false);
  });

  test("keeps a trailing bare Esc pending until flushed", () => {
    const parser = createKeyParser();
    expect(parser.push("\u001b")).toEqual([]);
    expect(parser.hasPendingEscape()).toBe(true);
    expect(parser.flush()).toEqual([{ name: "escape" }]);
    expect(parser.flush()).toEqual([]);
  });

  test.each([
    { split: "Esc", first: "\u001b", rest: "[B" },
    { split: "Esc [", first: "\u001b[", rest: "B" },
    { split: "Esc O", first: "\u001bO", rest: "B" },
    { split: "Esc [ 3", first: "\u001b[3", rest: "~" },
  ])("holds an escape sequence split after $split", ({ first, rest }) => {
    const parser = createKeyParser();
    expect(parser.push(`front${first}`)).toEqual([
      { name: "text", text: "front" },
    ]);
    expect(parser.hasPendingEscape()).toBe(true);
    expect(parser.push(rest)).not.toContainEqual(
      expect.objectContaining({ name: "text" }),
    );
    expect(parser.hasPendingEscape()).toBe(false);
  });

  test("drops an unfinished escape sequence when flushed", () => {
    const parser = createKeyParser();
    expect(parser.push("\u001b[")).toEqual([]);
    expect(parser.flush()).toEqual([]);
    expect(parser.push("a")).toEqual([{ name: "text", text: "a" }]);
  });

  test("holds paste markers split across chunks", () => {
    const parser = createKeyParser();
    expect(parser.push("\u001b[20")).toEqual([]);
    expect(parser.push("0~front\u001b[2")).toEqual([
      { name: "text", text: "front" },
    ]);
    // A held part of the end marker waits for the paste to finish.
    expect(parser.hasPendingEscape()).toBe(false);
    expect(parser.push("01~\r")).toEqual([{ name: "enter" }]);
  });

  test("keeps a bracketed paste open across chunks", () => {
    const parser = createKeyParser();
    expect(parser.push("\u001b[200~fro")).toEqual([
      { name: "text", text: "fro" },
    ]);
    expect(parser.push("nt\r\u001b[201~\r")).toEqual([
      { name: "text", text: "nt" },
      { name: "enter" },
    ]);
  });
});
