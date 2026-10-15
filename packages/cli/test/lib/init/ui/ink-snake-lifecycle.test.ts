/**
 * Terminal lifecycle of the standalone Snake game. Each case runs the game in
 * a child process and checks that the primary screen comes back however the
 * game ends, including signals that kill the process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/snake-lifecycle.tsx", import.meta.url),
);
const TSX = fileURLToPath(
  new URL("../../../../node_modules/.bin/tsx", import.meta.url),
);
const ENTER_ALT_SCREEN = "\u001B[?1049h";
const LEAVE_ALT_SCREEN = "\u001B[?1049l";
const TIMEOUT_MS = 20_000;

type Result = { output: string; code: number | null; signal: string | null };

/** Runs the game, waits until it is on the alternate screen, then ends it with `end`. */
function runGame(end: (child: ChildProcess) => void): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [FIXTURE], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    let ended = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Snake did not finish. Output: ${output}`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!ended && output.includes(ENTER_ALT_SCREEN)) {
        ended = true;
        // Let the first frame render before ending the game.
        setTimeout(() => end(child), 300);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ output, code, signal });
    });
  });
}

function expectPrimaryScreenRestored(output: string): void {
  expect(output.lastIndexOf(LEAVE_ALT_SCREEN)).toBeGreaterThan(
    output.lastIndexOf(ENTER_ALT_SCREEN),
  );
}

describe("snake terminal lifecycle", () => {
  test("enters the alternate screen on start", async () => {
    const { output } = await runGame((child) => child.kill("SIGTERM"));
    expect(output).toContain(ENTER_ALT_SCREEN);
  }, 30_000);

  test("q returns to the primary screen", async () => {
    const { output, code } = await runGame((child) => child.stdin?.write("q"));
    expectPrimaryScreenRestored(output);
    expect(output).toContain("EXITED");
    expect(code).toBe(0);
  }, 30_000);

  test("ctrl+c returns to the primary screen", async () => {
    const { output, code } = await runGame((child) =>
      child.stdin?.write("\u0003"),
    );
    expectPrimaryScreenRestored(output);
    expect(output).toContain("EXITED");
    expect(code).toBe(0);
  }, 30_000);

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s returns to the primary screen",
    async (signal) => {
      const { output } = await runGame((child) => child.kill(signal));
      expectPrimaryScreenRestored(output);
    },
    30_000,
  );
});
