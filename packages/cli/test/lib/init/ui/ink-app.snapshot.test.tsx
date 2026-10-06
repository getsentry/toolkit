/**
 * Smoke-test the Ink App by mounting it with mocked stdin/stdout
 * inside `bun test`. Verifies the full-screen layout (tabbed
 * content and keyboard hints) without needing a real TTY.
 *
 * Note: The first Ink render() in a bun test CI worker can hang
 * indefinitely (Ink's internal reconciler keeps the event loop
 * alive in non-TTY). Tests that call renderApp() rely on a 500ms
 * timeout race to prevent blocking.
 */

import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import chalk from "chalk";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test, vi } from "vitest";
import {
  bannerLinesWidth,
  FULL_BANNER_LINES,
} from "../../../../src/lib/banner.js";
import {
  App,
  formatFeedbackBanner,
} from "../../../../src/lib/init/ui/ink-app.js";
import { WizardStore } from "../../../../src/lib/init/ui/wizard-store.js";

const LEARN_HEADER_RE = /How Sentry Works/;
const TASKS_HEADER_RE = /Tasks\b/;
const STATUS_TAB_RE = /Status/;
const FILES_TAB_RE = /Files/;
const FILES_HEADER_PINNED_RE = /Files analyzed\s+\d+\/\d+/;
const FILES_HEADER_UNPINNED_RE = /Files analyzed\s+\u2191\s+\d+\/\d+/;
const KEYBOARD_HINT_RE = /switch tab/;
const SPACE_TOGGLE_HINT_RE = /space\s+toggle/;
const A_ALL_HINT_RE = /a\s+all/;
const ENTER_CONTINUE_HINT_RE = /enter\s+continue/;
const ESC_CANCEL_HINT_RE = /esc\s+cancel/;
const COMPLETED_SELECTING_FEATURES_RE = /✔\s+Selecting features/;
const ANSI_ESCAPE_PREFIX = "\u001B[";
const CURSOR_TO_LINE_START = "\u001B[G";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences in captured Ink output
const ANSI_CSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences in captured Ink output
const ANSI_OSC_RE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const LINE_SPLIT_RE = /\r?\n/;
const DOWN_ARROW = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const PAGE_UP = "\u001B[5~";
const RIGHT_ARROW = "\u001B[C";
const FEEDBACK_BANNER_TEXT = '$ sentry cli feedback "what worked or broke"';

const FRAME_SETTLE_MS = 80;
const TEST_BANNER_ROWS = [
  { content: "  ███████╗███████╗███╗   ██╗", color: "#B4A4DE" },
  { content: "  ╚══════╝╚══════╝╚═╝  ╚═══╝", color: "#432B8A" },
];

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
      // No keystrokes in tests — Ink reads from this stream but
      // we never push data.
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

async function renderApp(
  store: WizardStore,
  columns: number,
  options: { rows?: number; input?: string[] } = {}
): Promise<CaptureStream> {
  const out = new CaptureStream(columns, options.rows ?? 40);
  const stdin = makeStdin();
  const instance = render(createElement(App, { store }), {
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: out as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  for (const input of options.input ?? []) {
    stdin.push(input);
    await sleep(20);
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

async function renderActiveTaskFrameAfter(elapsedMs: number): Promise<string> {
  const out = new CaptureStream(120, 40);
  const stdin = makeStdin();
  const store = new WizardStore();
  store.setStepStatus("detect-platform", "in_progress");
  const instance = render(createElement(App, { store }), {
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: out as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await vi.advanceTimersByTimeAsync(elapsedMs);
  } finally {
    instance.unmount();
  }
  return stripAnsi(out.allOutput());
}

function hasForcedWhiteForeground(output: string): boolean {
  return (
    output.includes(`${ANSI_ESCAPE_PREFIX}37m`) ||
    output.includes(`${ANSI_ESCAPE_PREFIX}97m`) ||
    output.includes(`${ANSI_ESCAPE_PREFIX}38;2;255;255;255m`)
  );
}

function withoutFeedbackBanner(output: string): string {
  return output
    .split(LINE_SPLIT_RE)
    .filter((line) => !line.includes(FEEDBACK_BANNER_TEXT))
    .join("\n");
}

function stripFinalLineBreak(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function stripAnsi(output: string): string {
  return output.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "");
}

function firstLogoLineIndex(output: string): number {
  return stripAnsi(output)
    .split(LINE_SPLIT_RE)
    .findIndex((line) => line.includes("███████╗███████╗"));
}

function ignorePromptResolution(): void {
  // Snapshot tests render the prompt but never submit it.
}

function setWelcomePrompt(store: WizardStore): void {
  store.setPrompt({
    kind: "welcome",
    options: {
      title: "Sentry Init",
      body: [
        "We'll use AI to inspect this project and configure Sentry.",
        "You'll choose the setup before local files change.",
      ],
      punchline: "Continue to let Sentry use AI for setup.",
    },
    resolve: ignorePromptResolution,
  });
}

function makeReadFiles(count: number): string[] {
  return Array.from(
    { length: count },
    (_value, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`
  );
}

describe("Ink App snapshot", () => {
  test("feedback banner reserves padding on both edges", () => {
    const banner = formatFeedbackBanner(120, "0.32.0-test.0");

    expect(banner.length).toBe(120);
    expect(banner.startsWith(" Sentry v0.32.0-test.0")).toBe(true);
    expect(banner).toContain(FEEDBACK_BANNER_TEXT);
    expect(banner.endsWith(" ")).toBe(true);
  });

  test("renders full-screen layout at 120 cols", async () => {
    const store = new WizardStore();
    store.appendLog("info", "Hello world");
    store.appendLog("success", "Working\u2026");

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toMatch(LEARN_HEADER_RE);
    expect(frame).toContain("App → SDK → Sentry → Issue");
    expect(frame).toContain("The SDK runs in your app.");
    expect(frame).toContain("become issues with the clues");
    expect(frame).toContain("1/7");
    expect(frame).toMatch(TASKS_HEADER_RE);
    expect(frame).toContain("Hello world");
    expect(frame).toContain("Working\u2026");
    expect(frame).toMatch(STATUS_TAB_RE);
    expect(frame).toMatch(FILES_TAB_RE);
    expect(frame).toMatch(KEYBOARD_HINT_RE);
  });

  test("renders the second learn card about debugging context", async () => {
    const store = new WizardStore({
      learnState: { blockIndex: 1, lineIndex: 0, complete: false },
    });
    store.appendLog("info", "Reading project context");

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toContain("Debug With Context");
    expect(frame).toContain("Issue → Trace → Replay → Fix");
    expect(frame).toContain("That context points to the fix.");
    expect(frame).toContain("2/7");
  });

  test("keeps tasks above rotating tips", async () => {
    const store = new WizardStore({
      learnState: { blockIndex: 0, lineIndex: 0, complete: true },
    });

    const frame = stripAnsi((await renderApp(store, 120)).allOutput());
    expect(frame).toContain("Did you know?");
    expect(frame.indexOf("Tasks")).toBeLessThan(frame.indexOf("Did you know?"));
  });

  test("pulses the active task arrow without changing its width", async () => {
    vi.useFakeTimers();
    try {
      const initialFrame = await renderActiveTaskFrameAfter(1);
      expect(initialFrame).toContain("▶  Checking Sentry support");

      const pulsedFrame = await renderActiveTaskFrameAfter(601);
      expect(pulsedFrame).toContain("▷  Checking Sentry support");
    } finally {
      vi.useRealTimers();
    }
  });

  test("renders single-column layout at narrow width", async () => {
    const store = new WizardStore();
    store.appendLog("info", "Narrow terminal");

    const frame = (await renderApp(store, 60)).allOutput();
    expect(frame).toContain("Narrow terminal");
    expect(frame).toMatch(STATUS_TAB_RE);
  });

  test("workflow screen does not repeat status messages in the footer", async () => {
    const store = new WizardStore();
    store.appendStatus("Analyzing project...");
    store.appendStatus("Reading package.json");

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).not.toContain("Analyzing project...");
    expect(frame).not.toContain("Reading package.json");
  });

  test("status history shortcut is not shown", async () => {
    const store = new WizardStore();
    store.appendStatus("Analyzing project...");
    store.appendStatus("Reading package.json");
    store.appendStatus("Installing SDK");

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).not.toContain("toggle status");
  });

  test("focused prompt text inherits terminal foreground", async () => {
    const store = new WizardStore({ bannerRows: [], layout: "intro" });
    store.setPrompt({
      kind: "select",
      message: "Choose a feature",
      options: [
        { value: "errors", label: "Error Monitoring" },
        { value: "tracing", label: "Tracing" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toContain("Choose a feature");
    expect(frame).toContain("Error Monitoring");
    expect(hasForcedWhiteForeground(withoutFeedbackBanner(frame))).toBe(false);
  });

  test("centered select options share aligned label and hint columns", async () => {
    const options = [
      { value: "short", label: "Short", hint: "short-slug" },
      { value: "empower", label: "Empower Plant", hint: "demo" },
      { value: "sdks", label: "Sentry SDKs", hint: "sentry-sdks" },
    ];
    const store = new WizardStore({ bannerRows: [], layout: "intro" });
    store.setPrompt({
      kind: "select",
      message: "Choose a project",
      options,
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const frame = stripAnsi((await renderApp(store, 80)).allOutput());
    const lines = frame.split(LINE_SPLIT_RE);
    const renderedOptions = options.map(({ label, hint }) => {
      const line = lines.find((candidate) => candidate.includes(label));
      if (!line) {
        throw new Error(`Missing rendered option: ${label}`);
      }
      const hintColumn = line.indexOf(hint);
      if (hintColumn < 0) {
        throw new Error(`Missing rendered hint: ${hint}`);
      }
      return {
        hintColumn,
        labelColumn: line.indexOf(label),
      };
    });

    expect(renderedOptions.map(({ labelColumn }) => labelColumn)).toEqual([
      renderedOptions[0]?.labelColumn,
      renderedOptions[0]?.labelColumn,
      renderedOptions[0]?.labelColumn,
    ]);
    expect(renderedOptions.map(({ hintColumn }) => hintColumn)).toEqual([
      renderedOptions[0]?.hintColumn,
      renderedOptions[0]?.hintColumn,
      renderedOptions[0]?.hintColumn,
    ]);
  });

  test("workflow screen hides logo and shows feedback banner", async () => {
    const store = new WizardStore({
      bannerRows: TEST_BANNER_ROWS,
      cliVersion: "0.32.0-test.0",
    });
    store.appendLog("info", "Checking project...");

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).not.toContain("███████╗███████╗");
    expect(frame).toContain(FEEDBACK_BANNER_TEXT);
    expect(frame).toContain("Sentry v0.32.0-test.0");

    const plainFrame = stripAnsi(frame);
    const bannerLine = plainFrame
      .split(LINE_SPLIT_RE)
      .find((line) => line.includes("Sentry v") && line.includes("feedback"));
    expect(bannerLine).toBeDefined();
    expect(bannerLine?.indexOf("Sentry v0.32.0-test.0")).toBeLessThan(
      bannerLine?.indexOf("$ sentry cli feedback") ?? 0
    );
  });

  test("welcome screen is centered and standalone", async () => {
    const store = new WizardStore({ bannerRows: TEST_BANNER_ROWS });
    setWelcomePrompt(store);

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toContain("███████╗███████╗");
    expect(frame).not.toContain("Sentry Init");
    expect(frame).toContain("We'll use AI to inspect this project");
    expect(frame).toContain("Continue to let Sentry use AI for setup.");
    expect(frame).toContain("Continue");
    expect(frame).toContain("Cancel");
    expect(frame).not.toMatch(LEARN_HEADER_RE);
    expect(frame).not.toMatch(TASKS_HEADER_RE);
    expect(frame).not.toMatch(STATUS_TAB_RE);
    expect(frame).not.toMatch(FILES_TAB_RE);
    expect(frame).toContain(FEEDBACK_BANNER_TEXT);
    expect(hasForcedWhiteForeground(withoutFeedbackBanner(frame))).toBe(false);
  });

  test("welcome banner preserves row alignment while centering the art", async () => {
    const store = new WizardStore({ bannerRows: FULL_BANNER_LINES });
    setWelcomePrompt(store);

    const terminalColumns = 120;
    const frame = stripAnsi(
      (await renderApp(store, terminalColumns)).allOutput()
    );
    const lines = frame.split(LINE_SPLIT_RE);
    const bannerOrigin = Math.floor(
      (terminalColumns - bannerLinesWidth(FULL_BANNER_LINES)) / 2
    );

    for (const { content } of FULL_BANNER_LINES) {
      const visibleContent = content.trimStart();
      const leadingSpaces = content.length - visibleContent.length;
      const renderedRow = lines.find((line) => line.includes(visibleContent));

      expect(renderedRow).toBeDefined();
      expect(renderedRow?.indexOf(visibleContent)).toBe(
        bannerOrigin + leadingSpaces
      );
    }
  });

  test("intro banner shrinks to fit narrow terminals (never wraps)", async () => {
    // A banner wider than the narrow terminal; distinctive marker so we can tell
    // whether it was rendered verbatim or replaced by a fitting variant.
    const wideRow = "Z".repeat(78);
    const makeStore = () =>
      new WizardStore({
        bannerRows: [{ content: wideRow, color: "#B4A4DE" }],
        layout: "intro",
      });

    // Wide terminal: the provided rows fit, so they render as-is.
    const wide = (await renderApp(makeStore(), 120)).allOutput();
    expect(wide).toContain("Z".repeat(40));

    // Narrow terminal (e.g. split pane): the too-wide rows are replaced by the
    // widest fitting variant (the block wordmark), so nothing wraps.
    const narrow = (await renderApp(makeStore(), 60)).allOutput();
    expect(narrow).not.toContain("Z".repeat(20));
    expect(narrow).toContain("████");
  });

  test("intro preflight prompts stay centered and standalone", async () => {
    const store = new WizardStore({
      bannerRows: TEST_BANNER_ROWS,
      layout: "intro",
    });
    store.appendLog("warn", "You have uncommitted or untracked files.");
    store.appendLog("success", "Prerequisites OK");
    store.setPrompt({
      kind: "confirm",
      message: "Continue with uncommitted changes?",
      initialValue: true,
      resolve: ignorePromptResolution,
    });

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toContain("███████╗███████╗");
    expect(frame).not.toContain("Sentry Init");
    expect(frame).not.toContain("uncommitted or untracked files");
    expect(frame).not.toContain("Prerequisites OK");
    expect(frame).toContain("Continue with uncommitted changes?");
    expect(frame).not.toContain("We'll use AI to inspect this project");
    expect(frame).not.toContain("Continue to let Sentry use AI for setup.");
    expect(frame).not.toContain("◇ Continue with uncommitted changes?");
    expect(frame).not.toMatch(LEARN_HEADER_RE);
    expect(frame).not.toMatch(TASKS_HEADER_RE);
    expect(frame).not.toMatch(STATUS_TAB_RE);
    expect(frame).not.toMatch(FILES_TAB_RE);
    expect(frame).not.toContain("switch tab");
    expect(frame).toContain(FEEDBACK_BANNER_TEXT);
    expect(hasForcedWhiteForeground(withoutFeedbackBanner(frame))).toBe(false);
  });

  test("intro logo row stays fixed across prompt heights", async () => {
    const shortPrompt = new WizardStore({
      bannerRows: TEST_BANNER_ROWS,
      layout: "intro",
    });
    shortPrompt.setPrompt({
      kind: "confirm",
      message: "Continue with setup?",
      initialValue: true,
      resolve: ignorePromptResolution,
    });

    const longPrompt = new WizardStore({
      bannerRows: TEST_BANNER_ROWS,
      layout: "intro",
    });
    longPrompt.setPrompt({
      kind: "select",
      message:
        "Choose the Sentry project and team context to use for this initialization before setup continues.",
      options: [
        { value: "recommended", label: "Use the detected project" },
        { value: "existing", label: "Choose an existing project" },
        { value: "create", label: "Create a new project" },
        { value: "team", label: "Change team first" },
        { value: "cancel", label: "Cancel setup" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const shortFrame = (
      await renderApp(shortPrompt, 120, { rows: 24 })
    ).allOutput();
    const longFrame = (
      await renderApp(longPrompt, 120, { rows: 24 })
    ).allOutput();

    const shortLogoLine = firstLogoLineIndex(shortFrame);
    const longLogoLine = firstLogoLineIndex(longFrame);
    expect(shortLogoLine).toBeGreaterThanOrEqual(0);
    expect(longLogoLine).toBe(shortLogoLine);
  });

  test("feature multiselect shows descriptions and the included baseline", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "multiselect",
      message: "Select features to enable",
      details: [
        {
          text: "Based on your project, these features are available to set up.",
        },
      ],
      options: [
        {
          value: "errorMonitoring",
          label: "Error Monitoring",
          description: "Automatically capture exceptions and stack traces",
          locked: true,
        },
        {
          value: "logs",
          label: "Logging",
          description: "See logs in context with errors and performance issues",
        },
        {
          value: "sessionReplay",
          label: "Session Replay",
          description: "Watch real user sessions to see what went wrong",
        },
        {
          value: "performanceMonitoring",
          label: "Tracing",
          description:
            "Find bottlenecks, broken requests, and understand application flow end-to-end",
        },
        {
          value: "sourceMaps",
          label: "Source Maps",
          description:
            "Turn minified production stack traces back into your original source code",
        },
      ],
      initialSelected: [
        "errorMonitoring",
        "logs",
        "sessionReplay",
        "performanceMonitoring",
      ],
      required: false,
      resolve: ignorePromptResolution,
    });

    const previousColorLevel = chalk.level;
    chalk.level = 3;
    let frame: string;
    try {
      frame = (await renderApp(store, 120)).latestFrame();
    } finally {
      chalk.level = previousColorLevel;
    }
    const plainFrame = stripAnsi(frame);
    expect(frame).toContain("Select features to enable");
    expect(frame).toContain("Based on your project, these features are");
    expect(frame).toContain("available to set up.");
    expect(frame).toContain("Error Monitoring");
    expect(frame).toContain(
      "Automatically capture exceptions and stack traces"
    );
    expect(frame).toContain("Session Replay");
    expect(frame).toContain("Watch real user sessions to see what went wrong");
    expect(frame).toContain("Tracing");
    expect(frame).toContain("Find bottlenecks, broken requests");
    expect(frame).toContain("Source Maps");
    expect(plainFrame).toContain("4/5");
    expect(plainFrame).toContain(
      "↑↓ move • space toggle • a all • enter continue"
    );
    expect(plainFrame).toMatch(SPACE_TOGGLE_HINT_RE);
    expect(plainFrame).toMatch(A_ALL_HINT_RE);
    expect(plainFrame).toMatch(ENTER_CONTINUE_HINT_RE);
    expect(plainFrame).toMatch(ESC_CANCEL_HINT_RE);
    expect(plainFrame).not.toContain("required");
    expect(plainFrame).toContain("Error Monitoring (always included)");
    const errorMonitoringRow = frame
      .split(LINE_SPLIT_RE)
      .find((line) => line.includes("Error Monitoring"));
    expect(errorMonitoringRow).toContain(
      `${ANSI_ESCAPE_PREFIX}38;2;131;218;144m◼ `
    );
    expect(frame).not.toContain("Recommended setup");
    expect(frame).not.toContain("Apply recommended setup");
    expect(plainFrame.indexOf("Error Monitoring")).toBeLessThan(
      plainFrame.indexOf("Logging")
    );
    expect(plainFrame.indexOf("Logging")).toBeLessThan(
      plainFrame.indexOf("Session Replay")
    );
    expect(plainFrame.indexOf("Session Replay")).toBeLessThan(
      plainFrame.indexOf("Tracing")
    );
    expect(plainFrame.indexOf("Tracing")).toBeLessThan(
      plainFrame.indexOf("Source Maps")
    );
    const lines = plainFrame.split(LINE_SPLIT_RE);
    const shortcutLine = lines.findIndex((line) =>
      line.includes("↑↓ move • space toggle • a all • enter continue")
    );
    const contextLastLine = lines.findIndex((line) =>
      line.includes("available to set up.")
    );
    const firstFeatureLine = lines.findIndex((line) =>
      line.includes("Error Monitoring")
    );
    const lastFeatureLine = lines.findIndex((line) =>
      line.includes("Source Maps")
    );
    expect(contextLastLine).toBeGreaterThan(0);
    expect(firstFeatureLine - contextLastLine).toBeGreaterThan(1);
    expect(shortcutLine).toBeGreaterThan(0);
    expect(lastFeatureLine).toBeGreaterThan(0);
    expect(shortcutLine - lastFeatureLine).toBeGreaterThan(2);
    expect(plainFrame.indexOf("Tracing")).toBeLessThan(
      plainFrame.indexOf("↑↓ move • space toggle • a all • enter continue")
    );
  });

  test("multiselect hints render and locked options survive toggle all", async () => {
    const resolve = vi.fn();
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "multiselect",
      message: "Select features",
      options: [
        {
          value: "errors",
          label: "Error Monitoring",
          hint: "captured by default",
          locked: true,
        },
        { value: "replay", label: "Session Replay" },
      ],
      initialSelected: ["errors", "replay"],
      required: false,
      resolve,
    });

    const rendered = await renderApp(store, 120, { input: ["a", "\r"] });
    expect(stripAnsi(rendered.allOutput())).toContain("captured by default");
    expect(resolve).toHaveBeenCalledWith(["errors"]);
  });

  test("the multiselect cursor starts on the first unselected option", async () => {
    const resolve = vi.fn();
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "multiselect",
      message: "Select features",
      options: [
        { value: "errors", label: "Error Monitoring", locked: true },
        { value: "logs", label: "Logging" },
        { value: "replay", label: "Session Replay" },
        { value: "profiling", label: "Profiling" },
      ],
      initialSelected: ["errors", "logs", "replay"],
      required: false,
      resolve,
    });

    await renderApp(store, 120, { input: [" ", "\r"] });
    expect(resolve).toHaveBeenCalledWith([
      "errors",
      "logs",
      "replay",
      "profiling",
    ]);
  });

  test("feature descriptions fit short terminals and keep the baseline pinned", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "multiselect",
      message: "Select features to enable",
      details: [
        {
          text: "Based on your project, these features are available to set up.",
        },
      ],
      options: [
        {
          value: "errors",
          label: "Error Monitoring",
          description: "Automatically capture exceptions and stack traces",
          locked: true,
        },
        ...Array.from({ length: 5 }, (_value, index) => ({
          value: `feature-${index + 1}`,
          label: `Feature ${index + 1}`,
          description:
            "A longer explanation that wraps cleanly and still leaves enough room for navigation",
        })),
      ],
      initialSelected: ["errors"],
      required: false,
      resolve: ignorePromptResolution,
    });

    const rendered = await renderApp(store, 60, {
      input: [DOWN_ARROW, DOWN_ARROW, DOWN_ARROW],
      rows: 16,
    });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    expect(frame).toContain("Error Monitoring");
    expect(frame).toContain("Feature 4");
    expect(frame).toContain("↑↓ move • space toggle • a all • enter continue");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(16);
  });

  test("feature selection stays usable at 30 columns", async () => {
    const resolve = vi.fn();
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "multiselect",
      message: "Select features to enable",
      details: [
        {
          text: "Based on your project, these features are available to set up.",
        },
      ],
      options: [
        {
          value: "errors",
          label: "Error Monitoring",
          description: "Automatically capture exceptions and stack traces",
          locked: true,
        },
        {
          value: "logs",
          label: "Logging",
          description: "See logs in context with errors and performance issues",
        },
        {
          value: "replay",
          label: "Session Replay",
          description: "Watch real user sessions to see what went wrong",
        },
        {
          value: "tracing",
          label: "Tracing",
          description:
            "Find bottlenecks, broken requests, and understand application flow end-to-end",
        },
        {
          value: "profiling",
          label: "Profiling",
          description:
            "Pinpoint the functions and lines of code responsible for performance issues",
        },
      ],
      initialSelected: ["errors", "logs", "replay", "tracing"],
      required: false,
      resolve,
    });

    const rendered = await renderApp(store, 30, {
      input: [DOWN_ARROW, DOWN_ARROW, " ", "\r"],
      rows: 16,
    });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    expect(frame).toContain("Error Monitoring");
    expect(frame).toContain("Session Replay");
    expect(frame).toContain("space toggle");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(16);
    expect(resolve).toHaveBeenCalledWith(["errors", "logs", "tracing"]);
  });

  test("feature review shows the selected setup and a way back", async () => {
    const resolve = vi.fn();
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "select",
      message: "Review your Sentry setup",
      details: [
        { text: "We'll add these features:" },
        { text: "✓ Error Monitoring", tone: "success" },
        { text: "✓ Session Replay", tone: "success" },
        { text: "✓ Tracing", tone: "success" },
      ],
      footer: {
        text: "We'll modify project files for this Sentry setup.",
      },
      options: [
        { value: "continue", label: "Continue" },
        { value: "back", label: "Back" },
      ],
      initialIndex: 0,
      resolve,
    });

    const frame = stripAnsi((await renderApp(store, 120)).latestFrame());
    expect(frame).toContain("Review your Sentry setup");
    expect(frame).toContain("We'll add these features:");
    expect(frame).toContain("Error Monitoring");
    expect(frame).toContain("Tracing");
    expect(frame).toContain("Session Replay");
    expect(frame).toContain("Continue");
    expect(frame).toContain("Back");
    expect(frame).not.toContain("Change features");
    expect(frame).toContain(
      "We'll modify project files for this Sentry setup."
    );
    expect(frame.indexOf("✓ Tracing")).toBeLessThan(
      frame.indexOf("We'll modify project files for this Sentry setup.")
    );
    expect(
      frame.indexOf("We'll modify project files for this Sentry setup.")
    ).toBeLessThan(frame.indexOf("Continue"));
    const reviewLines = frame
      .split(LINE_SPLIT_RE)
      .filter((line) => line.includes("✓ "));
    expect(reviewLines).toHaveLength(3);
    expect(
      reviewLines.every((line) => (line.match(/✓/g) ?? []).length === 1)
    ).toBe(true);

    await renderApp(store, 120, { input: [DOWN_ARROW, "\r"] });
    expect(resolve).toHaveBeenCalledWith("back");
  });

  test("feature review keeps the workflow content anchored for the next step", async () => {
    const reviewStore = new WizardStore({ bannerRows: [] });
    reviewStore.setPrompt({
      kind: "select",
      message: "Review your Sentry setup",
      details: [
        { text: "We'll add these features:" },
        { text: "✓ Error Monitoring", tone: "success" },
        { text: "✓ Logging", tone: "success" },
        { text: "✓ Tracing", tone: "success" },
      ],
      footer: {
        text: "We'll modify project files for this Sentry setup.",
      },
      options: [
        { value: "continue", label: "Continue" },
        { value: "back", label: "Back" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });
    const planStore = new WizardStore({ bannerRows: [] });
    planStore.startSpinner("Planning Sentry changes");

    const reviewFrame = stripAnsi(
      (await renderApp(reviewStore, 120)).latestFrame()
    );
    const planFrame = stripAnsi(
      (await renderApp(planStore, 120)).latestFrame()
    );
    const reviewLine = reviewFrame
      .split(LINE_SPLIT_RE)
      .find((line) => line.includes("Review your Sentry setup"));
    const planLine = planFrame
      .split(LINE_SPLIT_RE)
      .find((line) => line.includes("Planning Sentry changes"));

    expect(reviewLine).toBeDefined();
    expect(planLine).toBeDefined();
    expect(reviewLine?.indexOf("Review your Sentry setup")).toBe(
      planLine?.indexOf("Planning Sentry changes")
    );
  });

  test.each([
    120, 60, 30,
  ])("review prompts keep their warning and actions visible at %i columns", async (columns) => {
    const store = new WizardStore({ bannerRows: [] });
    store.appendLog("warn", "Review warning remains visible");
    store.setPrompt({
      kind: "select",
      message: "Review your Sentry setup",
      details: [
        { text: "We'll add these features:" },
        ...[
          "Agent Tracing",
          "Application Metrics",
          "Crons",
          "Error Monitoring",
          "Logging",
          "MCP Observability",
          "Profiling",
          "Session Replay",
          "Source Maps",
          "Tracing",
        ].map((feature) => ({
          text: `✓ ${feature}`,
          tone: "success" as const,
        })),
      ],
      footer: {
        text: "We'll modify project files for this Sentry setup.",
      },
      options: [
        { value: "continue", label: "Continue" },
        { value: "back", label: "Back" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const rendered = await renderApp(store, columns, {
      input: Array.from({ length: 12 }, () => PAGE_DOWN),
      rows: 16,
    });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    const normalizedFrame = frame.replace(/\s+/g, " ");
    expect(frame).toContain("Review your Sentry setup");
    expect(frame).toContain("Review warning remains");
    expect(frame).toContain("10-10/10 · pgup/pgdn");
    expect(frame).toContain("Tracing");
    expect(normalizedFrame).toContain(
      "We'll modify project files for this Sentry setup."
    );
    expect(frame).toContain("Continue");
    expect(frame).toContain("Back");
    expect(frame).not.toContain("Change features");
    expect(frame).toContain("Status");
    expect(frame).toContain("Files");
    expect(frame).toContain("↑↓ navigate");
    expect(frame).toContain("enter confirm");
    expect(frame).toContain("Sentry");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(16);
  });

  test("narrow review paging remains reversible when warnings accumulate", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.appendLog("warn", "An older review warning");
    store.appendLog("error", "The latest review warning remains visible");
    store.setPrompt({
      kind: "select",
      message: "Review your Sentry setup",
      details: [
        { text: "We'll add these features:" },
        ...Array.from({ length: 10 }, (_value, index) => ({
          text: `✓ Feature ${index + 1}`,
          tone: "success" as const,
        })),
      ],
      footer: {
        text: "We'll modify project files for this Sentry setup.",
      },
      options: [
        { value: "continue", label: "Continue" },
        { value: "back", label: "Back" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const firstFrame = stripAnsi(
      (await renderApp(store, 30, { rows: 16 })).latestFrame()
    );
    expect(firstFrame).not.toContain("An older review warning");
    expect(firstFrame).toContain("latest review warning");
    expect(firstFrame).toContain("✓ Feature 1");
    expect(firstFrame).toContain("1-1/10 · pgup/pgdn");

    const nextFrame = stripAnsi(
      (
        await renderApp(store, 30, { input: [PAGE_DOWN], rows: 16 })
      ).latestFrame()
    );
    expect(nextFrame).toContain("✓ Feature 2");
    expect(nextFrame).toContain("2-2/10 · pgup/pgdn");

    const previousFrame = stripAnsi(
      (
        await renderApp(store, 30, {
          input: [PAGE_DOWN, PAGE_UP],
          rows: 16,
        })
      ).latestFrame()
    );
    expect(previousFrame).toContain("✓ Feature 1");
    expect(previousFrame).toContain("1-1/10 · pgup/pgdn");
    expect(previousFrame).toContain("Continue");
    expect(previousFrame).toContain("Back");
    expect(previousFrame).toContain("Status");
    expect(previousFrame).toContain("Files");
  });

  test("workflow prompts hide routine logs but keep warnings and tasks", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.appendLog(
      "success",
      'Using existing project "nextjs-sentry-test" in bete-dev'
    );
    store.appendLog("success", "Selecting features");
    store.appendLog("info", "Routine context loaded");
    store.appendLog("message", "Internal progress detail");
    store.appendLog("warn", "Heads up before choosing features");
    store.appendLog("error", "Something needs attention");
    store.setPrompt({
      kind: "multiselect",
      message: "Select features",
      options: [
        { value: "sessionReplay", label: "Session Replay" },
        { value: "profiling", label: "Profiling" },
      ],
      initialSelected: [],
      required: false,
      resolve: ignorePromptResolution,
    });

    const frame = (await renderApp(store, 120)).allOutput();
    const plainFrame = stripAnsi(frame);
    expect(frame).not.toContain("Using existing project");
    expect(plainFrame).not.toMatch(COMPLETED_SELECTING_FEATURES_RE);
    expect(frame).not.toContain("Routine context loaded");
    expect(frame).not.toContain("Internal progress detail");
    expect(frame).toContain("Heads up before choosing features");
    expect(frame).toContain("Something needs attention");
    expect(frame).toContain("Select features");
    expect(frame).toMatch(TASKS_HEADER_RE);
  });

  test("prompt shortcuts replace app shortcuts while prompt is active", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.setPrompt({
      kind: "select",
      message: "Choose a feature",
      options: [
        { value: "errors", label: "Error Monitoring" },
        { value: "tracing", label: "Tracing" },
      ],
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toContain("navigate");
    expect(frame).toContain("confirm");
    expect(frame).toContain("cancel");
    expect(frame).not.toContain("switch tab");
  });

  test("long select prompts only render options that fit the terminal", async () => {
    const store = new WizardStore({
      bannerRows: FULL_BANNER_LINES,
      layout: "intro",
    });
    store.setPrompt({
      kind: "select",
      message: "Which team should own this project?",
      options: Array.from({ length: 20 }, (_value, index) => ({
        value: `team-${index + 1}`,
        label: `Team ${index + 1}`,
      })),
      initialIndex: 0,
      resolve: ignorePromptResolution,
    });

    const rendered = await renderApp(store, 120, { rows: 24 });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    expect(frame).toContain("Which team should own this project?");
    expect(frame).toContain("(1/20)");
    expect(frame).toContain("Team 4");
    expect(frame).not.toContain("Team 5");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(24);
    expect(frame).toContain(FEEDBACK_BANNER_TEXT);

    const scrolledFrame = stripAnsi(
      (
        await renderApp(store, 120, {
          input: Array.from({ length: 7 }, () => DOWN_ARROW),
          rows: 24,
        })
      ).allOutput()
    );
    expect(scrolledFrame).toContain("(8/20)");
    expect(scrolledFrame).toContain("Team 8");
  });

  test("long multiselect prompts only render options that fit the terminal", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.appendLog(
      "warn",
      "A warning remains visible while choosing features"
    );
    store.appendLog(
      "error",
      "An error remains visible while choosing features"
    );
    store.appendLog("warn", "A second warning also remains visible");
    store.setPrompt({
      kind: "multiselect",
      message: "Select features",
      details: [{ text: "Review the monitoring choices" }],
      options: Array.from({ length: 20 }, (_value, index) => ({
        value: `feature-${index + 1}`,
        label: `Feature ${index + 1}`,
      })),
      initialSelected: [],
      required: false,
      resolve: ignorePromptResolution,
    });

    const rendered = await renderApp(store, 120, { rows: 16 });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    expect(frame).toContain("0/20 selected • 1/20");
    expect(frame).toContain("Review the monitoring choices");
    expect(frame).toContain("A second warning also remains visible");
    expect(frame).toContain("Feature 1");
    expect(frame).not.toContain("Feature 2");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(16);
    expect(frame).toContain(FEEDBACK_BANNER_TEXT);

    const scrolledFrame = stripFinalLineBreak(
      stripAnsi(
        (
          await renderApp(store, 120, {
            input: Array.from({ length: 19 }, () => DOWN_ARROW),
            rows: 16,
          })
        ).latestFrame()
      )
    );
    expect(scrolledFrame).toContain("0/20 selected • 20/20");
    expect(scrolledFrame).toContain("Feature 20");
    expect(scrolledFrame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(16);
    expect(scrolledFrame).toContain(FEEDBACK_BANNER_TEXT);
  });

  test("centered multiselect prompts fit with the full banner", async () => {
    const store = new WizardStore({
      bannerRows: FULL_BANNER_LINES,
      layout: "intro",
    });
    store.setPrompt({
      kind: "multiselect",
      message: "Select features",
      details: [{ text: "Review the monitoring choices" }],
      options: Array.from({ length: 20 }, (_value, index) => ({
        value: `feature-${index + 1}`,
        label: `Feature ${index + 1}`,
      })),
      initialSelected: [],
      required: false,
      resolve: ignorePromptResolution,
    });

    const rendered = await renderApp(store, 120, { rows: 30 });
    const frame = stripFinalLineBreak(stripAnsi(rendered.latestFrame()));
    expect(frame).toContain("Review the monitoring choices");
    expect(frame).toContain("Feature 5");
    expect(frame).not.toContain("Feature 6");
    expect(frame.split(LINE_SPLIT_RE).length).toBeLessThanOrEqual(30);
    expect(frame).toContain(FEEDBACK_BANNER_TEXT);
  });

  test("long option hints stay on one terminal row", async () => {
    const store = new WizardStore({ bannerRows: [], layout: "intro" });
    store.setPrompt({
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
    });

    const frame = stripAnsi(
      (await renderApp(store, 40, { rows: 24 })).allOutput()
    );
    expect(frame).toContain("A");
    expect(frame).not.toContain("UNIQUE_TAIL");
  });

  test("file scroll shortcut appears only when the file tree overflows", async () => {
    const shortTree = new WizardStore({ bannerRows: [] });
    shortTree.recordFilesReading(["src/app.ts"]);
    shortTree.markFilesAnalyzed(["src/app.ts"]);

    const shortFrame = (
      await renderApp(shortTree, 120, {
        input: [RIGHT_ARROW],
        rows: 16,
      })
    ).allOutput();
    expect(shortFrame).toMatch(FILES_HEADER_PINNED_RE);
    expect(shortFrame).not.toContain("scroll");

    const tallTree = new WizardStore({ bannerRows: [] });
    const readFiles = makeReadFiles(12);
    tallTree.recordFilesReading(readFiles);
    tallTree.markFilesAnalyzed(readFiles);

    const tallFrame = (
      await renderApp(tallTree, 120, {
        input: [RIGHT_ARROW],
        rows: 16,
      })
    ).allOutput();
    expect(tallFrame).toMatch(FILES_HEADER_PINNED_RE);
    expect(tallFrame).toContain("scroll");
  });

  test("Status screen shows logs and banner, not file tree", async () => {
    const store = new WizardStore();
    store.appendLog("info", "Checking project...");
    store.recordFilesReading(["package.json", "src/index.ts"]);
    store.markFilesAnalyzed(["package.json"]);

    const frame = (await renderApp(store, 120)).allOutput();
    expect(frame).toContain("Checking project...");
    expect(frame).not.toMatch(FILES_HEADER_PINNED_RE);
    expect(frame).not.toMatch(FILES_HEADER_UNPINNED_RE);
  });

  test("SummaryPanel renders featureBlurbs as Here's what we set up section", async () => {
    const store = new WizardStore({ bannerRows: [] });
    store.setSummary({
      fields: [{ label: "Platform", value: "javascript.nextjs" }],
      featureBlurbs: [
        {
          label: "Error Monitoring",
          blurb: "Captures every unhandled exception.",
        },
        { label: "Tracing", blurb: "Traces requests end-to-end." },
      ],
    });

    const frame = stripAnsi((await renderApp(store, 120)).allOutput());
    expect(frame).toContain("Here's what we set up");
    expect(frame).toContain("Error Monitoring");
    expect(frame).toContain("Captures every unhandled exception.");
    expect(frame).toContain("Tracing");
    expect(frame).toContain("Traces requests end-to-end.");
  });

  test("Ctrl+C path uses requestCancel via store, never bare process.exit", () => {
    let cancels = 0;
    const store = new WizardStore();
    store.setRequestCancel(() => {
      cancels += 1;
    });
    expect(store.getSnapshot().requestCancel).toBeDefined();
    store.getSnapshot().requestCancel?.();
    expect(cancels).toBe(1);
    store.setRequestCancel(undefined);
    expect(store.getSnapshot().requestCancel).toBeUndefined();
  });
});

describe("completion screen", () => {
  function completionStore(verified: boolean): WizardStore {
    const completion = {
      projectName: "my-app",
      features: ["Errors", "Tracing"],
      featureBlurbs: [
        { label: "Error Monitoring", blurb: "Captures unhandled exceptions." },
        { label: "Tracing", blurb: "Measures request performance." },
      ],
      changedFileCount: 4,
      issuesUrl: "https://acme.sentry.io/issues/?project=4507",
      verification: verified
        ? {
            received: true,
            eventUrl: "https://acme.sentry.io/issues/?query=event.id:abc123",
          }
        : { received: false },
      agentInstallCommand: "npx @sentry/ai install",
      startCommand: "pnpm dev",
    };
    return new WizardStore({
      layout: "workflow",
      cliVersion: "9.9.9",
      summary: { fields: [], completion },
      outroState: {
        kind: "success",
        dismiss: () => {
          // no-op in tests
        },
        actions: {
          openUrl: () => {
            // no-op in tests
          },
          track: () => {
            // no-op in tests
          },
        },
      },
    });
  }

  test("guides the user to their first error when unverified", async () => {
    const text = stripAnsi(
      (await renderApp(completionStore(false), 100)).allOutput()
    );
    // Header flows into the per-feature project info via ", with:".
    expect(text).toContain("Sentry is set up in my-app");
    expect(text).toContain(", with:");
    expect(text).toContain("Error Monitoring");
    expect(text).toContain("Captures unhandled exceptions.");
    // Just the file count — no platform key in this footnote.
    expect(text).toContain("4 files changed");
    expect(text).toContain("See your first error");
    expect(text).toContain("pnpm dev");
    expect(text).toContain("/issues/?project=4507");
    // The link carries an inline "(o) to open" shortcut hint.
    expect(text).toContain("(o) to open");
    expect(text).toContain("Open my Issues feed");
    expect(text).toContain("Install the Sentry agent plugin");
    // The raw MCP-config option was dropped — the plugin covers it.
    expect(text).not.toContain("Set up the Sentry MCP");
    expect(text).toContain("Finish");
    // "Open the setup docs" was removed from the next steps.
    expect(text).not.toContain("Open the setup docs");
  });

  test("celebrates and deep-links the first event when verified", async () => {
    const text = stripAnsi(
      (await renderApp(completionStore(true), 100)).allOutput()
    );
    expect(text).toContain("Sentry is set up in my-app");
    expect(text).toContain("First event received");
    expect(text).toContain("View my first event");
    expect(text).toContain("event.id:abc123");
  });

  test("pressing o opens the first-error link", async () => {
    const text = stripAnsi(
      (
        await renderApp(completionStore(false), 100, { input: ["o"] })
      ).allOutput()
    );
    // The `o` handler fires and confirms via a note.
    expect(text).toContain("Opened Sentry in your browser.");
  });
});
