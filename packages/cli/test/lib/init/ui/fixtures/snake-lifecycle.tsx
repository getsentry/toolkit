/**
 * Child process for ink-snake-lifecycle.test.ts. Mounts the Snake game on a
 * fake TTY that writes to the real stdout, so the parent can watch the
 * alternate-screen escape sequences. Keys arrive through the real stdin pipe.
 */

import { writeSync } from "node:fs";
import { Writable } from "node:stream";
import { mountSnakeGame } from "../../../../../src/lib/init/ui/ink-app.js";

class ForwardingTty extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    // Synchronous, like a real TTY: a signal teardown must not lose writes.
    writeSync(1, chunk);
    cb();
  }
}

const stdin = Object.assign(process.stdin, {
  isTTY: true,
  setRawMode: () => process.stdin,
});

const instance = mountSnakeGame({
  exitOnCtrlC: false,
  patchConsole: false,
  stdin: stdin as unknown as import("node:tty").ReadStream,
  stdout: new ForwardingTty(),
  interactive: true,
} as Parameters<typeof mountSnakeGame>[0]);

await instance.waitUntilExit();
process.stdout.write("EXITED\n");
process.exit(0);
