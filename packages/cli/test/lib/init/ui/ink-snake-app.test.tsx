/**
 * Render test for the standalone Snake app mounted by `sentry games snake`.
 */

import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { mountSnakeGame } from "../../../../src/lib/init/ui/ink-app.js";

// oxlint-disable-next-line no-control-regex -- matching ANSI escape sequences in captured Ink output
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ESCAPE = "\u001B";
const SETTLE_MS = 150;

class CaptureStream extends Writable {
  chunks: string[] = [];
  columns = 100;
  rows = 30;
  isTTY = true;
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("").replace(ANSI_RE, "");
  }
}

function makeStdin(): Readable {
  const s = new Readable({
    read() {
      // Keystrokes are pushed by the tests.
    },
  });
  return Object.assign(s, {
    isTTY: true,
    setRawMode: () => s,
    resume: () => s,
    pause: () => s,
    ref: () => s,
    unref: () => s,
  });
}

function mount() {
  const out = new CaptureStream();
  const stdin = makeStdin();
  const instance = mountSnakeGame({
    exitOnCtrlC: false,
    patchConsole: false,
    stdin: stdin as unknown as import("node:tty").ReadStream,
    stdout: out,
    // Ink writes no live frames in CI unless forced interactive.
    interactive: true,
  } as Parameters<typeof mountSnakeGame>[0]);
  return { instance, out, stdin };
}

/** Settles when the app exits, or rejects after `ms` without leaving a timer behind. */
async function exitsWithin(
  instance: ReturnType<typeof mount>["instance"],
  ms: number,
): Promise<void> {
  const timer = new AbortController();
  try {
    await Promise.race([
      instance.waitUntilExit(),
      sleep(ms, undefined, { signal: timer.signal }).then(() => {
        throw new Error("Snake did not exit on esc");
      }),
    ]);
  } finally {
    timer.abort();
  }
}

describe("mountSnakeGame", () => {
  test("renders the board and the steer hint", async () => {
    const { instance, out, stdin } = mount();
    try {
      await sleep(SETTLE_MS);
      const frame = out.text();
      expect(frame).toContain("Bugs squashed");
      expect(frame).toContain("Press an arrow key to start");
    } finally {
      instance.unmount();
      stdin.destroy();
    }
  });

  test("labels the esc shortcut as quit, not back to setup", async () => {
    const { instance, out, stdin } = mount();
    try {
      await sleep(SETTLE_MS);
      const frame = out.text();
      expect(frame).toContain("quit");
      expect(frame).not.toContain("back to setup");
    } finally {
      instance.unmount();
      stdin.destroy();
    }
  });

  test("esc exits the app", async () => {
    const { instance, stdin } = mount();
    try {
      await sleep(SETTLE_MS);
      stdin.push(ESCAPE);
      await exitsWithin(instance, 2000);
    } finally {
      instance.unmount();
      stdin.destroy();
    }
  });
});
