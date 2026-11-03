/**
 * Rendering and keyboard tests for the Ink select picker (`SelectPicker`).
 *
 * Each test mounts the picker on a captured stream, feeds it keystrokes, and
 * checks the settled frame and the value the prompt resolved with.
 */

import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { SelectPicker } from "../../../src/lib/select-ui/ink-app.js";
import type { SelectPrompt } from "../../../src/lib/select-ui/types.js";

const CURSOR_TO_LINE_START = "\u001B[G";
// oxlint-disable-next-line no-control-regex -- matching ANSI escape sequences in captured Ink output
const ANSI_CSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex -- matching ANSI escape sequences in captured Ink output
const ANSI_OSC_RE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const LINE_SPLIT_RE = /\r?\n/;
const DOWN_ARROW = "\u001B[B";
const FRAME_SETTLE_MS = 80;

class CaptureStream extends Writable {
  frames: string[] = [];
  settledOutput = "";
  columns: number;
  rows: number;
  isTTY = true;
  constructor(columns = 120, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.frames.push(chunk.toString());
    cb();
  }
  allOutput(): string {
    return this.frames.join("");
  }
  latestFrame(): string {
    const output = this.settledOutput || this.allOutput();
    const redrawStart = output.lastIndexOf(CURSOR_TO_LINE_START);
    return redrawStart === -1
      ? output
      : output.slice(redrawStart + CURSOR_TO_LINE_START.length);
  }
}

function makeStdin(): Readable {
  const s = new Readable({
    read() {
      // Tests push keystrokes explicitly.
    },
  });
  const shim = s as Readable & {
    isTTY: boolean;
    setRawMode: (v: boolean) => Readable;
    resume: () => Readable;
    pause: () => Readable;
    ref: () => Readable;
    unref: () => Readable;
  };
  shim.isTTY = true;
  shim.setRawMode = () => s;
  shim.resume = () => s;
  shim.pause = () => s;
  shim.ref = () => s;
  shim.unref = () => s;
  return s;
}

/** Mount the picker, type `input`, and return the captured output. */
async function renderPicker(
  prompt: SelectPrompt,
  columns: number,
  options: { rows?: number; input?: string[] } = {},
): Promise<CaptureStream> {
  const out = new CaptureStream(columns, options.rows ?? 40);
  const stdin = makeStdin();
  const instance = render(createElement(SelectPicker, { prompt }), {
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: out as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  for (const input of options.input ?? []) {
    stdin.push(input);
    // Ink buffers bare Esc for 20ms to distinguish it from escape sequences.
    await sleep(input === "\u001b" ? FRAME_SETTLE_MS : 20);
  }
  await sleep(FRAME_SETTLE_MS);
  out.settledOutput = out.allOutput();
  instance.unmount();
  // waitUntilExit() hangs in CI — race with a short unref'd timeout.
  await Promise.race([
    instance.waitUntilExit().catch(() => {
      // Ink may reject on unmount — ignore.
    }),
    new Promise<void>((r) => {
      const t = setTimeout(r, 500);
      if (typeof t === "object" && "unref" in t) {
        t.unref();
      }
    }),
  ]);
  return out;
}

function stripFinalLineBreak(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function stripAnsi(output: string): string {
  return output.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "");
}

function ignorePromptResolution(): void {
  // Some tests render the prompt but never submit it.
}

describe("SelectPicker", () => {
  test("typing filters entity names and slugs and confirms the visible choice", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose an organization",
      filterable: true,
      options: [
        { value: "backend", label: "Backend" },
        { value: "front-admin", label: "Administration", hint: "front-admin" },
        { value: "web", label: "Frontend" },
      ],
      initialIndex: 0,
      resolve,
    };

    const output = await renderPicker(prompt, 120, {
      input: ["FRONT", DOWN_ARROW, "\r"],
    });
    const frame = stripAnsi(output.latestFrame());
    expect(frame).toContain("/FRONT");
    expect(frame).toContain("2 of 3");
    expect(frame).toContain("Administration");
    expect(frame).not.toContain("Backend");
    expect(resolve).toHaveBeenCalledWith("web");
  });

  test("typing a typo filters and confirms the matching entity", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose a project",
      filterable: true,
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend", label: "Frontend" },
      ],
      initialIndex: 0,
      resolve,
    };

    const output = await renderPicker(prompt, 80, {
      input: ["\u001b[200~fronend\u001b[201~\r"],
    });
    const frame = stripAnsi(output.latestFrame());
    expect(frame).toContain("/fronend 1 of 2");
    expect(frame).toContain("Frontend");
    expect(frame).not.toContain("Backend");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend");
  });

  test("zero matches cannot be confirmed and Backspace restores matches", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose a team",
      filterable: true,
      options: [{ value: "frontend", label: "Web team", hint: "Frontend" }],
      initialIndex: 0,
      resolve,
    };

    const output = new CaptureStream(120);
    const stdin = makeStdin();
    const instance = render(createElement(SelectPicker, { prompt }), {
      // CI defaults to non-interactive output, which skips intermediate frames.
      interactive: true,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    try {
      stdin.push("frozz");
      // Observe the empty state before later input can coalesce its render.
      await vi.waitFor(() => {
        expect(stripAnsi(output.latestFrame())).toContain("No matches");
      });

      stdin.push(`${DOWN_ARROW}\r`);
      await instance.waitUntilRenderFlush();
      expect(resolve).not.toHaveBeenCalled();

      stdin.push("\u007f\r");
      await vi.waitFor(() => {
        expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend");
        expect(stripAnsi(output.latestFrame())).toContain("/froz 1 of 1");
      });
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  test.each([
    {
      action: "confirms the first filtered option",
      navigation: "",
      expected: "frontend-a",
    },
    {
      action: "wraps up to the last filtered option",
      navigation: "\u001b[A",
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
      kind: "select",
      message: "Choose a project",
      filterable: true,
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend-a", label: "Frontend A" },
        { value: "frontend-b", label: "Frontend B" },
      ],
      initialIndex: 0,
      resolve,
    };

    const output = await renderPicker(prompt, 80, {
      input: [`\u001b[200~front\u001b[201~${navigation}\r`],
    });
    expect(stripAnsi(output.latestFrame())).toContain("/front 2 of 3");
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expected);
  });

  test("same-chunk paste and Enter cannot confirm a filter with no matches", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose an organization",
      filterable: true,
      options: [{ value: "backend", label: "Backend" }],
      initialIndex: 0,
      resolve,
    };

    const output = await renderPicker(prompt, 80, {
      input: ["\u001b[200~missing\u001b[201~\r"],
    });
    expect(stripAnsi(output.latestFrame())).toContain("No matches");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("same-chunk Backspace and Enter confirm a restored filter match", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose a team",
      filterable: true,
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend", label: "Frontend" },
      ],
      initialIndex: 0,
      resolve,
    };

    const output = await renderPicker(prompt, 80, {
      input: ["\u001b[200~frozz\u001b[201~\u007f\r"],
    });
    expect(stripAnsi(output.latestFrame())).toContain("/froz 1 of 2");
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
        kind: "select",
        message: "Choose a project",
        filterable: true,
        options: [
          { value: "backend", label: "Backend" },
          { value: "frontend", label: "Frontend" },
          { value: "worker", label: "Worker" },
        ],
        initialIndex: 1,
        resolve,
      };

      const output = await renderPicker(prompt, 80, {
        input: [`${DOWN_ARROW}${input}\r`],
      });
      expect(stripAnsi(output.latestFrame())).toContain("type to filter");
      expect(resolve).toHaveBeenCalledExactlyOnceWith("worker");
    },
  );

  test("Esc clears the filter before cancelling, while Ctrl+C cancels directly", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose a team",
      filterable: true,
      options: [{ value: "frontend", label: "Frontend" }],
      initialIndex: 0,
      resolve,
    };
    const cleared = await renderPicker(prompt, 120, {
      input: ["front", "\u001b"],
    });
    expect(stripAnsi(cleared.latestFrame())).toContain("type to filter");
    expect(resolve).not.toHaveBeenCalled();

    await renderPicker(prompt, 120, { input: ["front", "\u001b", "\u001b"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
    resolve.mockClear();
    await renderPicker(prompt, 120, { input: ["front", "\u0003"] });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(null);
  });

  test("the compact project picker filters with the same keyboard controls", async () => {
    const resolve = vi.fn();
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Select a project:",
      filterable: true,
      options: [
        { value: "backend", label: "Backend" },
        { value: "frontend-web", label: "Web", hint: "frontend-web" },
      ],
      initialIndex: 0,
      resolve,
    };
    const output = await renderPicker(prompt, 80, {
      input: ["front", "\r"],
    });
    expect(stripAnsi(output.latestFrame())).toContain("/front");
    expect(stripAnsi(output.latestFrame())).toContain("1 of 2");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("frontend-web");
  });

  test("filterable lists keep the query inside a narrow terminal", async () => {
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose a team",
      filterable: true,
      options: Array.from({ length: 20 }, (_, index) => ({
        value: `team-${index}`,
        label: `${index < 11 ? "Frontend" : "Backend"} ${index}`,
      })),
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };
    const output = await renderPicker(prompt, 40, {
      rows: 24,
      input: ["frontend", DOWN_ARROW],
    });
    const frame = stripFinalLineBreak(stripAnsi(output.latestFrame()));
    expect(frame).toContain("/frontend");
    expect(frame).toContain("11 of 20");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(24);
    expect(frame.split(LINE_SPLIT_RE).every((line) => line.length <= 40)).toBe(
      true,
    );
  });

  test.each([{ optionCount: 1 }, { optionCount: 3 }, { optionCount: 20 }])(
    "keeps the filter row fixed with $optionCount options",
    async ({ optionCount }) => {
      const prompt: SelectPrompt = {
        kind: "select",
        message: "Which team should own this project?",
        filterable: true,
        options: Array.from({ length: optionCount }, (_, index) => ({
          value: index === 0 ? "frontend" : `team-${index}`,
          label: index === 0 ? "Frontend" : `Team ${index}`,
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
        const output = await renderPicker(prompt, 40, {
          rows: 24,
          input,
        });
        const frame = stripFinalLineBreak(stripAnsi(output.latestFrame()));
        const lines = frame.split(LINE_SPLIT_RE);
        const filterRow = lines.findIndex((line) => line.includes(status));
        expect(filterRow).toBeGreaterThanOrEqual(0);
        if (initialFilterRow === -1) {
          initialFilterRow = filterRow;
        }
        expect(filterRow).toBe(initialFilterRow);
        expect(lines.length).toBeLessThanOrEqual(24);
      }
    },
  );

  test("long select prompts only render options that fit the terminal", async () => {
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Which team should own this project?",
      options: Array.from({ length: 20 }, (_value, index) => ({
        value: `team-${index + 1}`,
        label: `Team ${index + 1}`,
      })),
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };

    const rendered = await renderPicker(prompt, 120, { rows: 24 });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    expect(frame).toContain("Which team should own this project?");
    expect(frame).toContain("(1/20)");
    expect(frame).toContain("Team 1");
    expect(frame).not.toContain("Team 20");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(24);

    const scrolledFrame = stripAnsi(
      (
        await renderPicker(prompt, 120, {
          input: Array.from({ length: 7 }, () => DOWN_ARROW),
          rows: 24,
        })
      ).allOutput(),
    );
    expect(scrolledFrame).toContain("(8/20)");
    expect(scrolledFrame).toContain("Team 8");
  });

  test("long option hints stay on one terminal row", async () => {
    const prompt: SelectPrompt = {
      kind: "select",
      message: "Choose a team",
      options: [
        {
          value: "team-1",
          label: "A",
          hint: "This deliberately long team name would wrap onto another row UNIQUE_TAIL",
        },
        { value: "team-2", label: "Team 2" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    };

    const frame = stripAnsi(
      (await renderPicker(prompt, 40, { rows: 24 })).allOutput(),
    );
    expect(frame).toContain("▶  A This deliberately");
    expect(frame).not.toContain("UNIQUE_TAIL");
  });
});
