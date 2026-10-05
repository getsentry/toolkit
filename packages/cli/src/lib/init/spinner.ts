import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import stringWidth from "string-width";
import {
  colorTag,
  renderInlineMarkdown,
  stripColorTags,
} from "../formatters/markdown.js";

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const SPINNER_FRAMES = process.platform.startsWith("win")
  ? ["●", "o", "O", "0"]
  : ["◒", "◐", "◓", "◑"];
const SPINNER_INTERVAL_MS = process.platform.startsWith("win") ? 80 : 120;

export type WizardSpinner = {
  start: (msg?: string) => void;
  stop: (msg?: string, code?: number) => void;
  message: (msg?: string) => void;
};

type SpinnerOutput = NodeJS.WriteStream & {
  columns?: number;
};

/**
 * Create the init wizard spinner with support for repainting multiline status
 * blocks. Clack's public spinner API works well for one-line updates, but the
 * file tree view needs to redraw an entire block in place as progress changes.
 */
export function createWizardSpinner(
  output: SpinnerOutput = process.stdout
): WizardSpinner {
  let running = false;
  let frameIndex = 0;
  let renderedRows = 0;
  let message = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  function stripForWidth(value: string): string {
    return stripColorTags(value).replace(/`/g, "");
  }

  function countRenderedRows(markdown: string): number {
    const width = Math.max(1, output.columns || 80);
    return markdown.split("\n").reduce((rows, line) => {
      const visibleWidth = stringWidth(stripForWidth(line));
      return rows + Math.max(1, Math.ceil(visibleWidth / width));
    }, 0);
  }

  function clearRenderedBlock(): void {
    if (!output.isTTY || renderedRows === 0) {
      renderedRows = 0;
      return;
    }
    cursorTo(output, 0);
    if (renderedRows > 1) {
      moveCursor(output, 0, -(renderedRows - 1));
    }
    clearScreenDown(output);
    renderedRows = 0;
  }

  function formatSpinnerBlock(frame: string, nextMessage: string): string {
    const lines = nextMessage.split("\n");
    const [firstLine = "", ...rest] = lines;
    return [
      `${colorTag("magenta", frame)}  ${firstLine}`,
      ...rest.map((line) => `${colorTag("muted", "│")}  ${line}`),
    ].join("\n");
  }

  function formatStoppedBlock(nextMessage: string, code: number): string {
    let icon: string;
    if (code === 0) {
      icon = colorTag("green", "◆");
    } else if (code === 1) {
      icon = colorTag("red", "■");
    } else {
      icon = colorTag("yellow", "▲");
    }
    const lines = nextMessage.split("\n");
    const [firstLine = "", ...rest] = lines;
    return [
      `${icon}  ${firstLine}`,
      ...rest.map((line) => `${colorTag("muted", "│")}  ${line}`),
    ].join("\n");
  }

  function renderCurrentFrame(): void {
    if (!running) {
      return;
    }
    const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0] ?? "•";
    const markdown = formatSpinnerBlock(frame, message);
    clearRenderedBlock();
    output.write(renderInlineMarkdown(markdown));
    renderedRows = countRenderedRows(markdown);
  }

  function start(nextMessage = ""): void {
    if (running) {
      message = nextMessage;
      renderCurrentFrame();
      return;
    }
    running = true;
    frameIndex = 0;
    message = nextMessage;
    if (output.isTTY) {
      output.write(HIDE_CURSOR);
    }
    renderCurrentFrame();
    if (output.isTTY) {
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
        renderCurrentFrame();
      }, SPINNER_INTERVAL_MS);
    }
  }

  function stop(nextMessage?: string, code = 0): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (!running) {
      return;
    }
    running = false;
    if (nextMessage !== undefined) {
      message = nextMessage;
    }
    clearRenderedBlock();
    if (message) {
      output.write(
        `${renderInlineMarkdown(formatStoppedBlock(message, code))}\n`
      );
    }
    if (output.isTTY) {
      output.write(SHOW_CURSOR);
    }
  }

  function updateMessage(nextMessage = ""): void {
    message = nextMessage;
    if (running) {
      renderCurrentFrame();
    }
  }

  return {
    start,
    stop,
    message: updateMessage,
  };
}
